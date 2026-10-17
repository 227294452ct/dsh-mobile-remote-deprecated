// cloudflared configuration: locating the binary, reading the named-tunnel
// cofiguration the user created with `cloudflared tunnel create`, and writing a
// config file we own (never touching the user's ~/.cloudflared/config.yml).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { cloudflaredHome, expandHome, firstExisting } from './paths.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const QUICK_TUNNEL_PROVIDER = 'Cloudflare Quick Tunnel'

/**
 * Where cloudflared.exe lives. Preference order:
 *  1. explicit setting (DSH_TUNNEL_CLOUDFLARED)
 *  2. the copy bundled with DeepSeek Harness Desktop
 *  3. a `cloudflared` on PATH
 */
export function resolveCloudflared(explicit, env = process.env) {
  const candidates = []
  if (explicit) candidates.push(path.resolve(expandHome(explicit)))
  if (env.DSH_TUNNEL_CLOUDFLARED) candidates.push(path.resolve(expandHome(env.DSH_TUNNEL_CLOUDFLARED)))

  const programFiles = env.ProgramFiles || env.PROGRAMFILES
  if (programFiles) {
    candidates.push(path.join(programFiles, 'DeepSeek Harness Desktop', 'resources', 'cloudflared.exe'))
    candidates.push(path.join(programFiles, 'DeepSeek Harness', 'resources', 'cloudflared.exe'))
  }
  const localAppData = env.LOCALAPPDATA
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Programs', 'DeepSeek Harness Desktop', 'resources', 'cloudflared.exe'))
  }
  // Working copies of the Desktop project, in case the app was never installed.
  candidates.push('E:\\Deepseek harness\\zhuomianjiangou-0.1.5-rc.3\\vendor\\cloudflared.exe')
  candidates.push('E:\\Deepseek harness\\zhuomianjiangou\\vendor\\cloudflared.exe')

  const found = firstExisting(candidates)
  if (found) return { path: found, source: 'file' }
  return { path: 'cloudflared', source: 'path' }
}

/** Minimal reader for the subset of cloudflared config YAML we care about. */
export function parseCloudflaredConfig(text) {
  const result = { tunnel: null, credentialsFile: null, hostnames: [], configPath: null, raw: String(text ?? '') }
  if (typeof text !== 'string' || text.length === 0) return result

  const lines = text.split(/\r?\n/)
  let inIngress = false
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ')
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue

    // Top-level key (no indentation).
    const topMatch = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (topMatch && !/^\s/.test(line)) {
      const [, key, value] = topMatch
      const clean = stripQuotes(value.trim())
      if (key === 'tunnel') result.tunnel = clean
      else if (key === 'credentials-file') result.credentialsFile = clean
      inIngress = key === 'ingress'
      continue
    }

    if (inIngress) {
      const hostMatch = /^\s*-\s*hostname\s*:\s*(.+)$/.exec(line)
      if (hostMatch) {
        const hostname = stripQuotes(hostMatch[1].trim())
        if (hostname.length > 0 && hostname !== 'localhost') result.hostnames.push(hostname)
      }
      const credentialMatch = /^\s*credentials-file\s*:\s*(.+)$/.exec(line)
      if (credentialMatch) result.credentialsFile = stripQuotes(credentialMatch[1].trim())
    }
  }
  return result
}

function stripQuotes(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Read the default ~/.cloudflared/config.yml if the user relies on it. */
export function readDefaultCloudflaredConfig(env = process.env) {
  const candidates = []
  if (env.TUNNEL_ORIGIN_CERT) {
    const cert = path.resolve(expandHome(env.TUNNEL_ORIGIN_CERT))
    candidates.push(path.join(path.dirname(cert), 'config.yml'))
  }
  const home = cloudflaredHome(env)
  candidates.push(path.join(home, 'config.yml'))
  candidates.push(path.join(home, 'config.yaml'))

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      const parsed = parseCloudflaredConfig(readFileSync(candidate, 'utf8'))
      parsed.configPath = candidate
      return parsed
    } catch {
      // unreadable: try the next candidate
    }
  }
  return { tunnel: null, credentialsFile: null, hostnames: [], configPath: null, raw: '' }
}

/**
 * Enumerate `~/.cloudflared/*.json` credential files, which is how
 * `cloudflared tunnel create <name>` records a named tunnel. The file name is
 * the tunnel UUID and the payload carries the human name.
 */
export function listLocalTunnels(env = process.env) {
  const home = cloudflaredHome(env)
  let entries
  try {
    entries = readdirSync(home)
  } catch {
    return []
  }
  const tunnels = []
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.json')) continue
    const id = entry.slice(0, -'.json'.length)
    if (!UUID_RE.test(id)) continue
    const filePath = path.join(home, entry)
    let name = null
    let tunnelId = id
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      if (typeof parsed?.TunnelName === 'string') name = parsed.TunnelName
      if (typeof parsed?.TunnelID === 'string') tunnelId = parsed.TunnelID
    } catch {
      // Unreadable credential payload: still report the UUID-named file.
    }
    let mtimeMs = null
    try {
      mtimeMs = statSync(filePath).mtimeMs
    } catch {
      // ignore
    }
    tunnels.push({ id: tunnelId, name, credentialsFile: filePath, mtimeMs })
  }
  tunnels.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
  return tunnels
}

