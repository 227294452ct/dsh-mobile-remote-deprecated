// Tests for the installable-app metadata (Add to Home Screen).
//
// Run: node --test test/pwa.test.mjs

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MOBILE_LAYOUT_SCRIPT } from '../src/mobile-compat.mjs'
import { APP_NAME, appIconPng, ICON_PATH, INSTALL_HEAD_TAGS, MANIFEST_PATH, webManifest } from '../src/pwa.mjs'

test('the icon is a valid 192x192 RGBA PNG', () => {
  const png = appIconPng(192)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature')
  assert.equal(png.readUInt32BE(16), 192, 'width')
  assert.equal(png.readUInt32BE(20), 192, 'height')
  assert.equal(png[24], 8, 'bit depth')
  assert.equal(png[25], 6, 'colour type RGBA')
  assert.ok(png.length > 500, 'a real image, not an empty placeholder')
})

test('the icon is deterministic', () => {
  assert.deepEqual(appIconPng(48), appIconPng(48))
})

test('the icon scales to the requested size', () => {
  const small = appIconPng(48)
  assert.equal(small.readUInt32BE(16), 48)
  assert.equal(small.readUInt32BE(20), 48)
})

test('the manifest makes the app installable and standalone', () => {
  const manifest = webManifest()
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.name, APP_NAME)
  assert.ok(manifest.icons.length >= 1)
  for (const icon of manifest.icons) {
    assert.equal(icon.src, ICON_PATH)
    assert.equal(icon.type, 'image/png')
  }
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'), 'Android needs a maskable icon')
})

test('the injected head tags cover both Android and iOS', () => {
  assert.ok(INSTALL_HEAD_TAGS.includes(MANIFEST_PATH), 'manifest link')
  assert.ok(INSTALL_HEAD_TAGS.includes('mobile-web-app-capable'), 'Android')
  assert.ok(INSTALL_HEAD_TAGS.includes('apple-mobile-web-app-capable'), 'iOS')
  assert.ok(INSTALL_HEAD_TAGS.includes('apple-touch-icon'), 'iOS icon')
  assert.ok(INSTALL_HEAD_TAGS.includes('theme-color'), 'browser chrome colour')
})

test('the install metadata is served from a stable, unauthenticated path', () => {
  // If these needed pairing, the browser could not offer install on first visit.
  assert.match(MANIFEST_PATH, /^\/_dsh_mobile\//)
  assert.match(ICON_PATH, /^\/_dsh_mobile\//)
})

test('every dvh viewport unit has a vh fallback for older iOS Safari', () => {
  // `dvh` is unsupported on iOS < 15.4; without a preceding fallback the layout
  // collapses to the wrong height there.
  const rules = MOBILE_LAYOUT_SCRIPT.split('\n').filter((line) => line.includes('100dvh'))
  assert.ok(rules.length > 0, 'the mobile layout is expected to use dvh')
  for (const rule of rules) {
    assert.match(
      rule,
      /100vh[^;]*!important;\s*[^;]*100dvh/,
      `a 100vh fallback must precede 100dvh in: ${rule.slice(0, 90)}`,
    )
  }
})
