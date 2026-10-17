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

// --- re-arming must not wipe the connection set ---------------------------
// cloudflared reports a registration on many chunks of output and every chunk
// calls startTunnelWatchdog(). If that reset the set, the watchdog would see "no
// connections" 90s later and restart a healthy tunnel — an endless reconnect loop
// that looks like a flaky network.

{
  const gateway = newGateway()
  for (const index of [0, 1, 2, 3]) gateway.trackTunnelLine(register(index))
  const before = [...gateway.tunnelConnections].sort()

  gateway.startTunnelWatchdog()
  const armed = gateway.tunnelWatchdog
  gateway.startTunnelWatchdog()
  gateway.startTunnelWatchdog()

  assert.equal(gateway.tunnelWatchdog, armed, 're-arming must keep the existing interval')
  assert.deepEqual([...gateway.tunnelConnections].sort(), before, 're-arming must not drop known connections')
  gateway.stopTunnelWatchdog()
}

{
  // The first arm, with nothing known yet, must start the stale clock now so a
  // tunnel that never registers is still caught.
  const gateway = newGateway()
  gateway.tunnelLastAliveAt = 0
  gateway.startTunnelWatchdog()
  assert.ok(gateway.tunnelLastAliveAt > 0, 'arming must start the stale clock')
  gateway.stopTunnelWatchdog()
}

// --- edge quality supervision ---------------------------------------------
// The tunnel can be registered and healthy while the edge Cloudflare picked is
// unusable: seconds of latency and dropped requests, with no error anywhere. The
// monitor is the only thing that turns that into a reconnect.

async function withServer(handler, run) {
  const http = require('node:http')
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function main() {
  const { RemoteGateway } = require('./remote-gateway.cjs')

  {
    // A dead address is the simplest bad edge: every probe fails.
    const gateway = newGateway()
    let restarts = 0
    gateway.restartTunnel = () => { restarts += 1 }
    gateway.remoteUrl = 'http://127.0.0.1:9'

    await gateway.probeEdgeHealth()
    assert.equal(gateway.edgeStrikes, 1)
    await gateway.probeEdgeHealth()
    assert.equal(gateway.edgeStrikes, 2)
    assert.equal(restarts, 0, 'must not reconnect on a single bad probe')
    await gateway.probeEdgeHealth()
    assert.equal(restarts, 1, 'must reconnect once the edge stays bad')
    gateway.stopEdgeHealthMonitor()
  }

  {
    // Reconnecting is disruptive, so it must not happen again immediately even if
    // the new edge is no better.
    const gateway = newGateway()
    let restarts = 0
    gateway.restartTunnel = () => { restarts += 1 }
    gateway.remoteUrl = 'http://127.0.0.1:9'
    for (let i = 0; i < 3; i += 1) await gateway.probeEdgeHealth()
    assert.equal(restarts, 1)
    for (let i = 0; i < 6; i += 1) await gateway.probeEdgeHealth()
    assert.equal(restarts, 1, 'the cooldown must suppress a restart storm')
    gateway.stopEdgeHealthMonitor()
  }

  {
    // A healthy edge clears the strikes, so an occasional blip never adds up to a
    // reconnect.
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    }, async (origin) => {
      const gateway = newGateway()
      let restarts = 0
      gateway.restartTunnel = () => { restarts += 1 }
      gateway.remoteUrl = origin
      await gateway.probeEdgeHealth()
      await gateway.probeEdgeHealth()
      assert.equal(gateway.edgeStrikes, 0, 'a healthy probe must clear strikes')
      assert.equal(restarts, 0)
      gateway.stopEdgeHealthMonitor()
    })
  }

  {
    // The monitor must not run at all in a test/tunnel-less gateway, where there
    // is no public address to probe.
    const gateway = newGateway()
    gateway.startEdgeHealthMonitor()
    assert.notEqual(gateway.edgeMonitor, null)
    gateway.stopEdgeHealthMonitor()
    assert.equal(gateway.edgeMonitor, null, 'stop() must clear the interval')
  }

  console.log('tunnel-watchdog-test-ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
