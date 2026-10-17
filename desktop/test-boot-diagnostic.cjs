'use strict'

/**
 * Boot-diagnostic injection assertions.
 *
 * Run: node test-boot-diagnostic.cjs
 *
 * Why this exists: a white screen in an Android WebView is silent — no console,
 * no error text, and the user can only report "blank". The gateway injects a
 * dependency-free harness that paints script errors, unhandled rejections, failed
 * sub-resources and an empty render into the page, so the failure becomes a
 * readable message. This file keeps that injection present and syntactically
 * valid, because a syntax error in it would itself go unnoticed.
 */

const assert = require('node:assert/strict')
const http = require('node:http')
const { mkdtempSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { RemoteGateway } = require('./remote-gateway.cjs')

// --- the injected document -------------------------------------------------

async function renderThroughGateway(html) {
  const harness = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html)
  })
  await new Promise((resolve) => harness.listen(0, '127.0.0.1', resolve))

  const gateway = new RemoteGateway({
    userDataPath: mkdtempSync(path.join(os.tmpdir(), 'dsh-bootdiag-')),
    skipTunnel: true,
    log: () => {}
  })
  gateway.harnessUrl = `http://127.0.0.1:${harness.address().port}`

  const request = { method: 'GET', url: '/', headers: {} }
  const captured = {}
  const response = {
    headersSent: false,
    writeHead(status, headers) { captured.status = status; captured.headers = headers; this.headersSent = true },
    end(body) { captured.body = body },
    on() {},
    once() {}
  }
  await gateway.proxyHtmlWithCompatibility(request, response)
  await new Promise((resolve) => harness.close(resolve))
  return { html: captured.body.toString('utf8'), status: captured.status }
}

async function main() {
  const source = '<html><head><title>t</title></head><body><div id="root"></div></body></html>'
  const { html, status } = await renderThroughGateway(source)

  assert.equal(status, 200)
  assert.ok(html.includes('id="__dsh_boot_diag"') || html.includes('__dsh_boot_diag'), 'diagnostic overlay must be injected')
  assert.ok(html.includes('unhandledrejection'), 'unhandled rejections must be reported')
  assert.ok(html.includes('addEventListener'), 'an error listener must be installed')
  assert.ok(html.includes('/_dsh_remote/compat.js'), 'the compat script must still be injected')
  // The diagnostic must come first so it can catch failures of everything after it.
  assert.ok(
    html.indexOf('__dsh_boot_diag') < html.indexOf('/_dsh_remote/compat.js'),
    'the diagnostic must be injected before the compat script'
  )

  // Extract the inline script and prove it parses; a syntax error would be silent
  // in production and would defeat the whole point.
  const inline = /<script>([\s\S]*?)<\/script>/.exec(html)
  assert.ok(inline, 'an inline script must be present')
  assert.doesNotThrow(() => new Function(inline[1]), 'the injected script must parse')
  // It must not depend on anything: a blank page has nothing else loaded yet.
  assert.ok(!/\bimport\s|\brequire\(/.test(inline[1]), 'the diagnostic must be dependency-free')

  // A document without <head> must still get the injection rather than crash.
  const bare = await renderThroughGateway('<div>no head</div>')
  assert.ok(bare.html.includes('__dsh_boot_diag'))

  // Non-HTML responses must pass through untouched.
  const json = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  await new Promise((resolve) => json.listen(0, '127.0.0.1', resolve))
  const gateway = new RemoteGateway({
    userDataPath: mkdtempSync(path.join(os.tmpdir(), 'dsh-bootdiag2-')),
    skipTunnel: true,
    log: () => {}
  })
  gateway.harnessUrl = `http://127.0.0.1:${json.address().port}`
  const captured = {}
  await gateway.proxyHtmlWithCompatibility(
    { method: 'GET', url: '/', headers: {} },
    {
      headersSent: false,
      writeHead(statusCode, headers) { captured.status = statusCode; captured.headers = headers; this.headersSent = true },
      end(body) { captured.body = body },
      on() {},
      once() {}
    }
  )
  assert.equal(captured.body.toString('utf8'), '{"ok":true}', 'JSON must not be patched')
  await new Promise((resolve) => json.close(resolve))

  console.log('boot-diagnostic-test-ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
