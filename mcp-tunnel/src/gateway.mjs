// Read-only integration with the DeepSeek Harness Desktop remote gateway.
//
// Two facts are needed from the Desktop side: the loopback origin of its HTTP
// gateway, and the list of paired phones. Both are read, never written.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { desktopUserDataCandidates, firstExisting, statePaths } from './paths.mjs'
import { readJsonFile } from './tunnel.mjs'

export const API_PREFIX = '/_dsh_remote/v1'

/**
 * Newer Desktop builds drop a status snapshot here; it is authoritative when
 * present because it is written by the process that owns the listening socket.
 */
export function readGatewaySnapshot(env = process.env) {
  const paths = statePaths(env)
  const file = path.join(paths.root, 'gateway.json')
  if (!existsSync(file)) return null
  const parsed = readJsonFile(file)
  if (!parsed) return null
  const port = Number.isInteger(parsed.gatewayPort) ? parsed.gatewayPort : null
  if (port === null) return null
  return {
    gatewayPort: port,
    origin: typeof parsed.origin === 'string' ? parsed.origin : `http://127.0.0.1:${port}`,
    remoteUrl: typeof parsed.remoteUrl === 'string' ? parsed.remoteUrl : null,
    tunnelProvider: typeof parsed.tunnelProvider === 'string' ? parsed.tunnelProvider : null,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    source: file,
  }
}

export function desktopUserDataDir(env = process.env) {
  return firstExisting(desktopUserDataCandidates(env))
}

/** Paired phones from the Desktop app, with public keys redacted by prefix only. */
export function readPairedDevices(env = process.env) {
  const dir = desktopUserDataDir(env)
  if (!dir) return { devices: [], source: null }
  const file = path.join(dir, 'remote-devices.json')
  if (!existsSync(file)) return { devices: [], source: null }
  const parsed = readJsonFile(file)
  if (!parsed || !Array.isArray(parsed.devices)) return { devices: [], source: file }
  const devices = parsed.devices
    .filter((device) => device && typeof device.id === 'string')
    .map((device) => ({
      id: device.id,
      name: typeof device.name === 'string' ? device.name : null,
      platform: typeof device.platform === 'string' ? device.platform : null,
      pairedAt: device.pairedAt ?? null,
      lastSeenAt: device.lastSeenAt ?? null,
      hasPublicKey: typeof device.publicKey === 'string' && device.publicKey.length > 0,
    }))
  return { devices, source: file }
}

/**
 * Ask the gateway to confirm it really is the DSH remote gateway at this
 * origin. Any HTTP status counts as "something is listening"; a JSON body with
 * the expected API shape counts as "this is the gateway".
 */
export async function probeGateway(origin, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2_500
  const base = origin.replace(/\/+$/, '')
  const result = { origin: base, reachable: false, looksLikeGateway: false, status: null, error: null, body: null }

  for (const target of [`${base}${API_PREFIX}/drives`, `${base}${API_PREFIX}/status`]) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(target, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'dsh-tunnel-mcp' },
      })
      result.reachable = true
      result.status = response.status
      const text = await response.text().catch(() => '')
      if (text.length > 0 && text.length < 8_192) {
        try {
          const parsed = JSON.parse(text)
          result.body = parsed
          // The gateway answers its own API; an auth rejection still proves the
          // endpoint exists rather than being some unrelated local service.
          if (response.status === 200 || response.status === 401 || response.status === 403) {
            result.looksLikeGateway = true
          }
          if (parsed && typeof parsed === 'object' && ('drives' in parsed || 'error' in parsed || 'running' in parsed)) {
            result.looksLikeGateway = true
          }
        } catch {
          // Non-JSON body: reachable but unproven.
        }
      }
      return result
    } catch (error) {
      const cause = error?.cause
      result.error = error?.name === 'AbortError'
        ? 'timeout'
        : (cause?.code ? `${cause.code}: ${cause.message}` : (error?.message ?? String(error)))
    } finally {
      clearTimeout(timer)
    }
  }
  return result
}

/** Best-effort discovery of the gateway origin with no side effects. */
export async function discoverOrigin(env = process.env, options = {}) {
  // A recorded snapshot is a hint, never proof: the Desktop app may have
  // restarted on a different ephemeral port since it was written.
  const snapshot = readGatewaySnapshot(env)
  if (snapshot) {
    const probe = await probeGateway(snapshot.origin, options)
    if (probe.looksLikeGateway) return { ...snapshot, probe, discoveredBy: 'status-file' }
  }

  for (const port of collectPortHints(env)) {
    const origin = `http://127.0.0.1:${port}`
    const probe = await probeGateway(origin, options)
    if (probe.looksLikeGateway) {
      return { gatewayPort: port, origin, probe, discoveredBy: 'recorded-port', remoteUrl: null, tunnelProvider: null, updatedAt: null, source: null }
    }
  }

  // The gateway binds an ephemeral port that no file records, so ask the OS
  // which ports the Desktop processes actually hold. Probes run concurrently
  // because a dead Desktop app can leave dozens of candidate ports behind.
  const listening = await listeningPortsOfDesktopProcesses(env)
  const found = await firstMatchingOrigin(listening, options)
  if (found) {
    return { gatewayPort: found.port, origin: found.origin, probe: found.probe, discoveredBy: 'os-socket-scan', remoteUrl: null, tunnelProvider: null, updatedAt: null, source: null }
  }

  return null
}

