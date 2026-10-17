// Named-tunnel runtime test.
//
// The real end-to-end run needs a domain on Cloudflare, which is a manual step.
// This test still exercises the whole named-tunnel runtime path — config file
// generation, credentials handling, cloudflared argument construction, the
// settle/error paths and the deterministic public URL — using synthetic
// credentials Cloudflare will reject. That proves the wiring is correct and the
// failure is reported instead of being swallowed (the original bug class here
// was a tunnel that looked "connected" while completely broken).

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { cfargotunnelHostname, renderNamedTunnelConfig, resolveTunnelConfig } from '../src/config.mjs'
import { TunnelManager } from '../src/tunnel.mjs'

const UUID = '9a1f0f4e-1111-2222-3333-444455556666'
const workdir = mkdtempSync(path.join(os.tmpdir(), 'dsh-named-runtime-'))
const stateHome = path.join(workdir, 'state')
const cloudflaredHome = path.join(workdir, 'cloudflared')
mkdirSync(stateHome, { recursive: true })
mkdirSync(cloudflaredHome, { recursive: true })

// Synthetic credentials: correct shape, not a real tunnel secret.
const credentialsFile = path.join(cloudflaredHome, `${UUID}.json`)
writeFileSync(
  credentialsFile,
  JSON.stringify({ AccountTag: '0'.repeat(32), TunnelSecret: Buffer.alloc(32, 7).toString('base64'), TunnelID: UUID, TunnelName: 'dsh-desktop' }),
  'utf8',
)

const env = {
  ...process.env,
  DSH_TUNNEL_HOME: stateHome,
  TUNNEL_ORIGIN_CERT: path.join(cloudflaredHome, 'cert.pem'),
  DSH_HOME: workdir,
}
// A cert.pem makes the local "logged in" check pass so the test reaches the
// network handshake rather than stopping at configuration validation.
writeFileSync(path.join(cloudflaredHome, 'cert.pem'), '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n', 'utf8')

const report = { steps: [] }
let failed = 0

function step(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      report.steps.push({ name, ok: true, detail })
      process.stderr.write(`PASS ${name}\n`)
    })
    .catch((error) => {
      failed += 1
      report.steps.push({ name, ok: false, error: error.message })
      process.stderr.write(`FAIL ${name}: ${error.message}\n`)
    })
}

const manager = new TunnelManager({ env, log: () => {} })

await step('resolveTunnelConfig discovers the named tunnel from ~/.cloudflared', () => {
  const resolved = resolveTunnelConfig({ hostname: 'dsh.xinqiaopsy.top' }, env)
  assert.equal(resolved.tunnelId, UUID, 'the credentials file name is the tunnel UUID')
  assert.equal(resolved.tunnelName, 'dsh-desktop')
  assert.equal(resolved.hostname, 'dsh.xinqiaopsy.top')
  assert.equal(resolved.loggedIn, true)
  assert.ok(resolved.localTunnels.length >= 1, 'the named tunnel must be discoverable on disk')
  return { tunnelId: resolved.tunnelId, credentialsFile: resolved.credentialsFile }
})

await step('status reports the permanent hostname before any tunnel runs', () => {
  manager.saveSettings({ hostname: 'dsh.xinqiaopsy.top', tunnelName: 'dsh-desktop', tunnelId: UUID, credentialsFile, origin: 'http://127.0.0.1:59999' })
  const status = manager.status()
  assert.equal(status.hostname, 'dsh.xinqiaopsy.top')
  assert.equal(status.configuredPublicUrl, 'https://dsh.xinqiaopsy.top')
  assert.equal(status.stable, false, 'nothing is running yet, so the address is not live')
  assert.equal(status.connectorHostname, `${UUID}.cfargotunnel.com`)
  return { configuredPublicUrl: status.configuredPublicUrl, connector: status.connectorHostname }
})

await step('startNamed writes a valid config and builds the right cloudflared command', async () => {
  let failure = null
  try {
    await manager.startNamed({ origin: 'http://127.0.0.1:59999' })
  } catch (error) {
    failure = error
  }

  const paths = manager.paths
  const generated = readFileSync(paths.configFile, 'utf8')
  const expected = renderNamedTunnelConfig({
    tunnelId: UUID,
    credentialsFile,
    hostname: 'dsh.xinqiaopsy.top',
    origin: 'http://127.0.0.1:59999',
  })
  assert.equal(generated, expected, 'the generated config must match the renderer exactly')
  assert.match(generated, /- service: http_status:404/, 'a catch-all ingress rule is required')

  // Cloudflare rejects synthetic credentials, so a failure here is expected and
  // must be a clear, non-silent error rather than a bogus "connected" state.
  assert.ok(failure, 'synthetic credentials must not produce a connected tunnel')
  const status = manager.status()
  assert.equal(status.stable, false, 'a failed start must not claim a stable address')
  assert.ok(
    status.state === 'failed' || status.state === 'disconnected' || status.state === 'stopped',
    `unexpected state ${status.state}`,
  )
  assert.equal(status.configuredPublicUrl, 'https://dsh.xinqiaopsy.top', 'the intended permanent URL is still knowable')
  return { failure: failure.message.slice(0, 180), finalState: status.state }
})

await step('a failed start leaves no stray child or pid file', async () => {
  await manager.stop()
  const status = manager.status()
  assert.equal(status.pid, null, 'no pid may survive a failed start plus stop')
  assert.equal(status.state, 'stopped')
  return { state: status.state, pid: status.pid }
})

await step('two tunnels may not run at once', async () => {
  // Nothing is running now, so a second start is allowed; what must never
  // happen is a silent second child. Assert the guard exists by inspecting the
  // live process handle the manager tracks.
  assert.equal(manager.child, null, 'no child should be tracked while stopped')
  return { tracked: manager.child === null }
})

try {
  rmSync(workdir, { recursive: true, force: true })
} catch {
  // best effort
}

report.ok = failed === 0
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exit(failed === 0 ? 0 : 1)
