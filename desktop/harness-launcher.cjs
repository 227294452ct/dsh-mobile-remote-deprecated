'use strict'

/**
 * Launch the harness that ships with this app, instead of attaching to whatever
 * install happens to be running.
 *
 * Why this matters more than it looks: the phone has to download the client
 * bundle before anything renders, and that bundle is whatever the harness profile
 * contains. A clean profile serves a single ~20 KB bundle; the user's everyday
 * install with every plugin enabled served 10 MB (5.3 MB gzipped). On a tunnel
 * link with seconds of latency the large one never finishes, and the phone shows
 * a blank page. Owning the runtime also means the token is printed to us, so no
 * memory scan is needed.
 *
 * The runtime layout matches the packaged layout the original build used:
 *
 *   <resources>/node-runtime/node.exe
 *   <resources>/runtime-flat/lib/bin.js
 *   <resources>/dsh-remote.patch.yml
 */

const { spawn } = require('node:child_process')
const { existsSync, mkdirSync } = require('node:fs')
const path = require('node:path')

const HARNESS_START_TIMEOUT_MS = 90_000

/**
 * Locate a bundled harness runtime, or null when this build has none.
 *
 * Packaged builds carry it in `resources`. During development the runtime lives in
 * an installed app, so an explicit override or the last-known install is used.
 */
function resolveHarnessRuntime({ resourcesPath = process.resourcesPath, env = process.env } = {}) {
  const candidates = [
    env.DSH_RUNTIME_RESOURCES,
    resourcesPath,
    env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness Desktop', 'resources')
      : null
  ].filter(Boolean)

  for (const root of candidates) {
    const nodeExecutable = path.join(root, 'node-runtime', 'node.exe')
    const cliEntry = path.join(root, 'runtime-flat', 'lib', 'bin.js')
    const patchPath = path.join(root, 'dsh-remote.patch.yml')
    if (existsSync(nodeExecutable) && existsSync(cliEntry)) {
      return { root, nodeExecutable, cliEntry, patchPath: existsSync(patchPath) ? patchPath : null }
    }
  }
  return null
}

/**
 * Start the bundled harness and return its origin plus auth token.
 *
 * `--port 0` lets the OS choose, and the token is read from the printed
 * `dsh web: <url>?token=` line — the harness never writes it to disk, so capturing
 * it here is both simpler and more reliable than recovering it from memory later.
 */
function startBundledHarness({ userDataPath, runtime = null, log = () => {}, env = process.env } = {}) {
  const resolved = runtime ?? resolveHarnessRuntime({ env })
  if (resolved === null) {
    return Promise.reject(new Error('No bundled harness runtime found.'))
  }

  const harnessHome = path.join(userDataPath, 'harness')
  const launchRoot = path.join(harnessHome, 'launch-root')
  mkdirSync(launchRoot, { recursive: true })

  const args = [resolved.cliEntry, 'web', '--no-open', '--port', '0']
  if (resolved.patchPath !== null) args.splice(2, 0, '--patch', resolved.patchPath)

  // A clean DSH_HOME is the point: it keeps the client bundle small and stops the
  // phone session from touching the user's everyday profile.
  const childEnv = { ...env, DSH_HOME: harnessHome }
  delete childEnv.ELECTRON_RUN_AS_NODE

  log(`Starting bundled harness: ${resolved.cliEntry} (DSH_HOME ${harnessHome})`)
  const child = spawn(resolved.nodeExecutable, args, {
    cwd: launchRoot,
    env: childEnv,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  return new Promise((resolve, reject) => {
    let settled = false
    let output = ''
    const stop = () => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      stop()
      reject(new Error(`Bundled harness did not report a URL within ${HARNESS_START_TIMEOUT_MS / 1000}s.\n${output.slice(-1500)}`))
    }, HARNESS_START_TIMEOUT_MS)

    const consume = (chunk) => {
      const text = chunk.toString('utf8')
      output = `${output}${text}`.slice(-16_384)
      // The URL carries the startup token; that is the only place it is exposed.
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(output)
      if (match === null || settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        origin: `http://127.0.0.1:${match[1]}`,
        port: Number(match[1]),
        token: match[2],
        child,
        stop
      })
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`Bundled harness exited with code ${code ?? 'unknown'}.\n${output.slice(-1500)}`))
    })
  })
}

module.exports = { resolveHarnessRuntime, startBundledHarness, HARNESS_START_TIMEOUT_MS }
