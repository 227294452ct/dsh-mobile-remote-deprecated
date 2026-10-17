'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { mkdtempSync, writeFileSync } = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { RemoteGateway, API_PREFIX, listDriveRoots, extractQuickTunnelUrl, tunnelRetryDelayMs, resolveNamedTunnel, renderNamedTunnelConfig, namedTunnelUrl, NAMED_TUNNEL_PROVIDER } = require('./remote-gateway.cjs')
const { EventEmitter } = require('node:events')
const { WebSocket } = require('ws')

assert.equal(extractQuickTunnelUrl('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'), null)
assert.equal(extractQuickTunnelUrl('request https://api.trycloudflare.com/tunnel then https://cloud-birch-example.trycloudflare.com'), 'https://cloud-birch-example.trycloudflare.com')
assert.equal(tunnelRetryDelayMs(1), 1_500)
assert.equal(tunnelRetryDelayMs(2), 3_000)
assert.equal(tunnelRetryDelayMs(99), 30_000)

// --- permanent named tunnel -------------------------------------------------
// A named tunnel is what keeps one address across restarts; a quick tunnel hands
// out a new hostname every start, which is what forces the phone to re-pair.

const TUNNEL_UUID = '08d19f8f-19ec-401b-aecd-225ca7ae2ac0'

{
  // No cloudflared state at all: report "not configured" so the caller can fall
  // back to a quick tunnel rather than failing the whole start.
  const emptyHome = mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-empty-'))
  assert.equal(resolveNamedTunnel({ cloudflaredHome: emptyHome, hostname: 'dsh.example.com' }), null)
}

{
  // Credentials present but no hostname: there is no stable address to publish.
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-nohost-'))
  writeFileSync(path.join(home, `${TUNNEL_UUID}.json`), '{}')
  assert.equal(resolveNamedTunnel({ cloudflaredHome: home }), null)
}

{
  // The realistic case: one credentials file plus a known hostname.
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-ok-'))
  const credentialsFile = path.join(home, `${TUNNEL_UUID}.json`)
  writeFileSync(credentialsFile, '{}')
  const resolved = resolveNamedTunnel({ cloudflaredHome: home, hostname: 'DSH.Example.COM' })
  assert.ok(resolved !== null, 'a configured named tunnel must resolve')
  assert.equal(resolved.tunnelId, TUNNEL_UUID)
  assert.equal(resolved.credentialsFile, credentialsFile)
  assert.equal(resolved.hostname, 'dsh.example.com', 'hostnames compare case-insensitively')
  assert.equal(resolved.provider, NAMED_TUNNEL_PROVIDER)
  assert.equal(namedTunnelUrl(resolved.hostname), 'https://dsh.example.com')
}

{
  // A non-UUID file name must not be mistaken for a tunnel identity.
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-bad-'))
  writeFileSync(path.join(home, 'cert.pem'), 'not a tunnel')
  assert.equal(resolveNamedTunnel({ cloudflaredHome: home, hostname: 'dsh.example.com' }), null)
}

{
  // The rendered config must pin the hostname at the live gateway port, and must
  // keep a catch-all so unknown hostnames do not reach the phone gateway.
  const config = renderNamedTunnelConfig({
    tunnelId: TUNNEL_UUID,
    credentialsFile: 'C:\\creds.json',
    hostname: 'dsh.example.com',
    origin: 'http://127.0.0.1:54321'
  })
  assert.match(config, new RegExp(`tunnel: ${TUNNEL_UUID}`))
  assert.match(config, /credentials-file: C:\\creds\.json/)
  assert.match(config, /- hostname: dsh\.example\.com/)
  assert.match(config, /service: http:\/\/127\.0\.0\.1:54321/)
  assert.match(config, /- service: http_status:404/)
}

{
  // Status must advertise the address as permanent only for a named tunnel, so
  // the UI never promises stability a quick tunnel cannot keep.
  const status = new RemoteGateway({
    userDataPath: mkdtempSync(path.join(os.tmpdir(), 'dsh-status-')),
    skipTunnel: true,
    log: () => {}
  }).getStatus()
  assert.equal(status.tunnel.permanent, false)
  assert.equal(status.tunnel.hostname, null)
}

