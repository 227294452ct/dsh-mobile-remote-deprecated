// Windows auto-start for the detached gateway.
//
// Writes a small launcher into the user's Startup folder so the gateway (and its
// tunnel) is running after a reboot without anyone asking. The launcher is plain
// text and is regenerated on demand with the current harness port.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { statePaths } from './paths.mjs'

const LAUNCHER_NAME = 'dsh-mobile-gateway.cmd'

export function startupFolder(env = process.env) {
  const appData = env.APPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming') : null)
  if (!appData) return null
  return path.join(appData, 'Microsoft', 'Windows', 'Start', 'Programs', 'Startup')
}

export function launcherPath(env = process.env) {
  const folder = startupFolder(env)
  return folder === null ? null : path.join(folder, LAUNCHER_NAME)
}

/** Content of the Startup launcher. */
export function renderLauncher({ nodePath, gatewayScript, configPath, stateRoot }) {
  return [
    '@echo off',
    'rem DeepSeek Harness mobile gateway - auto-start (managed by dsh-tunnel-mcp).',
    'rem Remove this file to disable auto-start.',
    'set "DSH_TUNNEL_HOME=' + stateRoot + '"',
    'set "DSH_HOME=' + (process.env.DSH_HOME ?? '') + '"',
    'set "DSH_PROFILE_DIR=' + (process.env.DSH_PROFILE_DIR ?? '') + '"',
    `start "" /b "${nodePath}" "${gatewayScript}" start --config "${configPath}"`,
    '',
  ].join('\r\n')
}

export function installAutoStart({ nodePath, gatewayScript, configPath, env = process.env }) {
  const folder = startupFolder(env)
  const file = launcherPath(env)
  if (folder === null || file === null) {
    return { installed: false, reason: 'APPDATA is unset; cannot locate the Startup folder.' }
  }
  mkdirSync(folder, { recursive: true })
  const content = renderLauncher({ nodePath, gatewayScript, configPath, stateRoot: statePaths(env).root })
  writeFileSync(file, content, 'utf8')
  return { installed: true, file, content }
}

export function removeAutoStart(env = process.env) {
  const file = launcherPath(env)
  if (file === null || !existsSync(file)) return { removed: false, reason: 'launcher not present' }
  rmSync(file, { force: true })
  return { removed: true, file }
}

export function autoStartStatus(env = process.env) {
  const file = launcherPath(env)
  if (file === null) return { installed: false, reason: 'APPDATA is unset' }
  if (!existsSync(file)) return { installed: false, file }
  return { installed: true, file, content: readFileSync(file, 'utf8') }
}

export { LAUNCHER_NAME }
void os
