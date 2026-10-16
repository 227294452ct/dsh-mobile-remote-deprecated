'use strict'

/**
 * Desktop launch-option parsing.
 *
 * Split out of `companion.cjs` so the command line can be asserted in plain
 * Node. Getting this wrong is silent and expensive: a misread `--upstream`
 * makes the app dial the wrong port, and a misread `--hostname` makes the
 * gateway fall back to a throwaway tunnel address, which forces the phone to
 * re-pair on every restart.
 */

const DEFAULT_UPSTREAM_URL = 'http://127.0.0.1:32145'

/**
 * The port DSH uses on this machine, and the one worth trying first.
 *
 * Kept as a constant rather than a hard-coded default so the original 32145
 * default still applies when nothing is running at all.
 */
const DSH_DEFAULT_PORT = 19387

const DISCOVERY_TIMEOUT_MS = 6_000
const PROBE_TIMEOUT_MS = 1_500


/**
 * Read one command-line option.
 *
 * Accepts both `--name value` and `--name=value`, because Electron forwards
 * arguments verbatim and both forms are common in practice.
 */
function readArgument(name, argv = process.argv) {
  const prefix = `${name}=`
  const exactIndex = argv.indexOf(name)
  if (exactIndex >= 0 && argv[exactIndex + 1]) return argv[exactIndex + 1]
  const inline = argv.find((value) => value.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : null
}

/**
 * Validate the harness upstream.
 *
 * Loopback-only by design: the tunnel is public, so the gateway must never be
 * pointed at a host outside this machine.
 */
function normalizeUpstream(rawValue) {
  const value = String(rawValue || '').trim()
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:') throw new Error('上游地址必须使用 http://。')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('出于安全考虑，上游地址必须指向本机回环地址。')
  }
  if (!parsed.port) throw new Error('上游地址必须包含端口号。')
  parsed.pathname = '/'
  parsed.search = ''
  parsed.hash = ''
  return parsed.origin
}

/**
 * Resolve the upstream the app should dial.
 *
 * Precedence is explicit flag, then environment, then the documented default,
 * so a packaged shortcut can be overridden without editing it.
 */
function resolveUpstream(argv = process.argv, env = process.env) {
  return normalizeUpstream(readArgument('--upstream', argv) || env.DSH_UPSTREAM_URL || DEFAULT_UPSTREAM_URL)
}

/**
 * Resolve the permanent hostname, if one was supplied.
 *
 * Returning null is meaningful: the gateway then falls back to a quick tunnel
 * and every restart produces a new address. Callers should surface that rather
 * than let the user believe pairing will stick.
 */
function resolveHostname(argv = process.argv, env = process.env) {
  const raw = readArgument('--hostname', argv) || env.DSH_TUNNEL_HOSTNAME || null
  if (raw === null) return null
  const value = String(raw).trim().toLowerCase()
  return value.length > 0 ? value : null
}

/** Run a command and return stdout, or '' on any failure. */
function runCapture(command, args, timeoutMs) {
  const { spawnSync } = require('node:child_process')
  try {
    const result = spawnSync(command, args, {
      windowsHide: true,
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024
    })
    return typeof result.stdout === 'string' ? result.stdout : ''
  } catch {
    return ''
  }
}

/**
 * Loopback ports a DeepSeek Harness process is listening on, on Windows.
 *
 * One CIM query matches both the image name and the executable path, because a
 * name-only match also catches unrelated Electron apps and would make the
 * gateway dial the wrong service.
 */
function harnessPortsWindows() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$procs = Get-CimInstance Win32_Process',
    "$pids = @($procs | Where-Object { $_.Name -match 'DeepSeek Harness' -and $_.ExecutablePath -match 'DeepSeek Harness' } | Select-Object -ExpandProperty ProcessId)",
    'if ($pids.Count -eq 0) { exit 0 }',
    'Get-NetTCPConnection -State Listen | Where-Object { $pids -contains $_.OwningProcess } | ForEach-Object { "$($_.LocalAddress) $($_.LocalPort)" }'
  ].join('; ')

  const output = runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], DISCOVERY_TIMEOUT_MS)
  const ports = new Set()
  for (const line of output.split(/\r?\n/)) {
    const match = /^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])\s+(\d+)\s*$/.exec(line.trim())
    if (!match) continue
    const port = Number(match[2])
    if (Number.isInteger(port) && port > 0) ports.add(port)
  }
  return [...ports]
}

/** Loopback ports the local Harness process listens on, if it is running. */
function candidateHarnessPorts({ env = process.env, platform = process.platform } = {}) {
  if (env.DSH_TUNNEL_DISABLE_DISCOVERY === '1') return []
  if (platform !== 'win32') {
    // Off Windows the desktop companion is not the supported target; the
    // documented default is the honest answer.
    return []
  }
  return harnessPortsWindows()
}

/**
 * Does this origin answer like a Harness web server?
 *
 * The Harness web server answers `/` with 401 when unauthenticated and 200 once
 * a session cookie is present. Anything else — a refusal, a timeout, an
 * unrelated app — is not a match.
 */
async function probeHarness(origin, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(origin, { redirect: 'manual', signal: controller.signal })
    return response.status === 401 || response.status === 200
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Find the upstream to dial when the user did not specify one.
 *
 * Order: the known DSH port, then whatever ports a Harness process actually
 * holds. Every candidate is confirmed by an HTTP probe, so a stale listening
 * port cannot be mistaken for the harness. Returns the documented default when
 * nothing answers, which keeps the original behaviour on a machine with no
 * Harness running.
 */
async function discoverUpstream({ env = process.env, platform = process.platform } = {}) {
  const candidates = []
  const seen = new Set()
  const add = (port) => {
    if (!Number.isInteger(port) || port <= 0 || seen.has(port)) return
    seen.add(port)
    candidates.push(port)
  }

  // The known port first: on the usual machine it answers immediately and the
  // scan never has to consult the process table at all. Skipped entirely when
  // discovery is disabled, so the escape hatch really does mean "do not probe".
  if (env.DSH_TUNNEL_DISABLE_DISCOVERY !== '1') {
    add(DSH_DEFAULT_PORT)
    for (const port of candidateHarnessPorts({ env, platform })) add(port)
  }

  for (const port of candidates) {
    const origin = `http://127.0.0.1:${port}`
    // eslint-disable-next-line no-await-in-loop -- ordered by preference, not speed
    if (await probeHarness(origin)) return { origin, port, discovered: true }
  }

  return { origin: DEFAULT_UPSTREAM_URL, port: null, discovered: false }
}

/**
 * Resolve the upstream the app should dial, including auto-discovery.
 *
 * An explicit flag or environment value always wins and is never re-resolved,
 * so a deliberate choice cannot be silently overridden by a stray local port.
 */
async function resolveUpstreamWithDiscovery(argv = process.argv, env = process.env) {
  const explicit = readArgument('--upstream', argv) || env.DSH_UPSTREAM_URL
  if (explicit) {
    return { origin: normalizeUpstream(explicit), port: null, discovered: false, source: 'explicit' }
  }
  const found = await discoverUpstream({ env })
  return found.discovered
    ? { ...found, source: 'discovered' }
    : { ...found, source: 'default' }
}

module.exports = {
  DEFAULT_UPSTREAM_URL,
  DSH_DEFAULT_PORT,
  readArgument,
  normalizeUpstream,
  resolveUpstream,
  resolveUpstreamWithDiscovery,
  resolveHostname,
  discoverUpstream,
  candidateHarnessPorts,
  probeHarness
}
