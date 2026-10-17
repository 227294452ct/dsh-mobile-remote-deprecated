// cloudflared tunnel lifecycle: named tunnels (stable hostname, the whole point
// of this bridge) plus an explicitly-flagged quick tunnel fallback.

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { cfargotunnelHostname, QUICK_TUNNEL_PROVIDER, renderNamedTunnelConfig, resolveCloudflared, resolveTunnelConfig } from './config.mjs'
import { statePaths, expandHome } from './paths.mjs'

export const TUNNEL_MODE_NAMED = 'named'
export const TUNNEL_MODE_QUICK = 'quick'
export const NAMED_TUNNEL_PROVIDER = 'Cloudflare Named Tunnel'

const START_TIMEOUT_MS = 45_000
const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/gi

/** Backoff for quick-tunnel restarts; kept from the original desktop gateway. */
export function tunnelRetryDelayMs(failedAttempts) {
  const attempt = Math.max(1, Number(failedAttempts) || 1)
  return Math.min(30_000, 1_500 * 2 ** (attempt - 1))
}

/** Pull the first usable quick-tunnel URL out of cloudflared output. */
export function extractQuickTunnelUrl(output) {
  const matches = String(output ?? '').matchAll(QUICK_URL_RE)
  for (const match of matches) {
    const value = match[0]
    if (value !== 'https://api.trycloudflare.com') return value
  }
  return null
}

export function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The last line of cloudflared output that carries an actual reason. Used so a
 * failed start reports "Unauthorized" or "Tunnel not found" instead of only an
 * exit code the user cannot act on.
 */
export function lastMeaningfulLine(output) {
  const lines = String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  for (let index = lines.length - 1; index >= 0 && index >= lines.length - 12; index -= 1) {
    const line = lines[index]
    if (/^(ERR|FTL|WRN)\b/i.test(line)) return line.replace(/\s+/g, ' ').slice(0, 300)
  }
  const tail = lines[lines.length - 1]
  return tail ? tail.replace(/\s+/g, ' ').slice(0, 300) : ''
}

export function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, filePath)
}

