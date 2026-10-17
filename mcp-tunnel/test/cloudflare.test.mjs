// Tests for the Cloudflare API layer.
//
// Run: node --test test/cloudflare.test.mjs

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listTunnels, readApiCredentials, verifyCredentials, verifyTunnel } from '../src/cloudflare.mjs'

const UUID = '9a1f0f4e-1111-2222-3333-444455556666'

test('readApiCredentials prefers an API token', () => {
  const creds = readApiCredentials({ CLOUDFLARE_API_TOKEN: '  tok_abc  ' })
  assert.deepEqual(creds, { kind: 'bearer', token: 'tok_abc' })
})

test('readApiCredentials accepts the legacy key plus email', () => {
  const creds = readApiCredentials({ CLOUDFLARE_API_KEY: 'key1', CLOUDFLARE_EMAIL: 'me@example.com' })
  assert.deepEqual(creds, { kind: 'key', token: 'key1', email: 'me@example.com' })
})

test('readApiCredentials rejects an incomplete key pair', () => {
  assert.equal(readApiCredentials({ CLOUDFLARE_API_KEY: 'key1' }), null)
  assert.equal(readApiCredentials({ CLOUDFLARE_EMAIL: 'me@example.com' }), null)
  assert.equal(readApiCredentials({}), null)
  assert.equal(readApiCredentials({ CLOUDFLARE_API_TOKEN: '   ' }), null)
})

test('everything degrades to "not configured" without a token', async () => {
  const env = {}
  const credentials = await verifyCredentials(env)
  assert.equal(credentials.configured, false)
  assert.match(credentials.hint, /CLOUDFLARE_API_TOKEN/)

  const verified = await verifyTunnel({ tunnelId: UUID, hostname: 'dsh.example.com' }, env)
  assert.equal(verified.verified, false)
  assert.equal(verified.configured, false)

  const tunnels = await listTunnels(env)
  assert.equal(tunnels.configured, false)
})

test('verifyTunnel reports honestly when no tunnel id is known', async () => {
  // With a token present but nothing to look up, the answer must not be a pass.
  const result = await verifyTunnel({ tunnelId: null, hostname: 'dsh.example.com' }, { CLOUDFLARE_API_TOKEN: 'tok' })
  assert.equal(result.verified, false)
  assert.match(result.reason, /No tunnel UUID/)
})

test('an invalid token is reported as invalid rather than as a pass', async () => {
  // A syntactically valid but unauthorized token must produce an explicit
  // failure, never a silent "configured" success.
  const result = await verifyCredentials({ CLOUDFLARE_API_TOKEN: 'definitely-not-a-real-token' })
  assert.equal(result.configured, true)
  assert.equal(result.valid, false)
  assert.ok(result.error, 'an unusable token must carry an error')
})
