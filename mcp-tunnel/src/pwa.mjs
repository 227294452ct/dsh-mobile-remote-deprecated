// Installable-app metadata for the phone.
//
// The phone client is a web app, so the "download" story is Add to Home Screen.
// This module supplies everything that needs: a web app manifest and the iOS
// meta tags, so the shortcut opens without browser chrome and honours the notch.
//
// The icons are generated (a tiny PNG raster from an inline SVG is not safe to
// fabricate, so the PNG here is a real, minimal RGBA image built in code) and
// served from the gateway at a stable path.

import zlib from 'node:zlib'

export const MANIFEST_PATH = '/_dsh_mobile/manifest.webmanifest'
export const ICON_PATH = '/_dsh_mobile/icon.png'

export const APP_NAME = 'DeepSeek Harness'
export const SHORT_NAME = 'DSH'

/** Encode an RGBA pixel buffer as a PNG. No dependencies. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0)
    return Buffer.concat([length, typeAndData, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let crcTable = null
function crc32(buffer) {
  if (crcTable === null) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc ^ -1
}

/**
 * A deterministic app icon: a dark rounded square with a centred glyph block.
 * Drawn procedurally so the repository carries no binary asset.
 */
export function appIconPng(size = 192) {
  const rgba = Buffer.alloc(size * size * 4)
  const radius = size * 0.22
  const inset = size * 0.06

  const put = (x, y, r, g, b, a = 255) => {
    const index = (y * size + x) * 4
    rgba[index] = r
    rgba[index + 1] = g
    rgba[index + 2] = b
    rgba[index + 3] = a
  }

  // Rounded-square mask, anti-aliased against the corner radius.
  const inside = (x, y) => {
    const left = inset
    const top = inset
    const right = size - inset - 1
    const bottom = size - inset - 1
    if (x < left || x > right || y < top || y > bottom) return 0
    const cx = Math.min(Math.max(x, left + radius), right - radius)
    const cy = Math.min(Math.max(y, top + radius), bottom - radius)
    const dx = x - cx
    const dy = y - cy
    const distance = Math.hypot(dx, dy)
    if (distance <= radius - 1) return 1
    if (distance >= radius + 1) return 0
    return (radius + 1 - distance) / 2
  }

  // Background: deep indigo, glyph: near-white.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const coverage = inside(x, y)
      if (coverage <= 0) {
        put(x, y, 0, 0, 0, 0)
        continue
      }
      // A soft vertical gradient reads better at small sizes than flat colour.
      const t = y / size
      const r = Math.round(37 + 20 * (1 - t))
      const g = Math.round(99 + 20 * (1 - t))
      const b = Math.round(235 + 15 * (1 - t))
      put(x, y, r, g, b, Math.round(255 * coverage))
    }
  }

  // Glyph: a centred rounded bar plus a shorter bar, evoking a prompt line.
  const barWidth = Math.round(size * 0.46)
  const barHeight = Math.round(size * 0.115)
  const barX = Math.round((size - barWidth) / 2)
  const barRadius = barHeight / 2
  const bars = [
    { y: Math.round(size * 0.335), width: barWidth },
    { y: Math.round(size * 0.545), width: Math.round(barWidth * 0.62) },
  ]
  for (const bar of bars) {
    for (let y = bar.y; y < bar.y + barHeight && y < size; y += 1) {
      for (let x = barX; x < barX + bar.width && x < size; x += 1) {
        // Rounded ends.
        const localY = y - bar.y
        const atEnd = Math.min(Math.abs(x - barX), Math.abs(x - (barX + bar.width - 1)))
        const dy = Math.abs(localY - (barHeight - 1) / 2)
        const cornerLimit = Math.sqrt(Math.max(0, barRadius * barRadius - dy * dy))
        const shrink = barRadius - cornerLimit
        if (atEnd < shrink - 1) continue
        const alpha = Math.round(255 * Math.max(0, Math.min(1, atEnd - (shrink - 1))))
        if (alpha <= 0) continue
        put(x, y, 255, 255, 255, alpha)
      }
    }
  }

  return encodePng(size, size, rgba)
}

/** The web app manifest served to the browser. */
export function webManifest() {
  return {
    name: APP_NAME,
    short_name: SHORT_NAME,
    description: 'DeepSeek Harness on your phone',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#2563eb',
    icons: [
      { src: ICON_PATH, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: ICON_PATH, sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    ],
  }
}

/**
 * Head tags injected into proxied HTML so the page is installable.
 * Idempotent: the caller should add these only when absent.
 */
export const INSTALL_HEAD_TAGS = [
  `<link rel="manifest" href="${MANIFEST_PATH}">`,
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  `<meta name="apple-mobile-web-app-title" content="${APP_NAME}">`,
  `<link rel="apple-touch-icon" href="${ICON_PATH}">`,
  '<meta name="theme-color" content="#2563eb">',
].join('')