class FakeDesktopProvider extends EventEmitter {
  constructor() {
    super()
    this.inputs = []
    this.releaseCount = 0
    this.frames = 0
    this.prepareCount = 0
  }
  isAvailable() { return true }
  listDisplays() {
    return [
      { id: 'primary', name: '主屏', primary: true, width: 1920, height: 1080, scaleFactor: 1 },
      { id: 'secondary', name: '副屏', primary: false, width: 1280, height: 1024, scaleFactor: 1.25 }
    ]
  }
  async captureFrame(displayId) { this.frames += 1; return Buffer.from([0xFF, 0xD8, displayId.length, 0xFF, 0xD9]) }
  dispatchInput(displayId, message) { this.inputs.push({ displayId, ...message }) }
  prepare() { this.prepareCount += 1 }
  ping() {}
  releaseAll() { this.releaseCount += 1 }
}

function openDesktopSocket(url, headers) {
  const messages = []
  const waiters = []
  const socket = new WebSocket(url, { headers })
  socket.on('message', (data, isBinary) => {
    const value = isBinary ? Buffer.from(data) : JSON.parse(data.toString('utf8'))
    const item = { value, isBinary }
    messages.push(item)
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(item)) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      clearTimeout(waiter.timer)
      waiter.resolve(item)
    }
  })
  const next = (predicate, timeoutMs = 4000) => {
    const existing = messages.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error('Desktop WebSocket message timed out')), timeoutMs) }
      waiters.push(waiter)
    })
  }
  return { socket, next, messages }
}

function rejectedDesktopSocket(url, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode) })
    socket.once('open', () => { socket.close(); reject(new Error('Desktop WebSocket unexpectedly opened')) })
    socket.once('error', () => {})
  })
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

function websocketHandshake(port, cookie) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    let received = ''
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write([
        'GET /socket HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${key}`,
        'Origin: https://desktop.test.ts.net:8443',
        'X-DSH-Test-Identity: owner@example.com',
        `Cookie: ${cookie}`,
        '', ''
      ].join('\r\n'))
    })
    socket.setTimeout(5_000)
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1')
      if (received.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(received)
      }
    })
    socket.on('timeout', () => reject(new Error('WebSocket handshake timed out')))
    socket.on('error', reject)
  })
}

