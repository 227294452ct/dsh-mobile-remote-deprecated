#!/usr/bin/env node
// Standalone gateway process.
//
// Runs the mobile gateway out of process, detached from the DSH/MCP host, so the
// phone keeps working across DSH restarts. Writes a state file the MCP server
// reads, and re-pairs its harness cookie on its own when the harness restarts.
//
//   node bin/gateway.mjs start [--config <path>]
//   node bin/gateway.mjs status
//   node bin/gateway.mjs stop

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MobileGateway } from '../src/gateway-server.mjs'
import { statePaths } from '../src/paths.mjs'
import { resolveCloudflared, resolveTunnelConfig } from '../src/config.mjs'
import { startNamedTunnelProcess } from '../src/tunnel.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : null
}

const command = process.argv[2] ?? 'status'
const env = process.env
const paths = statePaths(env)
const configPath = argValue('--config') ?? path.join(paths.root, 'gateway.json')
const statePath = path.join(paths.root, 'gateway-state.json')
const pidPath = path.join(paths.root, 'gateway.pid')
const scriptPath = process.argv[1]

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readPid() {
  try {
    const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isAlive(pid) {
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

if (command === 'status') {
  const pid = readPid()
  const state = readJson(statePath)
  console.log(JSON.stringify({ pid, alive: isAlive(pid), state, configPath }, null, 2))
  process.exit(0)
}

if (command === 'stop') {
  const pid = readPid()
  if (pid === null || !isAlive(pid)) {
    console.log(JSON.stringify({ stopped: false, reason: 'no live gateway process' }, null, 2))
    process.exit(0)
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    console.log(JSON.stringify({ stopped: false, error: error.message }, null, 2))
    process.exit(1)
  }
  console.log(JSON.stringify({ stopped: true, pid }, null, 2))
  process.exit(0)
}

if (command !== 'start' && command !== 'run') {
  console.error(`Unknown command: ${command}`)
  process.exit(1)
}

// --- start -----------------------------------------------------------------

const config = readJson(configPath)
if (config === null) {
  console.error(`Gateway config not found or unreadable: ${configPath}`)
  process.exit(1)
}

const logFile = path.join(paths.root, 'gateway.log')
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    mkdirSync(paths.root, { recursive: true })
    writeFileSync(logFile, line, { flag: 'a' })
  } catch {
    // Logging must never take the gateway down.
  }
}

const gateway = new MobileGateway({ log, publicHost: config.publicHost ?? null })
let tunnelChild = null

/**
 * Own the tunnel from this process. The gateway port is ephemeral, so whoever
 * owns the tunnel must be able to rewrite its ingress target on every restart.
 */
function startOwnTunnel() {
  if (config.tunnel === false) return null
  // Prefer the explicit config the MCP server handed over; fall back to reading
  // cloudflared's own configuration.
  const fromConfig = config.tunnelId && config.tunnelHostname && config.credentialsFile
    ? { tunnelId: config.tunnelId, hostname: config.tunnelHostname, credentialsFile: config.credentialsFile }
    : null
  const resolved = fromConfig ?? resolveTunnelConfig({}, env)
  if (!resolved.tunnelId || !resolved.hostname || !resolved.credentialsFile) {
    log(`No named tunnel configured; the gateway is running without a tunnel. ${JSON.stringify({ fromConfig: Boolean(fromConfig), resolved })}`)
    return null
  }
  const binary = config.cloudflaredPath
    ? { path: config.cloudflaredPath, source: 'config' }
    : resolveCloudflared(null, env)
  const tunnelConfigFile = path.join(paths.root, 'cloudflared.yml')
  try {
    tunnelChild = startNamedTunnelProcess({
      binary: binary.path,
      configFile: tunnelConfigFile,
      credentialsFile: resolved.credentialsFile,
      tunnelId: resolved.tunnelId,
      hostname: resolved.hostname,
      origin: gateway.origin,
      log,
    })
    tunnelChild.once('exit', (code) => {
      log(`cloudflared exited (code ${code ?? 'null'}); a watchdog restart reuses the same hostname.`)
      tunnelChild = null
      if (shuttingDown) return
      setTimeout(() => {
        if (shuttingDown || tunnelChild !== null) return
        log('Restarting cloudflared.')
        try {
          startOwnTunnel()
        } catch (error) {
          log(`cloudflared restart failed: ${error.message}`)
        }
      }, 5_000).unref?.()
    })
  } catch (error) {
    log(`Could not start cloudflared: ${error.message}`)
  }
  return tunnelChild
}

let shuttingDown = false

async function shutdown(reason) {
  shuttingDown = true
  log(`Stopping gateway (${reason})`)
  try {
    tunnelChild?.kill()
  } catch {
    // ignore
  }
  try {
    await gateway.stop()
  } catch {
    // ignore
  }
  try {
    rmSync(pidPath, { force: true })
    writeJson(statePath, { running: false, stoppedAt: new Date().toISOString(), reason })
  } catch {
    // ignore
  }
  process.exit(0)
}

async function main() {
  // Prefer the already-validated cookie, fall back to the raw token, and if
  // neither is supplied recover one by scanning the live harness. That last path
  // is what makes auto-start work even when the harness launched after us.
  if (config.harnessPort) {
    try {
      await gateway.attachHarness({
        port: config.harnessPort,
        cookie: config.harnessCookie ?? undefined,
        token: config.harnessToken ?? undefined,
      })
    } catch (error) {
      log(`Initial harness attach failed (${error.message}); the gateway will recover on first use.`)
    }
  }
  await gateway.start()
  startOwnTunnel()

  writeFileSync(pidPath, String(process.pid), 'utf8')
  const state = {
    running: true,
    pid: process.pid,
    port: gateway.port,
    origin: gateway.origin,
    startedAt: new Date().toISOString(),
    harnessPort: config.harnessPort,
    publicHost: config.publicHost ?? null,
    tunnelPid: tunnelChild?.pid ?? null,
    scriptPath,
    projectRoot,
  }
  writeJson(statePath, state)
  log(`Gateway listening on ${gateway.origin} (harness ${config.harnessPort})`)
  process.stdout.write(`${JSON.stringify({ ready: true, ...state })}\n`)

  // Watchdog: if the gateway's own HTTP server dies, the process is useless.
  setInterval(() => {
    if (gateway.server === null) {
      log('Gateway server disappeared; restarting it.')
      void gateway.start().catch((error) => log(`Gateway restart failed: ${error.message}`))
    }
  }, 30_000).unref?.()

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('uncaughtException', (error) => {
    log(`uncaughtException: ${error?.stack ?? error}`)
  })
  process.on('unhandledRejection', (error) => {
    log(`unhandledRejection: ${error?.stack ?? error}`)
  })
}

main().catch((error) => {
  log(`Gateway failed to start: ${error?.stack ?? error}`)
  writeJson(statePath, { running: false, error: String(error?.message ?? error), failedAt: new Date().toISOString() })
  process.exit(1)
})

void existsSync
