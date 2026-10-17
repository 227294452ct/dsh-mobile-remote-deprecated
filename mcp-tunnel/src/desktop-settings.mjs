// Writes the permanent-tunnel settings into the Desktop app's state so the app
// reuses one hostname instead of asking Cloudflare for a new random one.
//
// The Desktop app owns this file. Merge semantics matter: `enabled` and any
// unknown future keys are preserved, and a `.bak` copy is taken once per day.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { desktopUserDataCandidates, firstExisting } from './paths.mjs'

export const REMOTE_SETTINGS_FILE = 'remote-settings.json'

export function desktopRemoteSettingsPath(env = process.env) {
  const dir = firstExisting(desktopUserDataCandidates(env))
  if (dir) return path.join(dir, REMOTE_SETTINGS_FILE)
  const appData = env.APPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming') : null)
  if (!appData) throw new Error('Cannot locate the Desktop app data folder (APPDATA is unset).')
  return path.join(appData, 'deepseek-harness-desktop-local', REMOTE_SETTINGS_FILE)
}

export function readDesktopRemoteSettings(env = process.env) {
  const file = desktopRemoteSettingsPath(env)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { file, exists: true, settings: parsed }
  } catch {
    return { file, exists: false, settings: {} }
  }
}

/**
 * The patch shape the patched Desktop build understands. The stable fact is the
 * hostname; the rest is context for the app to run cloudflared itself if it
 * prefers not to delegate the tunnel to this MCP server.
 */
export function buildDesktopRemoteSettingsPatch({ hostname, tunnelName, tunnelId, credentialsFile }) {
  return {
    tunnelMode: 'named',
    tunnelProvider: 'cloudflare-named',
    publicUrl: `https://${hostname}`,
    tunnelHostname: hostname,
    tunnelName: tunnelName ?? null,
    tunnelId: tunnelId ?? null,
    tunnelCredentialsFile: credentialsFile ?? null,
  }
}

/** Merge the patch into remote-settings.json, preserving everything else. */
export function writeDesktopRemoteSettings(patch, env = process.env) {
  const file = desktopRemoteSettingsPath(env)
  const existing = readDesktopRemoteSettings(env)
  const before = existing.settings ?? {}

  const merged = {
    version: typeof before.version === 'number' ? before.version : 1,
    enabled: before.enabled !== false,
    ...before,
    ...patch,
  }

  mkdirSync(path.dirname(file), { recursive: true })
  const backupFile = `${file}.bak-tunnel-mcp`
  let backup = null
  if (existing.exists && !existsSync(backupFile)) {
    copyFileSync(file, backupFile)
    backup = backupFile
  }

  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  renameSync(temp, file)

  return {
    file,
    backup,
    previous: { tunnelMode: before.tunnelMode ?? null, tunnelHostname: before.tunnelHostname ?? null },
    written: {
      tunnelMode: merged.tunnelMode,
      tunnelProvider: merged.tunnelProvider,
      tunnelHostname: merged.tunnelHostname,
      publicUrl: merged.publicUrl,
    },
    preserved: { enabled: merged.enabled, unknownKeys: Object.keys(before).filter((key) => !(key in patch)) },
  }
}
