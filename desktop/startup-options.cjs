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

module.exports = {
  DEFAULT_UPSTREAM_URL,
  readArgument,
  normalizeUpstream,
  resolveUpstream,
  resolveHostname
}
