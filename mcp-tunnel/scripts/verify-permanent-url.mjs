// Public end-to-end proof for the configured permanent tunnel.
//
// Starts a loopback origin, runs the real named tunnel against it, then fetches
// the permanent public URL through Cloudflare from this machine.
//
// The VPN on this machine answers DNS for tunnelled hostnames with a synthetic
// 198.18.0.0/15 address, which breaks the public data path locally. To measure
// the tunnel itself rather than the VPN, the request resolves the hostname over
// DNS-over-HTTPS and connects to the real Cloudflare edge address, keeping the
// real Host and SNI so Cloudflare routes it normally.

import http from 'node:http'
import https from 'node:https'
import { once } from 'node:events'

import { TunnelManager } from '../src/tunnel.mjs'

const HOSTNAME = process.env.DSH_TUNNEL_TEST_HOSTNAME ?? 'dsh.xinqiaopsy.top'
const URL_UNDER_TEST = `https://${HOSTNAME}`
const marker = `dsh-tunnel-e2e-${Date.now()}`

// This machine's VPN answers DNS for both the tunnel hostname and for public DNS
// providers with synthetic 198.18.0.0/15 addresses, so ordinary resolution
// returns a fake edge. Pin a known public resolver by IP to read the real
// answer, and pin a Cloudflare edge address for the fetch itself.
const DOH_SERVERS = [
  { address: '1.1.1.1', host: 'cloudflare-dns.com' },
  { address: '8.8.8.8', host: 'dns.google' },
]

/**
 * A `lookup` implementation that always answers with one pinned IPv4 address.
 * Node sets `options.all = true` by default, in which case it requires an array
 * of { address, family } objects rather than the single-address form.
 */
function pinnedLookup(address) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options
      options = {}
    } else if (typeof options === 'number') {
      options = { family: options }
    }
    if (options?.all) callback(null, [{ address, family: 4 }])
    else callback(null, address, 4)
  }
}

/** An HTTPS GET with the connection target pinned to a specific IP address. */
function getPinned(url, { address, timeoutMs = 30_000, headers = {} } = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(url)
    const request = https.get({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      timeout: timeoutMs,
      servername: parsed.hostname,
      lookup: pinnedLookup(address),
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve({ ok: true, status: response.statusCode, headers: response.headers, text }))
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', (error) => resolve({ ok: false, error: `${error.code ?? ''} ${error.message}`.trim() }))
  })
}

/** Resolve real A records by connecting to a public DoH resolver by IP. */
async function publicA(hostname) {
  for (const resolver of DOH_SERVERS) {
    const response = await getPinned(
      `https://${resolver.host}/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      { address: resolver.address, headers: { accept: 'application/dns-json' }, timeoutMs: 12_000 },
    )
    if (!response.ok) {
      process.stderr.write(`resolver ${resolver.address} failed: ${response.error}\n`)
      continue
    }
    try {
      const body = JSON.parse(response.text)
      const values = (body.Answer ?? []).filter((entry) => entry.type === 1).map((entry) => String(entry.data))
      if (values.length > 0) return { values, resolver: resolver.address, status: body.Status }
    } catch (error) {
      process.stderr.write(`resolver ${resolver.address} returned non-JSON: ${error.message}\n`)
    }
  }
  return { values: [], resolver: null, status: null }
}

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(`${marker}\npath=${request.url}\n`)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`

const report = { hostname: HOSTNAME, url: URL_UNDER_TEST, origin, steps: [] }
let exitCode = 1
const manager = new TunnelManager({ log: (line) => process.stderr.write(`[cloudflared] ${line}\n`) })

try {
  const started = await manager.startNamed({ origin })
  report.steps.push({ step: 'start', ok: true, state: started.state, url: started.publicUrl, stable: started.stable })
  if (!started.stable) throw new Error(`expected a stable address, got state=${started.state}`)

  // Ask a public resolver (by IP) where Cloudflare's edge is for this hostname.
  const resolved = await publicA(HOSTNAME)
  const edgeAddress = resolved.values.find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value) && !value.startsWith('198.18.'))
  report.steps.push({ step: 'public-dns', ok: Boolean(edgeAddress), resolver: resolved.resolver, values: resolved.values, edgeAddress })
  if (!edgeAddress) throw new Error(`no real Cloudflare edge address published for ${HOSTNAME}: ${JSON.stringify(resolved.values)}`)

  let response
  let text
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    response = await getPinned(URL_UNDER_TEST, {
      address: edgeAddress,
      headers: { 'user-agent': 'dsh-tunnel-e2e', host: HOSTNAME },
      timeoutMs: 25_000,
    })
    text = response.text ?? ''
    if (response.status === 200 && text.includes(marker)) break
    process.stderr.write(`attempt ${attempt}: status=${response.status ?? 'n/a'} error=${response.error ?? 'none'}\n`)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }

  report.steps.push({
    step: 'public-fetch',
    ok: response?.status === 200 && text?.includes(marker),
    status: response?.status ?? null,
    error: response?.error ?? null,
    cfRay: response?.headers?.['cf-ray'] ?? null,
    bodyMatchedMarker: Boolean(text?.includes(marker)),
    preview: (text ?? '').slice(0, 140),
  })

  if (response?.status !== 200) throw new Error(`public fetch returned HTTP ${response?.status ?? response?.error}`)
  if (!text.includes(marker)) throw new Error('the public response did not come from the local origin')

  // The whole point: a restart must reuse the same hostname.
  await manager.stop({ keepUrl: true })
  const restarted = await manager.startNamed({ origin })
  report.steps.push({ step: 'restart-same-url', ok: restarted.publicUrl === URL_UNDER_TEST, url: restarted.publicUrl })
  if (restarted.publicUrl !== URL_UNDER_TEST) throw new Error(`restart changed the URL to ${restarted.publicUrl}`)

  report.ok = true
  exitCode = 0
} catch (error) {
  report.ok = false
  report.error = error?.stack ?? String(error)
} finally {
  await manager.stop().catch(() => {})
  server.close()
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exit(exitCode)
