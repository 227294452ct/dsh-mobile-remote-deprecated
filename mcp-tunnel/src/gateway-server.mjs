// Self-contained mobile gateway.
//
// Replaces the DeepSeek Harness Desktop phone gateway: it owns the loopback
// HTTP server that the tunnel points at, authenticates paired phones, and
// reverse-proxies to the running harness using that harness's own auth cookie.
//
// Phone ──https://<host>──► Cloudflare ──► cloudflared ──► this server
//                                                              │ dsh-auth cookie
//                                                              ▼
//                                             http://127.0.0.1:<harness port>
//
// The harness cookie is acquired once from the harness startup token and never
// exposed to a device.

import crypto from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { statePaths } from './paths.mjs'
import { MOBILE_LAYOUT_SCRIPT } from './mobile-compat.mjs'
import { codeFromQuery, consumePairingCode, createPairingCode, ensureAdminToken, pendingPairings } from './pairing.mjs'
import { appIconPng, ICON_PATH, INSTALL_HEAD_TAGS, MANIFEST_PATH, webManifest } from './pwa.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const API_PREFIX = '/_dsh_mobile/v1'
const DEVICE_TOKEN_BYTES = 32
const MAX_JSON_BYTES = 256 * 1024

export const PAIRED_COOKIE = 'dsh_mobile_device'
export const COMPAT_PATH = `${API_PREFIX}/compat.js`

function randomToken(bytes = DEVICE_TOKEN_BYTES) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function parseCookies(header) {
  const map = new Map()
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    map.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
  }
  return map
}

/**
 * Re-attach to a harness whose auth cookie stopped working.
 *
 * The harness mints a new startup token on every launch and never writes it to
 * disk, so after a harness restart the only way to recover is to scan the live
 * process again. Called lazily on the first 401 rather than on a timer.
 */
async function recoverHarnessCookie() {
  const scriptPath = path.join(projectRoot, 'scripts', 'find-harness-token.mjs')
  if (!existsSync(scriptPath)) return null
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, '--write'], { windowsHide: true, shell: false })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.once('error', () => resolve(null))
    child.once('close', () => {
      try {
        const parsed = JSON.parse(stdout)
        resolve(parsed.verified ? parsed : null)
      } catch {
        resolve(null)
      }
    })
  })
}

export class MobileGateway {
  constructor(options = {}) {
    this.env = options.env ?? process.env
    this.log = options.log ?? (() => {})
    this.paths = statePaths(this.env)
    this.devicesPath = path.join(this.paths.root, 'mobile-devices.json')
    this.devices = this.loadDevices()
    this.server = null
    this.port = null
    this.harness = null // { origin, port, cookie }
    this.sessions = new Map()
    this.publicHost = options.publicHost ?? null
  }

  loadDevices() {
    try {
      const parsed = JSON.parse(readFileSync(this.devicesPath, 'utf8'))
      if (!Array.isArray(parsed?.devices)) return []
      return parsed.devices.filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string')
    } catch {
      return []
    }
  }

  saveDevices() {
    mkdirSync(path.dirname(this.devicesPath), { recursive: true })
    const temp = `${this.devicesPath}.tmp`
    writeFileSync(temp, `${JSON.stringify({ version: 1, devices: this.devices }, null, 2)}\n`, 'utf8')
    renameSync(temp, this.devicesPath)
  }

  get origin() {
    return this.port === null ? null : `http://127.0.0.1:${this.port}`
  }

  getStatus() {
    return {
      running: this.server !== null,
      port: this.port,
      origin: this.origin,
      harness: this.harness === null
        ? null
        : { port: this.harness.port, authenticated: this.harness.cookie !== null },
      devices: this.devices.map(({ tokenHash, ...rest }) => rest),
      pendingPairing: pendingPairings(this.env),
      publicHost: this.publicHost,
    }
  }

