// Tests for the reachability/diagnosis layer.
//
// Run: node --test test/probe.test.mjs

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyAddress, httpsProbe, inspectDomain, measureStability } from '../src/probe.mjs'

test('classifyAddress flags VPN fake-IP addresses', () => {
  const bench = classifyAddress('198.18.0.79')
  assert.equal(bench.family, 4)
  assert.ok(bench.notes.some((note) => note.includes('proxy/VPN')), 'benchmark range must be flagged as interception')
})

test('classifyAddress flags NAT64-synthesised IPv6', () => {
  const nat64 = classifyAddress('2001:2::61')
  assert.equal(nat64.family, 6)
  assert.ok(nat64.notes.some((note) => note.includes('NAT64')))
})

test('classifyAddress flags private IPv4 ranges', () => {
  for (const address of ['10.0.0.5', '192.168.1.10', '172.20.3.4', '127.0.0.1', '169.254.1.1', '100.64.0.1']) {
    const result = classifyAddress(address)
    assert.ok(result.notes.length > 0, `${address} should be flagged as non-routable`)
  }
})

test('classifyAddress accepts a normal public address silently', () => {
  const result = classifyAddress('104.16.132.229')
  assert.equal(result.family, 4)
  assert.deepEqual(result.notes, [])
})

test('httpsProbe reports a network error instead of throwing', async () => {
  // Port 1 on loopback is closed, so this must fail closed with a reason.
  const result = await httpsProbe('https://127.0.0.1:1/', { timeoutMs: 4_000 })
  assert.equal(result.ok, false)
  assert.ok(result.error, 'a failed probe must explain itself')
  assert.equal(typeof result.elapsedMs, 'number')
})

test('httpsProbe rejects an invalid URL without a request', async () => {
  const result = await httpsProbe('not a url')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'invalid URL')
})

test('measureStability aggregates failures into a verdict', async () => {
  const result = await measureStability('https://127.0.0.1:1/', { attempts: 2, intervalMs: 10, timeoutMs: 3_000 })
  assert.equal(result.attempts, 2)
  assert.equal(result.succeeded, 0)
  assert.equal(result.successRate, 0)
  assert.equal(result.verdict, 'unreachable: no probe succeeded, so the phone will not connect either')
  assert.ok(Object.keys(result.errors).length > 0, 'errors must be summarised')
})

test('inspectDomain fails closed for an empty domain', async () => {
  const result = await inspectDomain('')
  assert.equal(result.ready, false)
  assert.match(result.reason, /no domain/)
})

test('inspectDomain never claims readiness without a Cloudflare NS answer', async () => {
  // A domain that cannot exist must not be reported as tunnel-ready.
  const result = await inspectDomain('definitely-not-a-real-domain-zzz-98765.top')
  assert.equal(result.ready, false)
  assert.equal(result.onCloudflare, false)
  assert.ok(result.nextStep, 'a non-ready domain must say what to do next')
})
