// Tests for shared pairing codes and the mobile layout asset.
//
// Run: node --test test/pairing.test.mjs

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { MOBILE_LAYOUT_SCRIPT } from '../src/mobile-compat.mjs'
import { codeFromQuery, consumePairingCode, createPairingCode, PAIRING_TTL_MS, pairingFilePath, pairingUrl, pendingPairings } from '../src/pairing.mjs'

function isolatedEnv() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-pairing-'))
  return { env: { DSH_TUNNEL_HOME: root }, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('a created code is pending and consumable exactly once', () => {
  const { env, cleanup } = isolatedEnv()
  try {
    const created = createPairingCode(env)
    assert.match(created.code, /^\d{6}$/)
    assert.ok(created.expiresAt > Date.now())
    assert.equal(pendingPairings(env).length, 1)

    const first = consumePairingCode(created.code, env)
    assert.equal(first.ok, true)
    assert.equal(first.pairing.code, created.code)

    const second = consumePairingCode(created.code, env)
    assert.equal(second.ok, false)
    assert.match(second.reason, /already used|unknown/)
    assert.equal(pendingPairings(env).length, 0)
  } finally {
    cleanup()
  }
})

test('an unknown code is refused', () => {
  const { env, cleanup } = isolatedEnv()
  try {
    const result = consumePairingCode('000000', env)
    assert.equal(result.ok, false)
  } finally {
    cleanup()
  }
})

test('codes are written to a shared file both processes can read', () => {
  const { env, cleanup } = isolatedEnv()
  try {
    const created = createPairingCode(env)
    // A second caller with the same state home (a different process in reality)
    // must see and be able to consume the same code.
    const seen = pendingPairings(env)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].code, created.code)
    assert.ok(pairingFilePath(env).includes('pairings.json'))
  } finally {
    cleanup()
  }
})

test('a code already pending is never reissued', () => {
  const { env, cleanup } = isolatedEnv()
  try {
    const codes = new Set()
    for (let index = 0; index < 5; index += 1) codes.add(createPairingCode(env).code)
    assert.equal(codes.size, 5, 'codes must be unique while pending')
  } finally {
    cleanup()
  }
})

test('the consumed code is removed from the shared store', () => {
  const { env, cleanup } = isolatedEnv()
  try {
    const a = createPairingCode(env)
    const b = createPairingCode(env)
    consumePairingCode(a.code, env)
    const remaining = pendingPairings(env)
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].code, b.code)
  } finally {
    cleanup()
  }
})

test('a pairing code stays valid long enough to find your phone', () => {
  // A 5 minute window meant re-issuing codes while the user was still opening
  // the phone; the code is single-use, so a longer window costs little.
  assert.ok(PAIRING_TTL_MS >= 15 * 60_000, 'pairing codes should not expire within minutes')
  const { env, cleanup } = isolatedEnv()
  try {
    const created = createPairingCode(env)
    assert.ok(created.expiresAt - created.createdAt >= 15 * 60_000)
  } finally {
    cleanup()
  }
})

test('the pairing URL carries the code so a QR scan needs no typing', () => {
  assert.equal(pairingUrl('https://dsh.example.com', '123456'), 'https://dsh.example.com?code=123456')
  assert.equal(pairingUrl('https://dsh.example.com/', '000001'), 'https://dsh.example.com/?code=000001')
  // An existing query must be preserved rather than clobbered.
  assert.equal(pairingUrl('https://dsh.example.com/?a=1', '222222'), 'https://dsh.example.com/?a=1&code=222222')
})

test('a code can be read back out of the request URL', () => {
  assert.equal(codeFromQuery('https://dsh.example.com/?code=987654'), '987654')
  assert.equal(codeFromQuery('/?code=123456'), '123456')
  assert.equal(codeFromQuery('https://dsh.example.com/'), null)
  assert.equal(codeFromQuery('https://dsh.example.com/?code=not-a-code'), null)
  assert.equal(codeFromQuery('https://dsh.example.com/?code=1'), null, 'too short to be a code')
})

test('a scanned URL yields a code that actually pairs', () => {
  const { env, cleanup } = isolatedEnv()
  try {
    const created = createPairingCode(env)
    const url = pairingUrl('https://dsh.example.com', created.code)
    const scanned = codeFromQuery(url)
    assert.equal(scanned, created.code)
    const result = consumePairingCode(scanned, env)
    assert.equal(result.ok, true)
  } finally {
    cleanup()
  }
})

test('the mobile layout asset carries the real layout rules', () => {
  // These are the load-bearing selectors the Desktop version relied on.
  for (const marker of [
    'dsh-mobile-layout',
    'data-dsh-mobile-topbar',
    'data-dsh-mobile-composer-card',
    'data-dsh-mobile-hero-mark',
    'data-dsh-mobile-sidebar-column',
    'data-dsh-mobile-nav-open',
    'orientation: portrait',
  ]) {
    assert.ok(MOBILE_LAYOUT_SCRIPT.includes(marker), `mobile layout must keep ${marker}`)
  }
  // The shims must survive too, since older mobile WebViews need them.
  for (const shim of ['Object.hasOwn', 'structuredClone', 'randomUUID']) {
    assert.ok(MOBILE_LAYOUT_SCRIPT.includes(shim), `compat script must keep the ${shim} shim`)
  }
})

test('the mobile layout asset is valid JavaScript', async () => {
  // A syntax error here would silently break every phone page.
  const { Script } = await import('node:vm')
  assert.doesNotThrow(() => new Script(MOBILE_LAYOUT_SCRIPT))
})
