// End-to-end tunnel test.
//
// Starts a loopback HTTP server, exposes it through a real cloudflared tunnel,
// and fetches it back over the public internet. This is the only test that
// proves the tunnel machinery actually works; it is deliberately not part of
// `npm test` because it needs outbound network access.
//
// By default it uses a quick tunnel (throwaway random hostname) because that
// needs no Cloudflare account. Run it against a configured named tunnel with:
//   node scripts/e2e-tunnel.mjs --named

import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import { once } from 'node:events'

import { TunnelManager } from '../src/tunnel.mjs'

const body = `dsh-tunnel-mcp e2e ${Date.now()}`

/** Plain HTTPS GET that reports the underlying network error instead of "fetch failed". */
function legacyGet(url, family) {
  return new Promise((resolve) => {
    const request = https.get(url, { timeout: 30_000, ...(family ? { family } : {}) }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, text, family: family ?? 'auto' }))
    })
    request.on('timeout', () => { request.destroy(new Error('timeout')) })
    request.on('error', (error) => resolve({ status: null, text: '', family: family ?? 'auto', error: `${error.code ?? ''} ${error.message}`.trim() }))
  })
}

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(body)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
process.stderr.write(`local origin ${origin}\n`)

const named = process.argv.includes('--named')
const manager = new TunnelManager({ log: (line) => process.stderr.write(`[cloudflared] ${line}\n`) })

const report = { mode: named ? 'named' : 'quick', origin, steps: [] }
let exitCode = 1

try {
  const started = named
    ? await manager.startNamed({ origin })
    : await manager.startQuick({ origin })

  report.started = started
  report.steps.push({ step: 'start', ok: true, state: started.state, url: started.publicUrl, stable: started.stable })
  assert.ok(started.publicUrl, 'a tunnel URL must be published')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45_000)
  let fetched
  try {
    const response = await fetch(started.publicUrl, { signal: controller.signal })
    fetched = { status: response.status, text: await response.text() }
  } catch (error) {
    // Node's fetch hides the real cause; surface the network-level detail and
    // retry once through the plain https client, which reports TLS/DNS errors.
    report.fetchError = {
      message: error?.message,
      cause: error?.cause?.code ?? error?.cause?.message ?? null,
    }
    fetched = await legacyGet(started.publicUrl)
  } finally {
    clearTimeout(timer)
  }

  report.steps.push({ step: 'public-fetch', ok: fetched.status === 200, status: fetched.status })
  assert.equal(fetched.status, 200, `expected 200 from ${started.publicUrl}, got ${fetched.status}`)
  assert.equal(fetched.text, body, 'the public response must be the loopback body')

  if (named) {
    // The whole point: a restart reuses the same hostname.
    const before = started.publicUrl
    await manager.stop()
    const restarted = await manager.startNamed({ origin })
    report.steps.push({ step: 'restart', ok: restarted.publicUrl === before, before, after: restarted.publicUrl })
    assert.equal(restarted.publicUrl, before, 'a named tunnel must keep one hostname across restarts')
  }

  exitCode = 0
  report.ok = true
} catch (error) {
  report.ok = false
  report.error = error?.stack ?? String(error)
} finally {
  await manager.stop().catch(() => {})
  server.close()
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exit(exitCode)