/** Non-destructive liveness probe for a pid we may not own. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else.
    return error?.code === 'EPERM'
  }
}

export class TunnelManager {
  constructor(options = {}) {
    this.env = options.env ?? process.env
    this.paths = statePaths(this.env)
    this.log = options.log ?? (() => {})
    this.settings = this.loadSettings()
    this.child = null
    this.mode = null
    this.provider = null
    this.state = 'stopped'
    this.error = ''
    this.publicUrl = null
    this.startedAt = null
    this.lastExit = null
    this.outputTail = []
    this.binary = null
    this.pid = null
    this.quickUrl = null
  }

  loadSettings() {
    const stored = readJsonFile(this.paths.settingsFile) ?? {}
    return {
      cloudflaredPath: stored.cloudflaredPath ?? null,
      tunnelName: stored.tunnelName ?? null,
      tunnelId: stored.tunnelId ?? null,
      hostname: stored.hostname ?? null,
      credentialsFile: stored.credentialsFile ?? null,
      hostnames: Array.isArray(stored.hostnames) ? stored.hostnames : [],
      gatewayPort: Number.isInteger(stored.gatewayPort) ? stored.gatewayPort : null,
      origin: typeof stored.origin === 'string' ? stored.origin : null,
      mode: stored.mode === TUNNEL_MODE_QUICK ? TUNNEL_MODE_QUICK : TUNNEL_MODE_NAMED,
    }
  }

  saveSettings(patch = {}) {
    this.settings = { ...this.settings, ...patch }
    writeJsonAtomic(this.paths.settingsFile, this.settings)
    return this.settings
  }

  resolveBinary() {
    return resolveCloudflared(this.settings.cloudflaredPath, this.env)
  }

  resolvedConfig() {
    return resolveTunnelConfig(this.settings, this.env)
  }

  /** Everything the model needs to describe the current tunnel situation. */
  status(options = {}) {
    const binary = this.resolveBinary()
    const config = this.resolvedConfig()
    const ownerPid = this.pid ?? readPidFile(this.paths.pidFile)
    const tracked = this.child !== null && this.child.exitCode === null && this.child.signalCode === null
    const alive = tracked || isProcessAlive(ownerPid)
    const effectiveState = alive
      ? (this.state === 'stopped' ? 'running (adopted)' : this.state)
      : (this.state === 'starting' ? 'failed' : this.state)

    const url = this.publicUrl ?? latestUrlFromStatusFile(this.paths.statusFile) ?? (config.hostname ? `https://${config.hostname}` : null)

    // "stable" answers one question: can the phone reach this address right now?
    // It must be false when nothing is running and false when a named tunnel
    // failed, or the flag would recreate the original "looks connected but is
    // broken" failure inside the tool that exists to prevent it.
    const runningNamed = this.mode === TUNNEL_MODE_NAMED && effectiveState === 'running'
    const stable = runningNamed
    // The hostname itself is permanent even while the tunnel is stopped, which
    // is what makes a restart reuse it; that is reported separately.
    const addressPermanent = this.mode === TUNNEL_MODE_NAMED && config.tunnelId !== null && config.hostname !== null
    const provider = this.provider
      ?? (this.mode === TUNNEL_MODE_QUICK ? QUICK_TUNNEL_PROVIDER : (this.mode === TUNNEL_MODE_NAMED ? NAMED_TUNNEL_PROVIDER : null))

    return {
      state: effectiveState,
      stable,
      addressPermanent,
      mode: this.mode ?? this.settings.mode,
      provider,
      // A configured-but-not-running permanent hostname, so callers can tell
      // "nothing set up" apart from "set up but not started".
      configuredPublicUrl: config.hostname ? `https://${config.hostname}` : null,
      publicUrl: url,
      hostname: config.hostname,
      tunnelId: config.tunnelId,
      tunnelName: config.tunnelName,
      pid: alive ? ownerPid : null,
      startedAt: this.startedAt,
      lastExit: this.lastExit,
      error: this.error || null,
      binary,
      binaryPresent: binary.source === 'path' ? null : existsSync(binary.path),
      loggedIn: config.loggedIn,
      configFile: this.paths.configFile,
      credentialsFile: config.credentialsFile,
      localTunnels: config.localTunnels.map((entry) => ({ id: entry.id, name: entry.name, credentialsFile: entry.credentialsFile })),
      connectorHostname: cfargotunnelHostname(config.tunnelId),
      quickUrl: this.quickUrl,
      recentOutput: options.includeOutput ? this.outputTail.slice(-40) : undefined,
    }
  }

  /** Persist a snapshot the Desktop app (and humans) can read at any time. */
  writeStatusFile(extra = {}) {
    const snapshot = {
      updatedAt: new Date().toISOString(),
      ...this.status(),
      ...extra,
    }
    delete snapshot.recentOutput
    writeJsonAtomic(this.paths.statusFile, snapshot)
    return snapshot
  }

  appendOutput(line) {
    const text = String(line).trim()
    if (text.length === 0) return
    this.outputTail.push(text)
    if (this.outputTail.length > 200) this.outputTail.splice(0, this.outputTail.length - 200)
  }

  async startNamed(options = {}) {
    const binary = this.resolveBinary()
    if (binary.source !== 'path' && !existsSync(binary.path)) {
      throw new Error(`cloudflared not found at ${binary.path}. Install cloudflared or set cloudflaredPath.`)
    }

    const origin = options.origin ?? this.settings.origin ?? null
    if (!origin) throw new Error('A local origin is required, e.g. http://127.0.0.1:52231.')

    const config = this.resolvedConfig()
    const hostname = options.hostname ?? config.hostname
    const tunnelId = options.tunnelId ?? config.tunnelId
    const credentialsFile = options.credentialsFile ?? config.credentialsFile

    const missing = []
    if (!tunnelId) missing.push('tunnelId (or a named tunnel in ~/.cloudflared)')
    if (!credentialsFile) missing.push('credentialsFile')
    if (!hostname) missing.push('hostname')
    if (missing.length > 0) {
      const error = new Error(
        `Named tunnel is not configured yet; missing ${missing.join(', ')}. ` +
        'Run the one-time Cloudflare setup, then call tunnel_configure.',
      )
      error.code = 'TUNNEL_NOT_CONFIGURED'
      throw error
    }

    mkdirSync(this.paths.root, { recursive: true })
    writeFileSync(
      this.paths.configFile,
      renderNamedTunnelConfig({ tunnelId, credentialsFile, hostname, origin }),
      'utf8',
    )

    this.saveSettings({ mode: TUNNEL_MODE_NAMED, origin, hostname, tunnelId, credentialsFile })
    const publicUrl = `https://${hostname}`

    const outcome = await this.spawnCloudflared({
      binary: binary.path,
      args: ['tunnel', '--no-autoupdate', '--config', this.paths.configFile, 'run'],
      mode: TUNNEL_MODE_NAMED,
      provider: NAMED_TUNNEL_PROVIDER,
      // A named tunnel has a deterministic hostname, so we can publish the URL
      // as soon as cloudflared registers a connection with the edge.
      settle: (text) => (/Registered tunnel connection/i.test(text) ? publicUrl : null),
      publicUrl,
    })
    return outcome
  }

  async startQuick(options = {}) {
    const binary = this.resolveBinary()
    if (binary.source !== 'path' && !existsSync(binary.path)) {
      throw new Error(`cloudflared not found at ${binary.path}. Install cloudflared or set cloudflaredPath.`)
    }
    const origin = options.origin ?? this.settings.origin ?? null
    if (!origin) throw new Error('A local origin is required, e.g. http://127.0.0.1:52231.')

    this.saveSettings({ mode: TUNNEL_MODE_QUICK, origin })
    return this.spawnCloudflared({
      binary: binary.path,
      args: ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', origin],
      mode: TUNNEL_MODE_QUICK,
      provider: QUICK_TUNNEL_PROVIDER,
      settle: (text) => extractQuickTunnelUrl(text),
      publicUrl: null,
    })
  }

  spawnCloudflared({ binary, args, mode, provider, settle, publicUrl }) {
    if (this.child !== null && this.child.exitCode === null && this.child.signalCode === null) {
      throw new Error(`A ${this.mode} tunnel is already running (pid ${this.child.pid}). Stop it first.`)
    }

    mkdirSync(this.paths.root, { recursive: true })

    this.mode = mode
    this.provider = provider
    this.state = 'starting'
    this.error = ''
    this.publicUrl = publicUrl ?? null
    this.quickUrl = null
    this.startedAt = new Date().toISOString()
    this.outputTail = []

    this.log(`Starting cloudflared (${mode}): ${binary} ${args.join(' ')}`)

    return new Promise((resolve, reject) => {
      let child
      try {
        // Pipes, not inherited file descriptors: this run must only ever match
        // its OWN output. Reading a shared log file would let a previous run's
        // URL satisfy this run's readiness check.
        child = spawn(binary, args, {
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        this.state = 'failed'
        this.error = error.message
        reject(error)
        return
      }

      this.child = child
      this.pid = child.pid ?? null
      if (this.pid) writeFileSync(this.paths.pidFile, String(this.pid), 'utf8')

      // Mirror this run's output to durable log files for later diagnosis.
      const outStream = createWriteStream(this.paths.logFile, { flags: 'a' })
      const errStream = createWriteStream(this.paths.errLogFile, { flags: 'a' })
      let ownOutput = ''
      const closeStreams = () => {
        outStream.end()
        errStream.end()
      }

      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString('utf8')
        outStream.write(text)
        ownOutput = `${ownOutput}${text}`.slice(-262_144)
        for (const line of text.split(/\r?\n/)) this.appendOutput(line)
        this.checkSettled()
      })
      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString('utf8')
        errStream.write(text)
        ownOutput = `${ownOutput}${text}`.slice(-262_144)
        for (const line of text.split(/\r?\n/)) this.appendOutput(line)
        this.checkSettled()
      })

      let settled = false
      const checkSettled = () => {
        if (settled) return
        const url = settle(ownOutput)
        if (!url) return
        settled = true
        this.state = 'running'
        this.error = ''
        if (mode === TUNNEL_MODE_QUICK) {
          this.quickUrl = url
          this.publicUrl = url
        }
        this.writeStatusFile()
        cleanup()
        this.log(`Tunnel up: ${url}`)
        resolve(this.status())
      }
      this.checkSettled = checkSettled

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        this.state = 'failed'
        const reason = lastMeaningfulLine(this.outputTail.join('\n'))
        this.error = `cloudflared did not establish a public address within ${START_TIMEOUT_MS / 1000}s.${reason ? ` ${reason}` : ''}`
        this.writeStatusFile()
        cleanup()
        try {
          child.kill()
        } catch {
          // ignore
        }
        reject(new Error(this.error))
      }, START_TIMEOUT_MS)
      timeout.unref?.()

      const cleanup = () => {
        clearTimeout(timeout)
        closeStreams()
      }

      child.once('error', (error) => {
        this.state = 'failed'
        this.error = error.message
        this.writeStatusFile()
        if (!settled) {
          settled = true
          cleanup()
          reject(error)
        }
      })

      child.once('exit', (code, signal) => {
        const wasSettled = settled
        this.lastExit = { code, signal, at: new Date().toISOString() }
        this.child = null
        if (!wasSettled) {
          settled = true
          this.state = 'failed'
          // Surface cloudflared's own reason: "Unauthorized", "Tunnel not found"
          // and a missing DNS route all need different fixes.
          const reason = lastMeaningfulLine(this.outputTail.join('\n'))
          this.error = `cloudflared exited before establishing the tunnel (code ${code ?? 'null'}).${reason ? ` ${reason}` : ''}`
          this.writeStatusFile()
          cleanup()
          reject(new Error(this.error))
          return
        }
        this.state = code === 0 ? 'stopped' : 'disconnected'
        this.error = code === 0 ? '' : `cloudflared exited (code ${code ?? 'null'}).`
        this.pid = null
        this.publicUrl = null
        this.writeStatusFile()
        cleanup()
        this.log(`cloudflared exited (code ${code ?? 'null'}); a named tunnel's hostname is unchanged, so a restart reuses it.`)
      })
    })
  }

  /** Stop the tunnel we own. Never kills a pid we did not start. */
  async stop(options = {}) {
    const child = this.child
    this.child = null
    if (child === null || child.exitCode !== null || child.signalCode !== null) {
      this.state = 'stopped'
      this.pid = null
      this.publicUrl = null
      try {
        writeFileSync(this.paths.pidFile, '', 'utf8')
      } catch {
        // ignore
      }
      if (!options.keepUrl) this.writeStatusFile()
      return this.status()
    }

    await new Promise((resolve) => {
      const done = () => resolve()
      child.once('exit', done)
      try {
        child.kill('SIGTERM')
      } catch {
        resolve()
      }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform === 'win32' && child.pid) {
            spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
          } else {
            try {
              child.kill('SIGKILL')
            } catch {
              // ignore
            }
          }
        }
        resolve()
      }, 4_000).unref?.()
    })

    this.state = 'stopped'
    this.pid = null
    this.publicUrl = options.keepUrl ? this.publicUrl : null
    this.writeStatusFile()
    return this.status()
  }
}

