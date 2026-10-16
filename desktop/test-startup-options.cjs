'use strict'

/**
 * Launch-option assertions.
 *
 * Run: node test-startup-options.cjs
 *
 * These cover the two options that decide whether a phone keeps its pairing:
 * the harness port the gateway dials, and the permanent hostname it advertises.
 */

const assert = require('node:assert/strict')
const {
  DEFAULT_UPSTREAM_URL,
  normalizeUpstream,
  readArgument,
  resolveHostname,
  resolveUpstream,
  resolveUpstreamWithDiscovery
} = require('./startup-options.cjs')

// --- readArgument ----------------------------------------------------------

{
  const argv = ['electron.exe', '.', '--upstream', 'http://127.0.0.1:19387']
  assert.equal(readArgument('--upstream', argv), 'http://127.0.0.1:19387')
  assert.equal(readArgument('--hostname', argv), null)
}

{
  // The `--name=value` form must work too; PowerShell rewrites dotted values and
  // this form is what avoids that class of surprise.
  const argv = ['electron.exe', '.', '--upstream=http://127.0.0.1:19387', '--hostname=dsh.example.com']
  assert.equal(readArgument('--upstream', argv), 'http://127.0.0.1:19387')
  assert.equal(readArgument('--hostname', argv), 'dsh.example.com')
}

{
  // A trailing flag with no value must not swallow undefined.
  assert.equal(readArgument('--hostname', ['electron.exe', '.', '--hostname']), null)
}

// --- normalizeUpstream -----------------------------------------------------

{
  assert.equal(normalizeUpstream('http://127.0.0.1:19387'), 'http://127.0.0.1:19387')
  // Any path/query is stripped: the gateway always dials the origin root.
  assert.equal(normalizeUpstream('http://127.0.0.1:19387/some/path?x=1#h'), 'http://127.0.0.1:19387')
  assert.equal(normalizeUpstream('http://localhost:32145'), 'http://localhost:32145')
}

{
  // The tunnel is public, so a non-loopback upstream must be refused.
  assert.throws(() => normalizeUpstream('http://192.168.1.10:19387'), /回环/)
  assert.throws(() => normalizeUpstream('http://example.com:19387'), /回环/)
}

{
  assert.throws(() => normalizeUpstream('https://127.0.0.1:19387'), /http/)
  assert.throws(() => normalizeUpstream('ws://127.0.0.1:19387'), /http/)
  assert.throws(() => normalizeUpstream('http://127.0.0.1'), /端口/)
  assert.throws(() => normalizeUpstream(''), (error) => error instanceof Error)
}

// --- resolveUpstream precedence --------------------------------------------

{
  const argv = ['electron.exe', '.', '--upstream', 'http://127.0.0.1:19387']
  // An explicit flag beats the environment.
  assert.equal(resolveUpstream(argv, { DSH_UPSTREAM_URL: 'http://127.0.0.1:55555' }), 'http://127.0.0.1:19387')
}

{
  // The environment beats the default.
  assert.equal(resolveUpstream(['electron.exe', '.'], { DSH_UPSTREAM_URL: 'http://127.0.0.1:19387' }), 'http://127.0.0.1:19387')
}

{
  assert.equal(resolveUpstream(['electron.exe', '.'], {}), DEFAULT_UPSTREAM_URL)
}

// --- resolveHostname -------------------------------------------------------

{
  assert.equal(resolveHostname(['electron.exe', '.', '--hostname', 'dsh.example.com'], {}), 'dsh.example.com')
  assert.equal(resolveHostname(['electron.exe', '.'], { DSH_TUNNEL_HOSTNAME: 'dsh.example.com' }), 'dsh.example.com')
  // Normalized, because DNS hostnames are case-insensitive and the gateway
  // compares them against the app's pinned list.
  assert.equal(resolveHostname(['electron.exe', '.', '--hostname', 'DSH.Example.COM'], {}), 'dsh.example.com')
}

{
  // No hostname at all is a legitimate outcome: the gateway then uses a quick
  // tunnel. It must be reported as null, never as an empty string that looks
  // configured.
  assert.equal(resolveHostname(['electron.exe', '.'], {}), null)
  assert.equal(resolveHostname(['electron.exe', '.', '--hostname', '   '], {}), null)
}

// --- auto-discovery --------------------------------------------------------
// The companion must find the harness without being told the port, because the
// port is an implementation detail the user should not have to look up.
//
// This file is CommonJS, so the async cases run inside main() rather than at the
// top level.

const { probeHarness } = require('./startup-options.cjs')

/** Point the module at a throwaway HTTP server that answers like the harness. */
async function withFakeHarness(status, run) {
  const http = require('node:http')
  const server = http.createServer((_request, response) => {
    response.writeHead(status)
    response.end('')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await run(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function main() {
  // 401 is the harness's unauthenticated answer, 200 its authenticated one.
  await withFakeHarness(401, async (port) => {
    assert.equal(await probeHarness(`http://127.0.0.1:${port}`), true, '401 must count as the harness')
  })
  await withFakeHarness(200, async (port) => {
    assert.equal(await probeHarness(`http://127.0.0.1:${port}`), true, '200 must count as the harness')
  })

  // Anything else is not the harness, however alive it looks.
  await withFakeHarness(404, async (port) => {
    assert.equal(await probeHarness(`http://127.0.0.1:${port}`), false, '404 is not the harness')
  })
  await withFakeHarness(302, async (port) => {
    assert.equal(await probeHarness(`http://127.0.0.1:${port}`), false, 'a redirect is not the harness')
  })

  // A closed port must fail fast rather than hang the launch.
  assert.equal(await probeHarness('http://127.0.0.1:9', 800), false)

  // An explicit choice is never re-resolved, so a stray local port cannot
  // silently override what the operator asked for.
  const explicit = await resolveUpstreamWithDiscovery(
    ['electron.exe', '.', '--upstream', 'http://127.0.0.1:55555'],
    {}
  )
  assert.equal(explicit.origin, 'http://127.0.0.1:55555')
  assert.equal(explicit.source, 'explicit')
  assert.equal(explicit.discovered, false)

  const viaEnv = await resolveUpstreamWithDiscovery(['electron.exe', '.'], { DSH_UPSTREAM_URL: 'http://127.0.0.1:44444' })
  assert.equal(viaEnv.origin, 'http://127.0.0.1:44444')
  assert.equal(viaEnv.source, 'explicit')

  // Discovery disabled must fall back to the documented default rather than
  // probing anything, so the escape hatch is trustworthy.
  const off = await resolveUpstreamWithDiscovery(['electron.exe', '.'], { DSH_TUNNEL_DISABLE_DISCOVERY: '1' })
  assert.equal(off.origin, DEFAULT_UPSTREAM_URL)
  assert.equal(off.discovered, false)
  assert.equal(off.source, 'default')

  console.log('startup-options-test-ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