/** Probe candidate ports with bounded concurrency; resolve at the first hit. */
async function firstMatchingOrigin(ports, options = {}) {
  const queue = [...new Set(ports)].slice(0, 64)
  const concurrency = Math.min(6, queue.length)
  if (concurrency === 0) return null

  // Candidate loops are mostly dead ports that refuse immediately, so a short
  // per-probe deadline keeps a scan bounded without hiding a real gateway.
  const probeOptions = { timeoutMs: 1_500, ...options }

  let cursor = 0
  let settled = false
  let winner = null

  const worker = async () => {
    while (!settled) {
      const index = cursor
      cursor += 1
      if (index >= queue.length) return
      const port = queue[index]
      const origin = `http://127.0.0.1:${port}`
      const probe = await probeGateway(origin, probeOptions)
      if (probe.looksLikeGateway && !settled) {
        settled = true
        winner = { port, origin, probe }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  return winner
}

/**
 * Ports held by a DeepSeek Harness Desktop process, via the OS. Read-only; never
 * signals or terminates anything.
 *
 * Windows: one CIM query returns processes (with their executable paths) and
 * their listening sockets, so the candidate set is exactly the Desktop app's
 * own ports. Matching every Electron process would sweep in unrelated apps
 * (editors, other Electron tools) and make discovery take minutes.
 */
export async function listeningPortsOfDesktopProcesses(env = process.env) {
  if (process.platform !== 'win32') {
    return listeningPortsPosix()
  }

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$procs = Get-CimInstance Win32_Process',
    "$pids = @($procs | Where-Object { $_.Name -match 'DeepSeek Harness' -and $_.ExecutablePath -match 'DeepSeek Harness' } | Select-Object -ExpandProperty ProcessId)",
    'if ($pids.Count -eq 0) { exit 0 }',
    'Get-NetTCPConnection -State Listen | Where-Object { $pids -contains $_.OwningProcess } | ForEach-Object { "$($_.LocalAddress) $($_.LocalPort)" }',
  ].join('; ')

  let output = ''
  try {
    output = await runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], env)
  } catch {
    return listeningPortsWindowsFallback(env)
  }

  const ports = parseAddressPortLines(output)
  if (ports.length > 0) return ports
  return listeningPortsWindowsFallback(env)
}

/**
 * Fallback when PowerShell is unavailable or restricted: tasklist + netstat.
 * Less precise (it also matches other Electron apps), so results are bounded.
 */
async function listeningPortsWindowsFallback(env) {
  let netstat = ''
  let tasklist = ''
  try {
    const [a, b] = await Promise.all([
      runCapture('netstat', ['-ano', '-p', 'TCP'], env),
      runCapture('tasklist', ['/fo', 'csv', '/nh'], env),
    ])
    netstat = a
    tasklist = b
  } catch {
    return []
  }

  const pids = new Set()
  for (const line of tasklist.split(/\r?\n/)) {
    const match = /^"([^"]+)","(\d+)"/.exec(line.trim())
    if (!match) continue
    const [, name, pid] = match
    if (/deepseek|harness|electron/i.test(name)) pids.add(pid)
  }
  if (pids.size === 0) return []

  const ports = new Set()
  for (const line of netstat.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
    if (!match) continue
    const [, address, port, pid] = match
    if (!pids.has(pid)) continue
    if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])$/.test(address)) continue
    const value = Number(port)
    if (Number.isInteger(value) && value > 0) ports.add(value)
  }
  return [...ports].slice(0, 64)
}

function parseAddressPortLines(output) {
  const ports = new Set()
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const match = /^(\S+)\s+(\d+)$/.exec(trimmed)
    if (!match) continue
    const [, address, port] = match
    if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]|::1|::)$/.test(address)) continue
    const value = Number(port)
    if (Number.isInteger(value) && value > 0 && value < 65_536) ports.add(value)
  }
  return [...ports]
}

async function listeningPortsPosix() {
  try {
    const output = await runCapture('ss', ['-ltnp'])
    const ports = new Set()
    for (const line of output.split('\n')) {
      if (!/LISTEN/.test(line)) continue
      if (!/deepseek|harness/i.test(line)) continue
      const match = /:(\d+)\s/.exec(line)
      if (match) ports.add(Number(match[1]))
    }
    return [...ports]
  } catch {
    return []
  }
}

function runCapture(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, env: env ?? process.env })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 4_000_000) stdout += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}`))))
  })
}

/** Ports worth trying when no snapshot exists, newest evidence first. */
function collectPortHints(env = process.env) {
  const hints = []
  const dir = desktopUserDataDir(env)
  if (dir) {
    for (const name of ['remote-gateway.json', 'remote-state.json']) {
      const file = path.join(dir, name)
      if (!existsSync(file)) continue
      const parsed = readJsonFile(file)
      const port = parsed?.gatewayPort
      if (Number.isInteger(port) && port > 0 && port < 65_536) hints.push(port)
    }
    try {
      for (const entry of readdirSync(dir)) {
        if (!/\.json$/i.test(entry)) continue
        const parsed = readJsonFile(path.join(dir, entry))
        const port = parsed?.gatewayPort
        if (Number.isInteger(port) && port > 0 && port < 65_536 && !hints.includes(port)) hints.push(port)
      }
    } catch {
      // unreadable directory: fall through to scanning
    }
  }
  return hints
}

export function describeBoundary() {
  return {
    apiPrefix: API_PREFIX,
    note: 'The MCP server never mutates Desktop state; it only reads the gateway origin, paired devices and status snapshots.',
  }
}
