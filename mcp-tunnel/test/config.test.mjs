// Unit tests for config parsing, URL extraction and the stable-hostname logic.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  cfargotunnelHostname,
  parseCloudflaredConfig,
  renderNamedTunnelConfig,
  resolveTunnelConfig,
} from '../src/config.mjs'
import { extractQuickTunnelUrl, tunnelRetryDelayMs } from '../src/tunnel.mjs'
import { buildDesktopRemoteSettingsPatch } from '../src/desktop-settings.mjs'

test('parseCloudflaredConfig reads tunnel, credentials and every hostname', () => {
  const parsed = parseCloudflaredConfig([
    '# a comment',
    'tunnel: 9a1f0f4e-1111-2222-3333-444455556666',
    'credentials-file: C:\\Users\\me\\.cloudflared\\9a1f0f4e-1111-2222-3333-444455556666.json',
    '',
    'ingress:',
    '  - hostname: dsh.example.com',
    '    service: http://127.0.0.1:52231',
    '  - hostname: alt.example.com',
    '    service: http://127.0.0.1:8080',
    '  - service: http_status:404',
  ].join('\n'))

  assert.equal(parsed.tunnel, '9a1f0f4e-1111-2222-3333-444455556666')
  assert.equal(parsed.credentialsFile, 'C:\\Users\\me\\.cloudflared\\9a1f0f4e-1111-2222-3333-444455556666.json')
  assert.deepEqual(parsed.hostnames, ['dsh.example.com', 'alt.example.com'])
})

test('parseCloudflaredConfig tolerates quoted values and CRLF', () => {
  const parsed = parseCloudflaredConfig('tunnel: "dsh-desktop"\r\ncredentials-file: "creds.json"\r\n')
  assert.equal(parsed.tunnel, 'dsh-desktop')
  assert.equal(parsed.credentialsFile, 'creds.json')
})

test('renderNamedTunnelConfig emits a resolvable ingress with a catch-all', () => {
  const yaml = renderNamedTunnelConfig({
    tunnelId: '9a1f0f4e-1111-2222-3333-444455556666',
    credentialsFile: 'C:\\Users\\me\\.cloudflared\\creds.json',
    hostname: 'dsh.example.com',
    origin: 'http://127.0.0.1:52231',
  })
  assert.match(yaml, /^tunnel: 9a1f0f4e-1111-2222-3333-444455556666$/m)
  assert.match(yaml, /- hostname: dsh\.example\.com/)
  assert.match(yaml, /service: http:\/\/127\.0\.0\.1:52231/)
  assert.match(yaml, /- service: http_status:404/)
  // Round-trips through our own parser.
  const parsed = parseCloudflaredConfig(yaml)
  assert.equal(parsed.tunnel, '9a1f0f4e-1111-2222-3333-444455556666')
  assert.deepEqual(parsed.hostnames, ['dsh.example.com'])
})

test('renderNamedTunnelConfig quotes scalars that would break YAML', () => {
  const yaml = renderNamedTunnelConfig({
    tunnelId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    credentialsFile: 'C:\\odd path\\creds.json',
    hostname: 'dsh.example.com',
    origin: 'http://127.0.0.1:8080',
  })
  assert.match(yaml, /credentials-file: "C:\\\\odd path\\\\creds\.json"/)
})

test('extractQuickTunnelUrl ignores the Cloudflare API host itself', () => {
  assert.equal(extractQuickTunnelUrl('Post "https://api.trycloudflare.com/tunnel": EOF'), null)
  assert.equal(
    extractQuickTunnelUrl('request https://api.trycloudflare.com then https://cloud-birch-example.trycloudflare.com'),
    'https://cloud-birch-example.trycloudflare.com',
  )
  assert.equal(extractQuickTunnelUrl(''), null)
})

test('tunnelRetryDelayMs backs off and caps at 30s', () => {
  assert.equal(tunnelRetryDelayMs(1), 1_500)
  assert.equal(tunnelRetryDelayMs(2), 3_000)
  assert.equal(tunnelRetryDelayMs(99), 30_000)
  assert.equal(tunnelRetryDelayMs(0), 1_500)
})

test('cfargotunnelHostname only accepts real tunnel UUIDs', () => {
  assert.equal(
    cfargotunnelHostname('9a1f0f4e-1111-2222-3333-444455556666'),
    '9a1f0f4e-1111-2222-3333-444455556666.cfargotunnel.com',
  )
  assert.equal(cfargotunnelHostname('dsh-desktop'), null)
  assert.equal(cfargotunnelHostname(null), null)
})

test('resolveTunnelConfig prefers explicit settings and always yields a stable hostname', () => {
  const env = {
    DSH_HOME: 'C:\\temp\\dsh-test-home',
    DSH_TUNNEL_CLOUDFLARED_HOME: 'C:\\temp\\no-cloudflared-here',
    USERPROFILE: 'C:\\temp\\no-cloudflared-here',
  }
  const resolved = resolveTunnelConfig(
    {
      tunnelName: 'dsh-desktop',
      tunnelId: '9a1f0f4e-1111-2222-3333-444455556666',
      credentialsFile: 'C:\\temp\\no-cloudflared-here\\creds.json',
      hostname: 'dsh.example.com',
    },
    env,
  )
  assert.equal(resolved.tunnelId, '9a1f0f4e-1111-2222-3333-444455556666')
  assert.equal(resolved.tunnelName, 'dsh-desktop')
  assert.equal(resolved.hostname, 'dsh.example.com')
  assert.equal(resolved.credentialsFile, 'C:\\temp\\no-cloudflared-here\\creds.json')
})

test('resolveTunnelConfig reports nothing configured on a bare machine', () => {
  // DSH_TUNNEL_CLOUDFLARED_HOME points at a directory that does not exist, so
  // this stays deterministic even on a machine that has real tunnels set up.
  const env = {
    DSH_HOME: 'C:\\temp\\dsh-test-home',
    DSH_TUNNEL_CLOUDFLARED_HOME: 'C:\\temp\\definitely-no-cloudflared-dir',
    USERPROFILE: 'C:\\temp\\definitely-no-cloudflared',
    APPDATA: 'C:\\temp\\definitely-no-appdata',
  }
  const resolved = resolveTunnelConfig({}, env)
  assert.equal(resolved.tunnelId, null)
  assert.equal(resolved.hostname, null)
  assert.equal(resolved.hostnames.length, 0)
  assert.equal(resolved.loggedIn, false)
  assert.deepEqual(resolved.localTunnels, [])
})

test('desktop patch carries the permanent hostname and keeps merge semantics', () => {
  const patch = buildDesktopRemoteSettingsPatch({
    hostname: 'dsh.example.com',
    tunnelName: 'dsh-desktop',
    tunnelId: '9a1f0f4e-1111-2222-3333-444455556666',
    credentialsFile: 'C:\\Users\\me\\.cloudflared\\creds.json',
  })
  assert.equal(patch.tunnelMode, 'named')
  assert.equal(patch.publicUrl, 'https://dsh.example.com')
  assert.equal(patch.tunnelHostname, 'dsh.example.com')
  assert.equal(patch.tunnelId, '9a1f0f4e-1111-2222-3333-444455556666')
})