export function cloudflaredLoggedIn(env = process.env) {
  const home = cloudflaredHome(env)
  const candidates = [path.join(home, 'cert.pem')]
  if (env.TUNNEL_ORIGIN_CERT) candidates.unshift(path.resolve(expandHome(env.TUNNEL_ORIGIN_CERT)))
  return candidates.some((candidate) => {
    try {
      return existsSync(candidate)
    } catch {
      return false
    }
  })
}

/**
 * Resolve the effective named-tunnel configuration from explicit settings plus
 * whatever cloudflared already has on disk.
 */
export function resolveTunnelConfig(settings = {}, env = process.env) {
  const local = listLocalTunnels(env)
  const defaultConfig = readDefaultCloudflaredConfig(env)

  const explicitName = nonEmpty(settings.tunnelName)
  const explicitId = nonEmpty(settings.tunnelId)
  const explicitHostname = nonEmpty(settings.hostname)
  const explicitCredentials = nonEmpty(settings.credentialsFile)
    ? path.resolve(expandHome(nonEmpty(settings.credentialsFile)))
    : null

  let matched = null
  if (explicitId) matched = local.find((entry) => entry.id.toLowerCase() === explicitId.toLowerCase()) ?? null
  if (!matched && explicitName) matched = local.find((entry) => entry.name && entry.name.toLowerCase() === explicitName.toLowerCase()) ?? null
  if (!matched && explicitCredentials) matched = local.find((entry) => path.resolve(entry.credentialsFile) === explicitCredentials) ?? null
  if (!matched && defaultConfig.tunnel) {
    matched = local.find((entry) => entry.name && entry.name.toLowerCase() === defaultConfig.tunnel.toLowerCase()) ?? null
    if (!matched && UUID_RE.test(defaultConfig.tunnel)) {
      matched = local.find((entry) => entry.id.toLowerCase() === defaultConfig.tunnel.toLowerCase()) ?? null
    }
  }
  if (!matched && !explicitName && !explicitId && local.length === 1) matched = local[0]

  const tunnelId = explicitId || matched?.id || (defaultConfig.tunnel && UUID_RE.test(defaultConfig.tunnel) ? defaultConfig.tunnel : null) || null
  const tunnelName = explicitName || matched?.name || (defaultConfig.tunnel && !UUID_RE.test(defaultConfig.tunnel) ? defaultConfig.tunnel : null) || null
  const credentialsFile = explicitCredentials || matched?.credentialsFile || resolveCredentialsPath(defaultConfig.credentialsFile, env) || null

  const hostnames = []
  if (explicitHostname) hostnames.push(explicitHostname)
  for (const hostname of defaultConfig.hostnames) {
    if (!hostnames.includes(hostname)) hostnames.push(hostname)
  }
  if (Array.isArray(settings.hostnames)) {
    for (const hostname of settings.hostnames) {
      const clean = nonEmpty(hostname)
      if (clean && !hostnames.includes(clean)) hostnames.push(clean)
    }
  }

  return {
    tunnelId,
    tunnelName,
    credentialsFile,
    hostnames,
    hostname: hostnames[0] ?? null,
    localTunnels: local,
    defaultConfigPath: defaultConfig.configPath,
    defaultConfigTunnel: defaultConfig.tunnel,
    loggedIn: cloudflaredLoggedIn(env),
  }
}

function resolveCredentialsPath(value, env) {
  const clean = nonEmpty(value)
  if (!clean) return null
  const expanded = path.isAbsolute(clean) ? clean : path.join(cloudflaredHome(env), clean)
  return existsSync(expanded) ? expanded : expanded
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** Render the config file this bridge owns for a named tunnel. */
export function renderNamedTunnelConfig({ tunnelId, credentialsFile, hostname, origin }) {
  return [
    '# Generated by dsh-tunnel-mcp. Do not edit by hand; the MCP server rewrites it.',
    `tunnel: ${tunnelId}`,
    `credentials-file: ${yamlScalar(credentialsFile)}`,
    '',
    'ingress:',
    `  - hostname: ${yamlScalar(hostname)}`,
    `    service: ${yamlScalar(origin)}`,
    '  - service: http_status:404',
    '',
  ].join('\n')
}

function yamlScalar(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./\\:@-]+$/.test(text) && !text.includes(': ') && !text.endsWith(':')) return text
  return JSON.stringify(text)
}

/**
 * A named tunnel also has a stable connector address of the form
 * `<tunnel-uuid>.cfargotunnel.com`. It resolves only through the Cloudflare
 * edge, so it is a fallback identity for the tunnel, not the phone URL.
 */
export function cfargotunnelHostname(tunnelId) {
  if (!tunnelId || !UUID_RE.test(tunnelId)) return null
  return `${tunnelId}.cfargotunnel.com`
}

export { UUID_RE }
