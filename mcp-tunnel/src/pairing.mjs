// Shared pairing codes.
//
// The code is created by the MCP server (`gateway_pair`) but consumed by the
// gateway's HTTP server, which after `gateway_detach` runs in a different
// process. A file is the smallest thing both processes can agree on.

import crypto from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { statePaths } from './paths.mjs'

// 30 minutes. The code is single-use and only valid until it is redeemed, so a
// longer window costs little and removes the "it expired while I was finding my
// phone" friction. It is still invalidated the moment it is consumed.
export const PAIRING_TTL_MS = 30 * 60_000

/** Build the pairing URL a QR code can encode, with the code already filled in. */
export function pairingUrl(baseUrl, code) {
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}code=${encodeURIComponent(code)}`
}

/** Extract a code from a request URL's query string, if present. */
export function codeFromQuery(url) {
  try {
    const code = new URL(url, 'http://127.0.0.1').searchParams.get('code')
    return typeof code === 'string' && /^\d{4,8}$/.test(code.trim()) ? code.trim() : null
  } catch {
    return null
  }
}

export function pairingFilePath(env = process.env) {
  return path.join(statePaths(env).root, 'pairings.json')
}

function readAll(env) {
  try {
    const parsed = JSON.parse(readFileSync(pairingFilePath(env), 'utf8'))
    return Array.isArray(parsed?.codes) ? parsed.codes : []
  } catch {
    return []
  }
}

function writeAll(codes, env) {
  const file = pairingFilePath(env)
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify({ version: 1, codes }, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

function liveOnly(codes) {
  const now = Date.now()
  return codes.filter((entry) => entry && typeof entry.code === 'string' && Number(entry.expiresAt) > now)
}

/** Create a code and persist it so any process can consume it. */
export function createPairingCode(env = process.env) {
  const codes = liveOnly(readAll(env))
  // Avoid handing out a code that is already pending.
  let code
  do {
    code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  } while (codes.some((entry) => entry.code === code))

  const entry = { code, createdAt: Date.now(), expiresAt: Date.now() + PAIRING_TTL_MS }
  writeAll([...codes, entry], env)
  return entry
}

/**
 * Consume a code exactly once. Returns the entry on success so the caller can
 * bind a device.
 */
export function consumePairingCode(code, env = process.env) {
  const wanted = String(code ?? '').trim()
  const codes = readAll(env)
  const match = codes.find((entry) => entry.code === wanted)

  // Drop expired codes regardless of the outcome.
  const remaining = liveOnly(codes).filter((entry) => entry.code !== wanted)
  if (remaining.length !== codes.length || match) writeAll(remaining, env)

  if (!match) return { ok: false, reason: 'unknown or already used code' }
  if (Number(match.expiresAt) <= Date.now()) return { ok: false, reason: 'code expired' }
  return { ok: true, pairing: match }
}

export function pendingPairings(env = process.env) {
  return liveOnly(readAll(env))
}

/**
 * Shared admin secret for local control endpoints.
 *
 * The revoke/pair control API lives on the gateway, which after `gateway_detach`
 * runs in another process. Loopback-only reachability is the primary control,
 * and this token keeps an unrelated local process from silently revoking a
 * phone. It is generated once and stored with the rest of the tunnel state.
 */
export function adminTokenFilePath(env = process.env) {
  return path.join(statePaths(env).root, 'admin-token')
}

export function ensureAdminToken(env = process.env) {
  const file = adminTokenFilePath(env)
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing.length >= 32) return existing
  } catch {
    // generate below
  }
  const token = crypto.randomBytes(32).toString('base64url')
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, token, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, file)
  return token
}

export function readAdminToken(env = process.env) {
  try {
    const token = readFileSync(adminTokenFilePath(env), 'utf8').trim()
    return token.length >= 32 ? token : null
  } catch {
    return null
  }
}