  /**
   * Attach the harness this gateway proxies to.
   * `cookie` is the harness's own `dsh-auth-*` cookie, never sent to devices.
   */
  async attachHarness({ origin, port, cookie, token }) {
    let resolvedCookie = cookie ?? null
    const resolvedPort = port ?? (origin ? Number(new URL(origin).port) : null)
    if (resolvedPort === null || !Number.isInteger(resolvedPort)) throw new Error('attachHarness needs a harness port')

    if (resolvedCookie === null) {
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('Need either the harness auth cookie or its startup token.')
      }
      const response = await fetch(`http://127.0.0.1:${resolvedPort}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
      const setCookie = String(response.headers.get('set-cookie') || '').split(';')[0]
      if (!setCookie.includes('=')) {
        throw new Error(`The harness rejected that token (status ${response.status}).`)
      }
      resolvedCookie = setCookie
    }

    this.harness = { port: resolvedPort, origin: `http://127.0.0.1:${resolvedPort}`, cookie: resolvedCookie }
    this.log(`Gateway attached to harness on port ${resolvedPort} (${resolvedCookie.split('=')[0]})`)
    return this.harness
  }

  /** Create a one-time pairing code for a phone (shared across processes). */
  createPairing() {
    return createPairingCode(this.env)
  }

  consumePairing(code) {
    return consumePairingCode(code, this.env)
  }

  /** Issue a durable device token. Only the hash is stored. */
  pairDevice(name, meta = {}) {
    const token = randomToken()
    const device = {
      id: crypto.randomUUID(),
      name: typeof name === 'string' && name.trim().length > 0 ? name.trim().slice(0, 64) : 'Phone',
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      userAgent: typeof meta.userAgent === 'string' ? meta.userAgent.slice(0, 200) : null,
      ip: meta.ip ?? null,
      revokedAt: null,
    }
    this.devices.push(device)
    this.saveDevices()
    return { device: { ...device, tokenHash: undefined }, token }
  }

  findDeviceByToken(token) {
    if (typeof token !== 'string' || token.length === 0) return null
    const hash = hashToken(token)
    return this.devices.find((d) => d.revokedAt === null && timingSafeEqual(d.tokenHash, hash)) ?? null
  }

  revokeDevice(id) {
    const device = this.devices.find((d) => d.id === id)
    if (!device) return false
    device.revokedAt = new Date().toISOString()
    this.saveDevices()
    return true
  }

  async start() {
    if (this.server !== null) return this.getStatus()
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        this.log(`Gateway request failed: ${error?.stack ?? error}`)
        if (!response.headersSent) respondJson(response, 500, { error: 'gateway error' })
        else response.destroy()
      })
    })
    this.server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head))
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.port = this.server.address().port
    this.log(`Mobile gateway listening on ${this.origin}`)
    return this.getStatus()
  }

  async stop() {
    if (this.server === null) return this.getStatus()
    const server = this.server
    this.server = null
    await new Promise((resolve) => server.close(resolve))
    this.port = null
    return this.getStatus()
  }

  isSecureRequest(request) {
    // Cloudflare terminates TLS and sets this header; note it is only trusted
    // because the gateway is reachable solely through the tunnel.
    return request.headers['x-forwarded-proto'] === 'https'
  }

  deviceCookieHeader(token, secure) {
    const attributes = [`${PAIRED_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${180 * 24 * 3600}`]
    if (secure) attributes.push('Secure')
    return attributes.join('; ')
  }

  async handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname

    if (pathname === COMPAT_PATH) {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
      response.end(MOBILE_LAYOUT_SCRIPT)
      return
    }

    // Install metadata must be reachable before pairing, otherwise the browser
    // cannot offer "Add to Home Screen" on the first visit.
    if (pathname === MANIFEST_PATH) {
      response.writeHead(200, {
        'content-type': 'application/manifest+json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(`${JSON.stringify(webManifest(), null, 2)}\n`)
      return
    }
    if (pathname === ICON_PATH) {
      const icon = appIconPng(192)
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(icon.length),
        'cache-control': 'public, max-age=86400',
      })
      response.end(icon)
      return
    }

    if (pathname === `${API_PREFIX}/pair` && request.method === 'POST') {
      await this.handlePair(request, response)
      return
    }

    // Local control plane. Reachable only on loopback, and additionally guarded
    // by a shared token so an unrelated local process cannot revoke a phone.
    if (pathname === `${API_PREFIX}/revoke` && request.method === 'POST') {
      this.handleRevoke(request, response)
      return
    }

    if (pathname === `${API_PREFIX}/status`) {
      respondJson(response, 200, { paired: this.authenticate(request) !== null, gateway: this.getStatus() })
      return
    }

    const device = this.authenticate(request)
    if (device === null) {
      if (pathname === '/' || pathname === '/index.html') {
        this.servePairingPage(response, url)
        return
      }
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('This device is not paired. Open the root URL to pair.')
      return
    }

    device.lastSeenAt = new Date().toISOString()
    await this.proxyToHarness(request, response, device)
  }

  authenticate(request) {
    const token = parseCookies(request.headers.cookie).get(PAIRED_COOKIE)
    if (!token) return null
    return this.findDeviceByToken(token)
  }

  async handlePair(request, response) {
    const body = await readJsonBody(request)
    if (body === null) {
      respondJson(response, 400, { error: 'invalid JSON body' })
      return
    }
    const result = this.consumePairing(body.code)
    if (!result.ok) {
      respondJson(response, 403, { error: result.reason })
      return
    }
    const { token, device } = this.pairDevice(body.name, { userAgent: request.headers['user-agent'], ip: request.socket.remoteAddress })
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': this.deviceCookieHeader(token, this.isSecureRequest(request)),
      'cache-control': 'no-store',
    })
    response.end(`${JSON.stringify({ paired: true, device })}\n`)
  }

  /** Revoke a paired device. Loopback-only, plus the shared admin token. */
  handleRevoke(request, response) {
    const expected = ensureAdminToken(this.env)
    const presented = String(request.headers['x-dsh-admin-token'] ?? '')
    if (presented.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
      respondJson(response, 403, { error: 'invalid admin token' })
      return
    }
    readJsonBody(request).then((body) => {
      const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : null
      if (deviceId === null) {
        respondJson(response, 400, { error: 'deviceId is required' })
        return
      }
      const revoked = this.revokeDevice(deviceId)
      respondJson(response, revoked ? 200 : 404, { revoked, deviceId, devices: this.getStatus().devices })
    }).catch(() => respondJson(response, 400, { error: 'invalid body' }))
  }

  servePairingPage(response, requestUrl) {
    const pending = pendingPairings(this.env)
    // A QR code can carry the code, so the phone never types anything.
    const fromQuery = requestUrl ? codeFromQuery(requestUrl.toString()) : null
    const prefilled = fromQuery ?? (pending.length === 1 ? pending[0].code : null)
    const hint = pending.length > 0
      ? ''
      : '<p class="warn">No pairing code is pending. Ask the computer to run <code>gateway_pair</code> first.</p>'
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="${MANIFEST_PATH}">
<link rel="apple-touch-icon" href="${ICON_PATH}">
<title>配对 DeepSeek Harness</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100dvh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
       background:#f8fafc;color:#0f172a;padding:24px;box-sizing:border-box}
  @media (prefers-color-scheme:dark){body{background:#0b1220;color:#e2e8f0}}
  form{width:100%;max-width:380px;display:grid;gap:14px;padding:26px;border-radius:20px;background:#fff;
       box-shadow:0 16px 40px rgba(15,23,42,.10)}
  @media (prefers-color-scheme:dark){form{background:#111a2b;box-shadow:none;border:1px solid #1e2a40}}
  h1{margin:0;font-size:20px}
  p{margin:0;font-size:14px;opacity:.75}
  input,button{font:inherit;border-radius:12px;box-sizing:border-box;width:100%}
  input{padding:14px;border:1px solid #cbd5e1;background:transparent;color:inherit;letter-spacing:.28em;text-align:center;font-size:22px}
  button{padding:14px;border:0;background:#2563eb;color:#fff;font-weight:600}
  button:disabled{opacity:.6}
  .warn{color:#b45309;font-size:13px}
  .err{color:#dc2626;font-size:14px;min-height:20px}
  code{background:rgba(127,127,127,.16);padding:1px 5px;border-radius:5px}
</style></head>
<body>
<form id="f">
  <h1>配对 DeepSeek Harness</h1>
  <p>在电脑上让助手执行 <code>gateway_pair</code>，用手机扫二维码即可。<br>也可以手动填下面的 6 位配对码。</p>
  ${hint}
  <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" value="${prefilled ?? ''}" required>
  <input id="name" maxlength="40" placeholder="设备名称（可选）" style="letter-spacing:normal;font-size:16px;text-align:left">
  <button id="b" type="submit">配对</button>
  <div class="err" id="e"></div>
</form>
<script>
  const f = document.getElementById('f'), b = document.getElementById('b'), e = document.getElementById('e');
  const codeEl = document.getElementById('code');
  const submit = async () => {
    b.disabled = true; e.textContent = '';
    try {
      const response = await fetch('${API_PREFIX}/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: codeEl.value, name: document.getElementById('name').value })
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) { e.textContent = value.error || '配对失败'; b.disabled = false; return; }
      location.replace('/');
    } catch (error) {
      e.textContent = '网络错误：' + error.message; b.disabled = false;
    }
  };
  f.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  if (codeEl.value) { submit(); } else { codeEl.focus(); }
</script>
</body></html>`
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(html)
  }

  /** Forward an authenticated request to the harness, injecting its cookie. */
  async proxyToHarness(request, response, device) {
    if (this.harness === null) {
      respondJson(response, 503, { error: 'The gateway has no harness attached yet.' })
      return
    }
    const target = new URL(request.url ?? '/', this.harness.origin)
    const headers = { ...request.headers }
    delete headers.host
    delete headers['content-length']
    delete headers.connection
    delete headers['accept-encoding']
    headers.cookie = this.harness.cookie
    headers.origin = this.harness.origin
    if (headers.referer) headers.referer = `${this.harness.origin}/`

    const method = request.method ?? 'GET'
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readRawBody(request)

    let upstream = await this.forward(target, method, headers, body)

    // Self-healing: the harness rotates its startup token on every launch, which
    // invalidates the cookie. Recover once, then retry the original request.
    if (upstream !== null && (upstream.status === 401 || upstream.status === 403)) {
      this.log(`Harness rejected the cookie (${upstream.status}); attempting recovery`)
      const recovered = await this.recover()
      if (recovered) {
        headers.cookie = this.harness.cookie
        upstream = await this.forward(target, method, headers, body)
      }
    }

    if (upstream === null) {
      respondJson(response, 502, { error: 'Harness unreachable.' })
      return
    }

    const contentType = String(upstream.headers.get('content-type') || '')
    const isHtml = contentType.toLowerCase().includes('text/html')
    const outHeaders = {}
    for (const [name, value] of upstream.headers) {
      const lower = name.toLowerCase()
      if (['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'set-cookie'].includes(lower)) continue
      outHeaders[name] = value
    }

    if (isHtml) {
      // Inject the compatibility shim and the install metadata so older mobile
      // WebViews render correctly and the page can be added to the home screen.
      const html = await upstream.text()
      const tag = `<script src="${COMPAT_PATH}"></script>${INSTALL_HEAD_TAGS}`
      const patched = /<head(?:\s[^>]*)?>/i.test(html)
        ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${tag}`)
        : `${tag}${html}`
      const buffer = Buffer.from(patched, 'utf8')
      outHeaders['content-length'] = String(buffer.length)
      outHeaders['content-type'] = contentType
      response.writeHead(upstream.status, outHeaders)
      response.end(buffer)
      return
    }

    response.writeHead(upstream.status, outHeaders)
    if (upstream.body) {
      const { Readable } = await import('node:stream')
      Readable.fromWeb(upstream.body).pipe(response)
    } else {
      response.end()
    }
  }

  /** One HTTP attempt against the harness; null when the transport failed. */
  async forward(target, method, headers, body) {
    try {
      return await fetch(target, { method, headers, body, redirect: 'manual' })
    } catch (error) {
      this.log(`Harness fetch failed: ${error.message}`)
      return null
    }
  }

  /** Re-scan the running harness for a fresh token and adopt its cookie. */
  async recover() {
    if (this.recovering) return this.recovering
    this.recovering = (async () => {
      try {
        const found = await recoverHarnessCookie()
        if (found === null) {
          this.log('Recovery failed: no valid harness token found.')
          return false
        }
        await this.attachHarness({ port: found.port, token: found.token })
        this.log(`Recovered harness auth on port ${found.port}`)
        return true
      } catch (error) {
        this.log(`Recovery error: ${error.message}`)
        return false
      } finally {
        this.recovering = null
      }
    })()
    return this.recovering
  }

  /** WebSocket upgrade for live updates (harness uses WS for session streams). */
  handleUpgrade(request, socket, head) {
    const device = this.authenticate(request)
    if (device === null || this.harness === null) {
      socket.destroy()
      return
    }
    const target = new URL(request.url ?? '/', this.harness.origin)
    const headers = { ...request.headers, cookie: this.harness.cookie, host: target.host, origin: this.harness.origin }
    delete headers['sec-websocket-extensions']
    const key = headers['sec-websocket-key']
    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket' },
    })
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${upstreamResponse.headers['sec-websocket-accept']}\r\n\r\n`,
      )
      if (upstreamHead?.length) socket.unshift(upstreamHead)
      upstreamSocket.pipe(socket).pipe(upstreamSocket)
      upstreamSocket.on('error', () => socket.destroy())
      socket.on('error', () => upstreamSocket.destroy())
    })
    upstream.on('response', (upstreamResponse) => {
      socket.write(`HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n\r\n`)
      socket.destroy()
    })
    upstream.on('error', () => socket.destroy())
    if (head?.length) upstream.write(head)
    upstream.end()
    void key
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a), 'hex')
  const right = Buffer.from(String(b), 'hex')
  if (left.length !== right.length || left.length === 0) return false
  return crypto.timingSafeEqual(left, right)
}

function respondJson(response, status, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

async function readRawBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 8 * 1024 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks)
}

async function readJsonBody(request) {
  try {
    const raw = await readRawBody(request)
    if (raw === undefined) return {}
    if (raw.length > MAX_JSON_BYTES) return null
    return JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
}

export { API_PREFIX }