async function main() {
  const roots = await listDriveRoots({
    platform: 'win32',
    timeoutMs: 25,
    probe: root => root === 'F:\\' ? Promise.resolve() : root === 'Z:\\' ? new Promise(() => {}) : Promise.reject(new Error('missing'))
  })
  assert.deepEqual(roots, ['F:\\'])
  let lastHtmlRequestHeaders = null
  const upstream = http.createServer((request, response) => {
    if (String(request.headers.accept || '').includes('text/html')) {
      lastHtmlRequestHeaders = request.headers
      if (request.headers['if-none-match'] || request.headers['if-modified-since']) {
        response.writeHead(304)
        response.end()
        return
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.setHeader('ETag', '"stale-document"')
      response.setHeader('Last-Modified', 'Wed, 01 Jan 2025 00:00:00 GMT')
      response.end('<!doctype html><html><head><script>window.upstreamBooted=true</script></head><body>Harness</body></html>')
      return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ host: request.headers.host, origin: request.headers.origin, cookie: request.headers.cookie || null }))
  })
  let upgradedHeaders = null
  upstream.on('upgrade', (request, socket) => {
    upgradedHeaders = request.headers
    const accept = crypto.createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  })
  const upstreamPort = await listen(upstream)
  const temp = mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-test-'))
  const desktopProvider = new FakeDesktopProvider()
  const gateway = new RemoteGateway({
    userDataPath: temp,
    allowTestIdentity: true,
    skipTailscaleServe: true,
    testRemoteUrl: 'https://desktop.test.ts.net:8443',
    desktopProvider
  })
  await gateway.start(`http://127.0.0.1:${upstreamPort}`)
  const base = `http://127.0.0.1:${gateway.gatewayPort}`
  const identityHeaders = { 'Content-Type': 'application/json', 'X-DSH-Test-Identity': 'owner@example.com' }
  const post = (route, body, headers = identityHeaders) => fetch(`${base}${API_PREFIX}${route}`, {
    method: 'POST', headers, body: JSON.stringify(body)
  })

  try {
    const unauthorized = await fetch(base, { headers: { 'X-DSH-Test-Identity': 'owner@example.com' } })
    assert.equal(unauthorized.status, 401)

    const pairing = await gateway.createPairing()
    const pairingUrl = new URL(pairing.payload)
    const secret = new URLSearchParams(pairingUrl.hash.slice(1)).get('secret')
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const deviceId = crypto.randomUUID()
    const claim = await post('/pair/claim', { pairingId: pairing.pairingId, secret, deviceId, deviceName: 'Test Android', publicKey: publicKeyDer })
    assert.equal(claim.status, 202)
    assert.equal((await claim.json()).verificationCode, pairing.verificationCode)
    gateway.approvePairing(pairing.pairingId)

    const challengeResponse = await post('/session/challenge', { deviceId })
    assert.equal(challengeResponse.status, 200)
    const challenge = await challengeResponse.json()
    const signed = Buffer.from(`dsh-remote-v1|${deviceId}|${challenge.challengeId}|${challenge.nonce}`, 'utf8')
    const signature = crypto.sign('sha256', signed, privateKey).toString('base64')
    const open = await post('/session/open', { deviceId, challengeId: challenge.challengeId, signature })
    assert.equal(open.status, 200)
    const setCookie = open.headers.get('set-cookie')
    assert.match(setCookie, /__Host-dsh_remote=/)
    const cookie = setCookie.split(';', 1)[0]

    const browserHeaders = {
      Cookie: cookie,
      Origin: 'https://desktop.test.ts.net:8443',
      'X-DSH-Test-Identity': 'owner@example.com'
    }
    const unauthorizedCapabilities = await fetch(`${base}${API_PREFIX}/desktop/capabilities`, { headers: { 'X-DSH-Test-Identity': 'owner@example.com' } })
    assert.equal(unauthorizedCapabilities.status, 401)
    const wrongOriginCapabilities = await fetch(`${base}${API_PREFIX}/desktop/capabilities`, { headers: { ...browserHeaders, Origin: 'https://attacker.example' } })
    assert.equal(wrongOriginCapabilities.status, 403)
    const capabilities = await fetch(`${base}${API_PREFIX}/desktop/capabilities`, { headers: browserHeaders })
    assert.equal(capabilities.status, 200)
    const capabilityValue = await capabilities.json()
    assert.deepEqual(capabilityValue.displays.map(display => display.id), ['primary', 'secondary'])
    assert.equal(capabilityValue.maxFps, 10)
    const drives = await fetch(`${base}${API_PREFIX}/drives`, { headers: browserHeaders })
    assert.equal(drives.status, 200)
    assert.ok(Array.isArray((await drives.json()).drives))
    const compatPage = await fetch(base, { headers: {
      ...browserHeaders,
      Accept: 'text/html',
      'If-None-Match': '"stale-document"',
      'If-Modified-Since': 'Wed, 01 Jan 2025 00:00:00 GMT'
    } })
    assert.equal(compatPage.status, 200)
    assert.equal(lastHtmlRequestHeaders['if-none-match'], undefined)
    assert.equal(lastHtmlRequestHeaders['if-modified-since'], undefined)
    assert.equal(compatPage.headers.get('cache-control'), 'no-store, no-cache, must-revalidate')
    assert.equal(compatPage.headers.get('pragma'), 'no-cache')
    assert.equal(compatPage.headers.get('expires'), '0')
    assert.equal(compatPage.headers.get('etag'), null)
    assert.equal(compatPage.headers.get('last-modified'), null)
    const compatHtml = await compatPage.text()
    assert.ok(compatHtml.indexOf('/_dsh_remote/compat.js') < compatHtml.indexOf('window.upstreamBooted'))
    const compatScript = await fetch(`${base}/_dsh_remote/compat.js`, { headers: browserHeaders })
    assert.equal(compatScript.status, 200)
    const compatSource = await compatScript.text()
    assert.match(compatSource, /Object\.hasOwn/)
    assert.match(compatSource, /crypto\.randomUUID/)
    assert.match(compatSource, /structuredClone/)
    assert.match(compatSource, /defineAt/)
    assert.match(compatSource, /选择模型/)
    assert.match(compatSource, /data-dsh-remote-mobile-layout/)
    assert.match(compatSource, /data-question-key/)
    assert.match(compatSource, /grid-template-columns: repeat\(2/)
    assert.match(compatSource, /orientation: portrait/)
    assert.match(compatSource, /data-dsh-remote-session-log/)
    assert.match(compatSource, /visualViewport/)
    assert.match(compatSource, /box-sizing:border-box/)
    assert.match(compatSource, /image\.naturalWidth/)
    assert.match(compatSource, /height:100%!important/)
    assert.match(compatSource, /desktopViewScale = Math\.max\(0\.35/)
    assert.match(compatSource, /desktopCloseRequested/)
    assert.match(compatSource, /history\.pushState\(\{ dshRemoteDesktop: true \}/)
    assert.match(compatSource, /DOMMatrixReadOnly/)
    assert.match(compatSource, /data-dsh-remote-composer-heading/)
    assert.match(compatSource, /data-dsh-remote-mobile-topbar/)
    assert.match(compatSource, /data-dsh-remote-home-composer/)
    assert.match(compatSource, /\[role="menu"\]/)
    assert.doesNotMatch(compatSource, /tapTimer/)
    assert.doesNotThrow(() => new vm.Script(compatSource))

    const proxied = await fetch(base, { headers: {
      Cookie: cookie,
      Origin: 'https://desktop.test.ts.net:8443',
      'X-DSH-Test-Identity': 'owner@example.com'
    } })
    assert.equal(proxied.status, 200)
    const echoed = await proxied.json()
    assert.equal(echoed.host, `127.0.0.1:${upstreamPort}`)
    assert.equal(echoed.origin, `http://127.0.0.1:${upstreamPort}`)
    assert.equal(echoed.cookie, null)

    const upgraded = await websocketHandshake(gateway.gatewayPort, cookie)
    assert.match(upgraded, /^HTTP\/1\.1 101 /)
    assert.equal(upgradedHeaders.host, `127.0.0.1:${upstreamPort}`)
    assert.equal(upgradedHeaders.origin, `http://127.0.0.1:${upstreamPort}`)
    assert.equal(upgradedHeaders.cookie, undefined)

    const desktopUrl = `ws://127.0.0.1:${gateway.gatewayPort}${API_PREFIX}/desktop/socket`
    const wsHeaders = { Cookie: cookie, Origin: 'https://desktop.test.ts.net:8443', 'X-DSH-Test-Identity': 'owner@example.com' }
    assert.equal(await rejectedDesktopSocket(desktopUrl, { ...wsHeaders, Origin: 'https://attacker.example' }), 401)
    const first = openDesktopSocket(desktopUrl, wsHeaders)
    await new Promise((resolve, reject) => { first.socket.once('open', resolve); first.socket.once('error', reject) })
    const firstHello = (await first.next(item => !item.isBinary && item.value.type === 'hello')).value
    assert.equal(firstHello.selectedDisplayId, 'primary')
    assert.equal(firstHello.maxFps, 10)
    assert.equal(desktopProvider.prepareCount, 1)
    assert.equal((await first.next(item => !item.isBinary && item.value.type === 'control-state' && item.value.canControl)).value.canControl, true)
    first.socket.send(JSON.stringify({ type: 'heartbeat' }))
    assert.equal((await first.next(item => !item.isBinary && item.value.type === 'control-state')).value.canControl, true)
    const frame = await first.next(item => item.isBinary)
    assert.equal(frame.value[0], 0xFF)

    const second = openDesktopSocket(desktopUrl, wsHeaders)
    await new Promise((resolve, reject) => { second.socket.once('open', resolve); second.socket.once('error', reject) })
    assert.equal((await second.next(item => !item.isBinary && item.value.type === 'control-state')).value.canControl, false)
    second.socket.send(JSON.stringify({ type: 'pointer', action: 'click', button: 'left', x: 0.5, y: 0.5 }))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(desktopProvider.inputs.length, 0)
    first.socket.send(JSON.stringify({ type: 'pointer', action: 'click', button: 'left', x: 0.5, y: 0.5 }))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(desktopProvider.inputs.length, 1)
    assert.equal(desktopProvider.inputs[0].displayId, 'primary')
    first.socket.send(JSON.stringify({ type: 'select-display', displayId: 'secondary' }))
    await first.next(item => !item.isBinary && item.value.type === 'display-list' && item.value.selectedDisplayId === 'secondary')
    first.socket.close()
    assert.equal((await second.next(item => !item.isBinary && item.value.type === 'control-state' && item.value.canControl)).value.canControl, true)
    gateway.setDesktopLocked(true)
    assert.equal((await second.next(item => !item.isBinary && item.value.type === 'stream-state' && item.value.state === 'paused')).value.reason, 'screen-locked')
    assert.ok(desktopProvider.releaseCount >= 1)
    gateway.setDesktopLocked(false)
    second.socket.close()
    await new Promise(resolve => second.socket.once('close', resolve))
    const inputFailure = openDesktopSocket(desktopUrl, wsHeaders)
    await new Promise((resolve, reject) => { inputFailure.socket.once('open', resolve); inputFailure.socket.once('error', reject) })
    await inputFailure.next(item => !item.isBinary && item.value.type === 'control-state' && item.value.canControl)
    desktopProvider.emit('input-error', new Error('simulated input rejection'))
    assert.equal((await inputFailure.next(item => !item.isBinary && item.value.type === 'error' && item.value.code === 'input-failed')).value.code, 'input-failed')
    assert.equal((await inputFailure.next(item => !item.isBinary && item.value.type === 'control-state' && item.value.active === false)).value.active, false)
    inputFailure.socket.close()
    await new Promise(resolve => inputFailure.socket.once('close', resolve))
    const localInput = openDesktopSocket(desktopUrl, wsHeaders)
    await new Promise((resolve, reject) => { localInput.socket.once('open', resolve); localInput.socket.once('error', reject) })
    await localInput.next(item => !item.isBinary && item.value.type === 'control-state' && item.value.canControl)
    const localInputClosed = new Promise(resolve => localInput.socket.once('close', code => resolve(code)))
    desktopProvider.emit('local-input', { kind: 'mouse' })
    desktopProvider.emit('local-input', { kind: 'mouse' })
    assert.equal((await localInput.next(item => !item.isBinary && item.value.type === 'session-ended')).value.reason, 'local-input')
    assert.equal(await localInputClosed, 4002)
    assert.equal(gateway.getStatus().desktop.viewerCount, 0)
    const invalid = openDesktopSocket(desktopUrl, wsHeaders)
    await new Promise((resolve, reject) => { invalid.socket.once('open', resolve); invalid.socket.once('error', reject) })
    await invalid.next(item => !item.isBinary && item.value.type === 'control-state' && item.value.canControl)
    const invalidClosed = new Promise(resolve => invalid.socket.once('close', code => resolve(code)))
    invalid.socket.send(JSON.stringify({ type: 'pointer', action: 'click', button: 'left', x: 2, y: 0.5 }))
    assert.equal(await invalidClosed, 1008)
    const recovery = openDesktopSocket(desktopUrl, wsHeaders)
    await new Promise((resolve, reject) => { recovery.socket.once('open', resolve); recovery.socket.once('error', reject) })
    await recovery.next(item => !item.isBinary && item.value.type === 'control-state' && item.value.canControl)
    desktopProvider.emit('input-error', new Error('simulated helper crash'))
    await recovery.next(item => !item.isBinary && item.value.type === 'control-state' && item.value.active === false)
    assert.equal(gateway.getStatus().desktopControl.active, false)
    recovery.socket.close()
    await new Promise(resolve => recovery.socket.once('close', resolve))
    const heartbeat = openDesktopSocket(desktopUrl, wsHeaders)
    await new Promise((resolve, reject) => { heartbeat.socket.once('open', resolve); heartbeat.socket.once('error', reject) })
    await heartbeat.next(item => !item.isBinary && item.value.type === 'hello')
    const heartbeatClosed = new Promise(resolve => heartbeat.socket.once('close', code => resolve(code)))
    for (const client of gateway.desktopClients) client.lastHeartbeat = 0
    await gateway.captureDesktopTick()
    assert.equal(await heartbeatClosed, 1001)

    gateway.revokeDevice(deviceId)
    const revoked = await fetch(base, { headers: { Cookie: cookie, Origin: 'https://desktop.test.ts.net:8443', 'X-DSH-Test-Identity': 'owner@example.com' } })
    assert.equal(revoked.status, 401)

    // --- harness authentication ---------------------------------------------
    // DSH 0.1.5+ answers an unauthenticated loopback request with 401. The
    // gateway must exchange the startup token for its own cookie and present it
    // upstream, or every paired phone sees the "authentication required" page
    // instead of the interface.
    {
      const fakeHarness = http.createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname === '/' && url.searchParams.get('token') === 'good-token') {
          response.writeHead(303, { 'set-cookie': 'dsh-auth-test=abc123; Path=/; HttpOnly' })
          response.end()
          return
        }
        const cookie = String(request.headers.cookie ?? '')
        if (!cookie.includes('dsh-auth-test=')) {
          response.writeHead(401, { 'content-type': 'text/plain' })
          response.end('dsh web authentication required; reopen the URL printed by dsh web.')
          return
        }
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<title>DeepSeek Harness</title>')
      })
      await new Promise((resolve) => fakeHarness.listen(0, '127.0.0.1', resolve))

      const authGateway = new RemoteGateway({
        userDataPath: mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-')),
        skipTunnel: true,
        log: () => {}
      })
      authGateway.harnessUrl = `http://127.0.0.1:${fakeHarness.address().port}`

      // No token: no cookie, and no exception.
      assert.equal(await authGateway.authenticateHarness(''), false)
      assert.equal(authGateway.harnessCookie, null)

      // A rejected token must not be stored as if it worked.
      assert.equal(await authGateway.authenticateHarness('wrong-token'), false)
      assert.equal(authGateway.harnessCookie, null)

      // A good token is exchanged and kept.
      assert.equal(await authGateway.authenticateHarness('good-token'), true)
      assert.equal(authGateway.harnessCookie, 'dsh-auth-test=abc123')

      // The harness cookie must reach the harness, and the paired device's own
      // cookie must not leak upstream.
      const proxied = { headers: { cookie: 'dsh-device-session=should-not-leak' } }
      authGateway.prepareProxyRequest(proxied)
      assert.equal(proxied.headers.cookie, 'dsh-auth-test=abc123')
      assert.equal(proxied.headers.host, `127.0.0.1:${fakeHarness.address().port}`)

      await new Promise((resolve) => fakeHarness.close(resolve))
    }

    // --- self-healing after a harness restart -------------------------------
    // A restart rotates the token, so the cached cookie starts failing. The
    // gateway must recover on its own rather than leaving every phone on the
    // auth-required page until the companion is restarted.
    {
      let providerCalls = 0
      let rejectToken = false
      const fakeHarness = http.createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const token = url.searchParams.get('token')
        if (url.pathname === '/' && token === 'fresh-token' && !rejectToken) {
          response.writeHead(303, { 'set-cookie': 'dsh-auth-fresh=ok; Path=/' })
          response.end()
          return
        }
        response.writeHead(401, { 'content-type': 'text/plain' })
        response.end('dsh web authentication required')
      })
      await new Promise((resolve) => fakeHarness.listen(0, '127.0.0.1', resolve))

      const healGateway = new RemoteGateway({
        userDataPath: mkdtempSync(path.join(os.tmpdir(), 'dsh-heal-')),
        skipTunnel: true,
        log: () => {},
        harnessTokenProvider: async () => {
          providerCalls += 1
          return 'fresh-token'
        }
      })
      healGateway.harnessUrl = `http://127.0.0.1:${fakeHarness.address().port}`

      // A dead cookie is dropped and replaced using a freshly supplied token.
      healGateway.harnessCookie = 'dsh-auth-stale=dead'
      healGateway.harnessToken = 'old-token'
      assert.equal(await healGateway.refreshHarnessAuth(), true)
      assert.equal(healGateway.harnessCookie, 'dsh-auth-fresh=ok')
      assert.equal(providerCalls, 1)

      // Concurrent 401s must not each start a refresh.
      healGateway.harnessCookie = null
      providerCalls = 0
      await Promise.all([healGateway.refreshHarnessAuth(), healGateway.refreshHarnessAuth(), healGateway.refreshHarnessAuth()])
      assert.ok(providerCalls <= 1, `provider called ${providerCalls} times for concurrent refreshes`)

      // A provider failure must not throw; the next request can try again.
      rejectToken = true
      healGateway.harnessCookie = null
      const failed = await (async () => {
        try {
          return await healGateway.refreshHarnessAuth()
        } catch {
          return 'threw'
        }
      })()
      assert.notEqual(failed, 'threw', 'a failed refresh must not throw')
      assert.equal(healGateway.harnessCookie, null)

      await new Promise((resolve) => fakeHarness.close(resolve))
    }

    console.log('remote-gateway-auth-proxy-desktop-test-ok')
  } finally {
    await gateway.stop(false)
    await new Promise((resolve) => upstream.close(resolve))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
