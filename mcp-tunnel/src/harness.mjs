// Launch a DeepSeek Harness web instance owned by this MCP server and capture
// the authenticated URL it reports.
//
// Why this exists: the harness rejects even loopback requests without auth
// (`GET /` -> 401). It mints a startup token and hands the authenticated URL to
// whichever process spawned it, so the only reliable way to obtain that token
// without touching an existing instance is to be the parent process.
//
// `dsh-desktop-host` sends `{ type: 'ready', url }` over the Node IPC channel
// when it is spawned with an 'ipc' stdio slot, and it also prints
// `dsh web: <authenticated url>` on stdout. We accept either.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { statePaths } from './paths.mjs'

/** Candidate DSH installations, most specific first. */
export function dshInstallCandidates(env = process.env) {
  const candidates = []
  const explicit = nonEmpty(env.DSH_TUNNEL_DSH_ROOT)
  if (explicit) candidates.push(explicit)

  const drives = ['E:', 'C:', 'D:']
  for (const drive of drives) {
    candidates.push(`${drive}\\DSH`)
    candidates.push(`${drive}\\Deepseek harness`)
  }
  const localAppData = env.LOCALAPPDATA
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Programs', 'DeepSeek Harness Desktop'))
  }
  return candidates
}

/** Resolve the Electron executable + host entry for a DSH install. */
export function resolveHarnessLauncher(env = process.env) {
  for (const root of dshInstallCandidates(env)) {
    const exe = path.join(root, 'DeepSeek Harness.exe')
    const exeAlt = path.join(root, 'DeepSeek Harness Desktop.exe')
    const asar = path.join(root, 'resources', 'app.asar')
    if (!existsSync(asar)) continue
    const executable = existsSync(exe) ? exe : (existsSync(exeAlt) ? exeAlt : null)
    if (!executable) continue
    return { root, executable, asar }
  }
  return null
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** Where the captured token is cached, so a restart can reuse it. */
export function harnessTokenPath(env = process.env) {
  return path.join(statePaths(env).root, 'harness.json')
}

export function readCachedHarness(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(harnessTokenPath(env), 'utf8'))
    if (typeof parsed?.url === 'string' && parsed.url.length > 0) return parsed
  } catch {
    // no cache
  }
  return null
}

export function writeCachedHarness(record, env = process.env) {
  const file = harnessTokenPath(env)
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
  return file
}

/**
 * Pull the authenticated URL out of harness output.
 * The URL carries the one-time token as a query parameter.
 */
export function extractAuthenticatedUrl(text) {
  const matches = String(text ?? '').matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_\-]{8,})/g)
  for (const match of matches) {
    return { url: match[0], port: Number(match[1]), token: match[2] }
  }
  return null
}

export class HarnessLauncher {
  constructor(options = {}) {
    this.env = options.env ?? process.env
    this.log = options.log ?? (() => {})
    this.child = null
    this.info = null
    this.starting = null
    this.output = []
  }

  status() {
    const launcher = resolveHarnessLauncher(this.env)
    const cached = readCachedHarness(this.env)
    const running = this.child !== null && this.child.exitCode === null && this.child.signalCode === null
    return {
      launcher,
      managed: running,
      pid: running ? this.child.pid : null,
      info: this.info,
      cached,
      recentOutput: this.output.slice(-30),
    }
  }

  /** Start a harness and resolve once its authenticated URL is known. */
  async start(options = {}) {
    if (this.starting) return this.starting
    this.starting = this.#start(options).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async #start({ timeoutMs = 180_000 } = {}) {
    const launcher = resolveHarnessLauncher(this.env)
    if (!launcher) {
      const error = new Error(
        'Could not find a DeepSeek Harness installation (looked for resources/app.asar under common paths). ' +
        'Set DSH_TUNNEL_DSH_ROOT to the install directory.',
      )
      error.code = 'DSH_NOT_FOUND'
      throw error
    }
    const hostEntry = `${launcher.asar}\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js`
    const dshRoot = `${launcher.asar}\\dsh`
    const profileDir = this.env.DSH_PROFILE_DIR ?? path.join(this.env.DSH_HOME ?? '', 'profiles', 'desktop')
    const runtimeDir = path.join(launcher.root, 'resources', 'runtime', 'primary-runtime')

    const args = [
      '--expose-internals',
      hostEntry,
      dshRoot,
      profileDir,
      runtimeDir,
      path.join(runtimeDir, 'pnpm', 'bin', 'pnpm.mjs'),
      path.join(runtimeDir, 'bin'),
    ]

    this.log(`Starting harness: ${launcher.executable} ${args.join(' ')}`)

    const child = spawn(launcher.executable, args, {
      windowsHide: true,
      shell: false,
      // 'ipc' makes the host send { type: 'ready', url }; stdout is a fallback.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...this.env },
    })
    this.child = child
    this.output = []

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }

      const capture = (chunk) => {
        const text = chunk.toString('utf8')
        this.output.push(...text.split(/\r?\n/).filter((line) => line.trim().length > 0))
        if (this.output.length > 400) this.output.splice(0, this.output.length - 400)
        const found = extractAuthenticatedUrl(text)
        if (!found) return
        this.info = { ...found, pid: child.pid, startedAt: new Date().toISOString(), installRoot: launcher.root }
        writeCachedHarness(this.info, this.env)
        this.log(`Harness ready at ${found.url} (port ${found.port})`)
        finish(null, this.info)
      }

      child.stdout?.on('data', capture)
      child.stderr?.on('data', capture)

      child.on('message', (message) => {
        if (message?.type === 'ready' && typeof message.url === 'string') {
          const found = extractAuthenticatedUrl(message.url)
          const info = found ?? { url: message.url, port: null, token: null }
          this.info = { ...info, pid: child.pid, startedAt: new Date().toISOString(), installRoot: launcher.root }
          writeCachedHarness(this.info, this.env)
          this.log(`Harness ready via IPC at ${info.url}`)
          finish(null, this.info)
        }
      })

      child.once('error', (error) => finish(error))
      child.once('exit', (code) => {
        this.child = null
        finish(new Error(
          `The harness process exited before reporting a URL (code ${code ?? 'null'}).\n` +
          this.output.slice(-8).join('\n'),
        ))
      })

      const timer = setTimeout(() => {
        const tail = this.output.slice(-8).join('\n')
        finish(new Error(`Timed out waiting for the harness to report its URL.\n${tail}`))
      }, timeoutMs)
    })
  }

  /** Stop a harness we started. Never touches one we did not spawn. */
  async stop() {
    const child = this.child
    this.child = null
    if (child === null || child.exitCode !== null || child.signalCode !== null) return { stopped: false }
    await new Promise((resolve) => {
      child.once('exit', resolve)
      try {
        child.kill('SIGTERM')
      } catch {
        resolve()
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
        resolve()
      }, 8_000).unref?.()
    })
    this.info = null
    return { stopped: true }
  }
}