function readPidFile(filePath) {
  try {
    const value = Number.parseInt(readFileSync(filePath, 'utf8').trim(), 10)
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function latestUrlFromStatusFile(filePath) {
  const parsed = readJsonFile(filePath)
  return typeof parsed?.publicUrl === 'string' && parsed.publicUrl.length > 0 ? parsed.publicUrl : null
}

export function tailFile(filePath, maxBytes) {
  try {
    const buffer = readFileSync(filePath)
    if (buffer.length <= maxBytes) return buffer.toString('utf8')
    return buffer.subarray(buffer.length - maxBytes).toString('utf8')
  } catch {
    return ''
  }
}

export function ensureLogStreams(paths) {
  mkdirSync(paths.root, { recursive: true })
  return {
    out: createWriteStream(paths.logFile, { flags: 'a' }),
    err: createWriteStream(paths.errLogFile, { flags: 'a' }),
  }
}

export { expandHome }

/**
 * Start a named tunnel for one specific origin and return the live child, so a
 * standalone process can own the tunnel rather than the MCP server owning it.
 *
 * The gateway needs this because its loopback port changes on every restart: if
 * another component owned the tunnel, a gateway restart would leave the tunnel
 * pointing at a dead port.
 */
export function startNamedTunnelProcess({ binary, configFile, credentialsFile, tunnelId, hostname, origin, log = () => {} }) {
  mkdirSync(path.dirname(configFile), { recursive: true })
  writeFileSync(
    configFile,
    renderNamedTunnelConfig({ tunnelId, credentialsFile, hostname, origin }),
    'utf8',
  )
  const child = spawn(binary, ['tunnel', '--no-autoupdate', '--config', configFile, 'run'], {
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: false,
  })
  log(`cloudflared started (pid ${child.pid}) for ${origin} -> https://${hostname}`)
  return child
}
