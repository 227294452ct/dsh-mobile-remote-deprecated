'use strict'

/**
 * Tunnel watchdog assertions.
 *
 * Run: node test-tunnel-watchdog.cjs
 *
 * Why this exists: cloudflared keeps its process alive while every edge
 * connection drops. A VPN or proxy blip therefore leaves the tunnel "running"
 * with a public address that answers 530 and phones that time out, and nothing
 * looks wrong locally. The watchdog watches the connection set, not the process,
 * so this file pins down how that set is derived from cloudflared's log.
 */

const assert = require('node:assert/strict')
const { mkdtempSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { RemoteGateway } = require('./remote-gateway.cjs')

function newGateway() {
  return new RemoteGateway({
    userDataPath: mkdtempSync(path.join(os.tmpdir(), 'dsh-watchdog-')),
    skipTunnel: true,
    log: () => {}
  })
}

const register = (index) =>
  `2026-10-17T03:49:25Z INF Registered tunnel connection connIndex=${index} connection=abc location=lax12 protocol=http2`

// --- registrations are counted, not just noticed ---------------------------

{
  const gateway = newGateway()
  for (const index of [0, 1, 2, 3]) gateway.trackTunnelLine(register(index))
  assert.equal(gateway.tunnelConnections.size, 4)
  assert.ok(gateway.tunnelLastAliveAt > 0, 'a registration must refresh the liveness clock')
  gateway.stopTunnelWatchdog()
}

{
  // Several registrations arrive in one chunk; all must be counted.
  const gateway = newGateway()
  gateway.trackTunnelLine([register(0), register(1)].join('\n'))
  assert.equal(gateway.tunnelConnections.size, 2)
  gateway.stopTunnelWatchdog()
}

{
  // Re-registering the same index must not inflate the count: cloudflared
  // reconnects reuse the index, and an inflated set would hide a dead tunnel.
  const gateway = newGateway()
  gateway.trackTunnelLine(register(0))
  gateway.trackTunnelLine(register(0))
  gateway.trackTunnelLine(register(0))
  assert.equal(gateway.tunnelConnections.size, 1)
  gateway.stopTunnelWatchdog()
}

// --- terminations remove exactly the index that dropped -------------------

{
  const gateway = newGateway()
  for (const index of [0, 1, 2, 3]) gateway.trackTunnelLine(register(index))
  gateway.trackTunnelLine('2026-10-17T03:46:49Z ERR Connection terminated error=timeout connIndex=2')
  assert.equal(gateway.tunnelConnections.size, 3)
  assert.deepEqual([...gateway.tunnelConnections].sort(), ['0', '1', '3'])
  gateway.stopTunnelWatchdog()
}

{
  // cloudflared reports both phrasings; either must clear the entry.
  const gateway = newGateway()
  gateway.trackTunnelLine(register(0))
  gateway.trackTunnelLine(register(1))
  gateway.trackTunnelLine('2026-10-17T03:49:29Z INF Unregistered tunnel connection connIndex=0')
  assert.deepEqual([...gateway.tunnelConnections], ['1'])
  gateway.stopTunnelWatchdog()
}

{
  // The case that motivated the watchdog: everything drops while the process
  // stays alive. The set must end up empty so the watchdog can act.
  const gateway = newGateway()
  for (const index of [0, 1, 2, 3]) gateway.trackTunnelLine(register(index))
  for (const index of [0, 1, 2, 3]) {
    gateway.trackTunnelLine(`2026-10-17T03:46:49Z ERR Connection terminated error="no recent network activity" connIndex=${index}`)
  }
  assert.equal(gateway.tunnelConnections.size, 0)
  gateway.stopTunnelWatchdog()
}

// --- unrelated output must not move the state -----------------------------

{
  const gateway = newGateway()
  gateway.trackTunnelLine(register(0))
  gateway.trackTunnelLine('2026-10-17T03:49:23Z INF Initial protocol http2')
  gateway.trackTunnelLine('2026-10-17T03:49:23Z INF precheck component="DNS Resolution" status=pass')
  gateway.trackTunnelLine('2026-10-17T03:49:23Z INF +----------+')
  assert.equal(gateway.tunnelConnections.size, 1, 'noise must not register or drop connections')
  gateway.stopTunnelWatchdog()
}

// --- the watchdog itself is inert until a tunnel exists -------------------

{
  // A watchdog that restarts during ordinary startup would fight the tunnel.
  const gateway = newGateway()
  gateway.startTunnelWatchdog()
  assert.notEqual(gateway.tunnelWatchdog, null, 'watchdog should be armed while the gateway lives')
  gateway.stopTunnelWatchdog()
  assert.equal(gateway.tunnelWatchdog, null, 'stop() must clear the interval')
}

console.log('tunnel-watchdog-test-ok')
