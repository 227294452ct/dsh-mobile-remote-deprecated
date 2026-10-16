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
  resolveUpstream
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

console.log('startup-options-test-ok')
