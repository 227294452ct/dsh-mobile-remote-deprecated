// Filesystem layout for the DSH tunnel bridge.
//
// Two independent stores are used, deliberately:
//  * STATE_HOME  - this MCP server's own state (generated cloudflared config,
//                  logs, pid file, status snapshot). Always writable by us.
//  * Gateway / Desktop state - written by the Desktop app. Read-only for us.

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function expandHome(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

/** Root for this bridge's own state. Override with DSH_TUNNEL_HOME. */
export function stateHome(env = process.env) {
  const override = env.DSH_TUNNEL_HOME
  if (typeof override === 'string' && override.trim().length > 0) {
    return path.resolve(expandHome(override.trim()))
  }
  const dshHome = env.DSH_HOME && env.DSH_HOME.trim().length > 0
    ? path.resolve(expandHome(env.DSH_HOME.trim()))
    : path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'tunnel-mcp')
}

export function statePaths(env = process.env) {
  const root = stateHome(env)
  return {
    root,
    configFile: path.join(root, 'cloudflared.yml'),
    logFile: path.join(root, 'cloudflared.log'),
    errLogFile: path.join(root, 'cloudflared.err.log'),
    pidFile: path.join(root, 'tunnel.pid'),
    settingsFile: path.join(root, 'settings.json'),
    statusFile: path.join(root, 'status.json'),
  }
}

/**
 * cloudflared looks for credentials and its own default config in
 * `~/.cloudflared` (Windows included). `cloudflared tunnel login` puts
 * cert.pem there and `cloudflared tunnel create` puts `<uuid>.json` there.
 *
 * DSH_TUNNEL_CLOUDFLARED_HOME overrides that directory. It exists so tests can
 * run against an isolated directory instead of whatever tunnels the real
 * machine happens to have.
 */
export function cloudflaredHome(env = process.env) {
  const explicitHome = env.DSH_TUNNEL_CLOUDFLARED_HOME
  if (typeof explicitHome === 'string' && explicitHome.trim().length > 0) {
    return path.resolve(expandHome(explicitHome.trim()))
  }
  const override = env.TUNNEL_ORIGIN_CERT
  if (typeof override === 'string' && override.trim().length > 0) {
    return path.dirname(path.resolve(expandHome(override.trim())))
  }
  return path.join(os.homedir(), '.cloudflared')
}

/** The Desktop app's Electron userData directory, where it stores remote state. */
export function desktopUserDataCandidates(env = process.env) {
  const candidates = []
  const appData = env.APPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming') : null)
  if (appData) {
    candidates.push(path.join(appData, 'DeepSeek Harness Desktop'))
    candidates.push(path.join(appData, 'DeepSeek Harness'))
    // Electron falls back to the package.json "name" when no productName is
    // configured, which is what the existing locally-built Desktop app does.
    candidates.push(path.join(appData, 'deepseek-harness-desktop-local'))
    candidates.push(path.join(appData, 'deepseek-harness-desktop'))
  }
  const override = env.DSH_DESKTOP_USER_DATA
  if (typeof override === 'string' && override.trim().length > 0) {
    candidates.unshift(path.resolve(expandHome(override.trim())))
  }
  return candidates
}

export function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) return candidate
    } catch {
      // unreadable candidate: keep looking
    }
  }
  return null
}
