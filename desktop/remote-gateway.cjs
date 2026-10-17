'use strict'

const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { constants: fsConstants, existsSync, mkdirSync, promises: fsPromises, readFileSync, readdirSync, renameSync, writeFileSync } = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const httpProxy = require('http-proxy')
const QRCode = require('qrcode')
const { WebSocket, WebSocketServer } = require('ws')

const API_PREFIX = '/_dsh_remote/v1'
const COOKIE_NAME = '__Host-dsh_remote'
const PAIRING_TTL_MS = 5 * 60_000
const CHALLENGE_TTL_MS = 60_000
const SESSION_TTL_MS = 60 * 60_000
const MAX_JSON_BYTES = 1024 * 1024
const TUNNEL_START_TIMEOUT_MS = 45_000
// How long the tunnel may have zero edge connections before it is restarted.
// Long enough to ride out a VPN/proxy blip and cloudflared's own reconnect, short
// enough that a phone user does not sit on a dead address.
const TUNNEL_STALE_MS = 90_000
const TUNNEL_RESTART_DELAY_MS = 2_000
const TUNNEL_RETRY_BASE_DELAY_MS = 1_500
const TUNNEL_RETRY_MAX_DELAY_MS = 30_000
const PUBLIC_TUNNEL_IDENTITY = '内置安全隧道'
const MOBILE_COMPAT_PATH = '/_dsh_remote/compat.js'

/**
 * Report a blank page's real cause instead of showing nothing.
 *
 * A white screen means the document loaded but the renderer never booted, and in
 * an Android WebView that failure is completely silent — no console, no way to
 * ask the user what happened. This catches script errors, unhandled rejections
 * and failed sub-resource loads, and paints them into the page so the user can
 * photograph them.
 *
 * It is deliberately dependency-free and idempotent, and it hides itself again as
 * soon as the app renders something real, so a healthy page never shows it.
 */
const BOOT_DIAGNOSTIC_SCRIPT = `<script>
(function () {
  var shown = false;
  function paint(title, detail) {
    try {
      if (shown || document.getElementById('__dsh_boot_diag')) return;
      if ((document.body && document.body.childElementCount > 0) === false) { /* still empty */ }
      shown = true;
      var id = '__dsh_boot_diag';
      var box = document.createElement('pre');
      box.id = id;
      box.style.cssText = 'position:fixed;z-index:2147483647;left:0;right:0;top:0;max-height:60vh;overflow:auto;margin:0;padding:12px;background:#1b1b1b;color:#ff8080;font:12px/1.5 monospace;white-space:pre-wrap;';
      box.textContent = '页面没能启动\\n\\n' + title + '\\n\\n' + detail;
      var attach = function () {
        if (document.body) { document.body.appendChild(box); }
        else { document.addEventListener('DOMContentLoaded', function () { document.body && document.body.appendChild(box); }); }
      };
      attach();
    } catch (e) {}
  }
  window.addEventListener('error', function (event) {
    var target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      paint('资源加载失败', String(target.src || target.href));
      return;
    }
    paint('脚本错误', (event.message || '') + '\\n' + (event.filename || '') + ':' + (event.lineno || 0));
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    paint('未处理的 Promise 拒绝', (reason && (reason.stack || reason.message)) || String(reason));
  });
  // Only report a blank page: if the app rendered anything, say nothing.
  window.addEventListener('load', function () {
    setTimeout(function () {
      var root = document.getElementById('root') || document.body;
      var visible = root && (root.innerText || '').trim().length > 0;
      if (!visible) paint('页面加载完成但内容为空', 'WebView 可能不支持页面所需的特性，或后端未就绪。');
    }, 8000);
  });
})();
</script>`

const DESKTOP_SOCKET_PATH = `${API_PREFIX}/desktop/socket`
const DESKTOP_MESSAGE_BYTES = 4 * 1024
const DESKTOP_FRAME_INTERVAL_MS = Math.ceil(1000 / 10)
const DESKTOP_HEARTBEAT_TIMEOUT_MS = 15_000

function extractQuickTunnelUrl(output) {
  const matches = String(output).matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/gi)
  for (const match of matches) {
    const value = match[0].toLowerCase()
    if (value !== 'https://api.trycloudflare.com') return value
  }
  return null
}

const NAMED_TUNNEL_PROVIDER = 'Cloudflare Named Tunnel'
const QUICK_TUNNEL_PROVIDER = 'Cloudflare Quick Tunnel'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve a permanent named tunnel from the machine's own cloudflared state.
 *
 * A quick tunnel hands out a new random `*.trycloudflare.com` hostname on every
 * start, which is what forces the phone to re-pair. A named tunnel keeps one
 * hostname for the life of the tunnel because the hostname is a DNS record that
 * already points at the tunnel's UUID.
 *
 * Resolution order is explicit options, then the environment, then whatever
 * cloudflared already has on disk. Returns null when nothing is configured, so
 * the caller can fall back to a quick tunnel instead of failing.
 */
function resolveNamedTunnel(options = {}) {
  const home = options.cloudflaredHome
    || process.env.CLOUDFLARED_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.cloudflared')

  const hostname = (options.hostname || process.env.DSH_TUNNEL_HOSTNAME || '').trim().toLowerCase() || null
  let tunnelId = (options.tunnelId || process.env.DSH_TUNNEL_ID || '').trim() || null
  let credentialsFile = (options.credentialsFile || process.env.DSH_TUNNEL_CREDENTIALS || '').trim() || null

  // Discover the id from the credentials file name; that is the only thing
  // cloudflared guarantees to keep stable alongside the tunnel.
  if (tunnelId === null && credentialsFile === null && existsSync(home)) {
    try {
      const candidates = readdirSync(home)
        .filter((name) => UUID_RE.test(name.replace(/\.json$/i, '')) && name.toLowerCase().endsWith('.json'))
      if (candidates.length === 1) {
        tunnelId = candidates[0].replace(/\.json$/i, '')
        credentialsFile = path.join(home, candidates[0])
      }
    } catch {
      // Unreadable state is reported as "not configured" rather than thrown.
    }
  }

  if (tunnelId === null || credentialsFile === null) return null
  if (!existsSync(credentialsFile)) return null
  if (!UUID_RE.test(tunnelId)) return null
  // Without a hostname the tunnel has no stable public address to advertise.
  if (hostname === null) return null

  return { tunnelId, credentialsFile, hostname, provider: NAMED_TUNNEL_PROVIDER }
}

/** Render the cloudflared config that pins the permanent hostname to one origin. */
function renderNamedTunnelConfig({ tunnelId, credentialsFile, hostname, origin }) {
  return [
    '# Generated by DeepSeek Harness Remote. Do not edit by hand; the app rewrites it.',
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsFile}`,
    '',
    'ingress:',
    `  - hostname: ${hostname}`,
    `    service: ${origin}`,
    '  - service: http_status:404',
    '',
  ].join('\n')
}

/** The public URL a named tunnel serves, for status reporting and QR payloads. */
function namedTunnelUrl(hostname) {
  return `https://${hostname}`
}

function tunnelRetryDelayMs(failedAttempts) {
  const exponent = Math.max(0, Number(failedAttempts) - 1)
  return Math.min(TUNNEL_RETRY_MAX_DELAY_MS, TUNNEL_RETRY_BASE_DELAY_MS * (2 ** exponent))
}
const DESKTOP_MAX_BUFFERED_BYTES = 192 * 1024
const MOBILE_COMPAT_SCRIPT = `'use strict';
(() => {
  if (typeof Object.hasOwn !== 'function') {
    Object.defineProperty(Object, 'hasOwn', {
      configurable: true,
      writable: true,
      value(object, property) {
        return Object.prototype.hasOwnProperty.call(Object(object), property)
      }
    })
  }

  if (
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID !== 'function' &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      writable: true,
      value() {
        const bytes = new Uint8Array(16)
        globalThis.crypto.getRandomValues(bytes)
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
        return [
          hex.slice(0, 8),
          hex.slice(8, 12),
          hex.slice(12, 16),
          hex.slice(16, 20),
          hex.slice(20)
        ].join('-')
      }
    })
  }

  const defineAt = (prototype) => {
    if (!prototype || typeof prototype.at === 'function') return
    Object.defineProperty(prototype, 'at', {
      configurable: true,
      writable: true,
      value(index) {
        const length = Number(this.length) || 0
        let position = Number(index) || 0
        position = position < 0 ? Math.ceil(position) : Math.floor(position)
        if (position < 0) position += length
        if (position < 0 || position >= length) return undefined
        return this[position]
      }
    })
  }

  defineAt(Array.prototype)
  defineAt(String.prototype)
  ;[
    globalThis.Int8Array,
    globalThis.Uint8Array,
    globalThis.Uint8ClampedArray,
    globalThis.Int16Array,
    globalThis.Uint16Array,
    globalThis.Int32Array,
    globalThis.Uint32Array,
    globalThis.Float32Array,
    globalThis.Float64Array,
    globalThis.BigInt64Array,
    globalThis.BigUint64Array
  ].forEach(Type => {
    if (typeof Type === 'function') defineAt(Type.prototype)
  })

  if (typeof globalThis.structuredClone !== 'function') {
    const cloneValue = (value, seen) => {
      if (value === null || typeof value !== 'object') return value
      if (seen.has(value)) return seen.get(value)
      if (value instanceof Date) return new Date(value.getTime())
      if (value instanceof RegExp) return new RegExp(value.source, value.flags)
      if (value instanceof ArrayBuffer) return value.slice(0)
      if (ArrayBuffer.isView(value)) {
        if (value instanceof DataView) {
          return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
        }
        return new value.constructor(value)
      }
      if (value instanceof Map) {
        const output = new Map()
        seen.set(value, output)
        value.forEach((item, key) => output.set(cloneValue(key, seen), cloneValue(item, seen)))
        return output
      }
      if (value instanceof Set) {
        const output = new Set()
        seen.set(value, output)
        value.forEach(item => output.add(cloneValue(item, seen)))
        return output
      }
      const output = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))
      seen.set(value, output)
      Reflect.ownKeys(value).forEach(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor) return
        if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          descriptor.value = cloneValue(descriptor.value, seen)
        }
        Object.defineProperty(output, key, descriptor)
      })
      return output
    }
    Object.defineProperty(globalThis, 'structuredClone', {
      configurable: true,
      writable: true,
      value(value) {
        return cloneValue(value, new Map())
      }
    })
  }

  const MOBILE_LAYOUT_STYLE_ID = 'dsh-remote-mobile-layout'
  const mobileLayoutCss = [
    '[data-dsh-remote-sidebar-foot], [data-dsh-remote-sidebar-settings] { box-sizing: border-box !important; flex: 0 0 auto !important; height: auto !important; min-height: 94px !important; overflow: visible !important; }',
    '[data-dsh-remote-sidebar-foot] { display: flex !important; flex-direction: column !important; justify-content: flex-end !important; }',
    '[data-dsh-remote-sidebar-settings] { display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: flex-end !important; gap: 2px !important; }',
    '[data-dsh-remote-sidebar-column] { min-height: 0 !important; }',
    '[data-dsh-remote-desktop-entry-wrap] { box-sizing: border-box !important; flex: 0 0 40px !important; width: 100% !important; height: 40px !important; min-height: 40px !important; display: flex !important; align-items: center !important; justify-content: center !important; overflow: visible !important; }',
    '[data-dsh-remote-mobile-topbar] { display: none; }',
    '[data-dsh-remote-upload-controls] { display: none; }',
    '@media (max-width: 720px) and (orientation: portrait) {',
    '  html, body { width: 100%; max-width: 100vw; overflow-x: hidden; }',
    '  [data-dsh-remote-app-shell] { width: 100% !important; grid-template-columns: minmax(0, 1fr) !important; }',
    '  [data-dsh-remote-sidebar-column] { position: fixed !important; z-index: 9 !important; top: 56px !important; bottom: 0 !important; left: 0 !important; width: 64px !important; height: calc(100dvh - 56px) !important; min-height: 0 !important; max-height: calc(100dvh - 56px) !important; visibility: hidden !important; transform: translateX(-110%) !important; transition: none !important; background: rgba(248,250,252,.98) !important; box-shadow: 12px 0 30px rgba(15,23,42,.10) !important; }',
    '  html[data-dsh-mobile-nav-open] [data-dsh-remote-sidebar-viewport], html[data-dsh-mobile-settings-open] [data-dsh-remote-sidebar-viewport] { overflow: visible !important; }',
    '  html[data-dsh-mobile-nav-open] [data-dsh-remote-sidebar-viewport], html[data-dsh-mobile-settings-open] [data-dsh-remote-sidebar-viewport] { position: relative !important; z-index: 2147483000 !important; }',
    '  html[data-dsh-mobile-nav-open] [data-dsh-remote-sidebar-column], html[data-dsh-mobile-settings-open] [data-dsh-remote-sidebar-column] { visibility: visible !important; transform: translateX(0) !important; overflow: visible !important; }',
    '  html[data-dsh-mobile-nav-open] [data-dsh-remote-sidebar-column][data-dsh-remote-sidebar-expanded] { width: min(280px, calc(100vw - 24px)) !important; overflow: hidden !important; box-shadow: 16px 0 36px rgba(15,23,42,.14) !important; }',
    '  html[data-dsh-mobile-settings-open] [data-dsh-remote-sidebar-column] { z-index: 13 !important; width: 64px !important; transform: none !important; box-shadow: none !important; }',
    '  html[data-dsh-mobile-settings-open] [data-dsh-remote-sidebar-settings] [data-slot="sidebar.settings"] > [role="presentation"] { box-sizing: border-box !important; position: fixed !important; z-index: 11 !important; inset: 56px 0 auto 0 !important; width: 100vw !important; height: calc(100dvh - 56px) !important; display: flex !important; align-items: stretch !important; justify-content: stretch !important; visibility: visible !important; transform: none !important; overflow: hidden !important; background: #fff !important; }',
    '  html[data-dsh-mobile-settings-open] [data-dsh-remote-sidebar-settings] [role="dialog"] { box-sizing: border-box !important; width: 100% !important; min-width: 0 !important; max-width: none !important; height: 100% !important; min-height: 0 !important; max-height: none !important; margin: 0 !important; border-radius: 0 !important; visibility: visible !important; overflow: auto !important; }',
    '  [data-dsh-remote-mobile-topbar] { position: fixed; z-index: 2147483001; top: 0; left: 0; right: 0; box-sizing: border-box; height: 56px; display: grid; grid-template-columns: 44px minmax(0, 1fr) auto 44px; align-items: center; gap: 4px; padding: 6px 12px; background: rgba(255,255,255,.96); border-bottom: 1px solid rgba(148,163,184,.16); backdrop-filter: blur(16px); }',
    '  [data-dsh-remote-mobile-topbar] button { box-sizing: border-box !important; min-width: 0 !important; height: 44px !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; gap: 7px !important; padding: 0 8px !important; border: 0 !important; border-radius: 12px !important; background: transparent !important; color: #111827 !important; overflow: hidden !important; white-space: nowrap !important; text-overflow: ellipsis !important; }',
    '  [data-dsh-remote-mobile-topbar] button svg { flex: none !important; width: 23px !important; height: 23px !important; }',
    '  [data-dsh-mobile-action="menu"] { grid-column: 1; padding: 0 !important; }',
    '  [data-dsh-mobile-action="menu"] svg { width: 25px !important; height: 25px !important; }',
    '  [data-dsh-mobile-action="desktop"] { grid-column: 3; width: auto !important; padding-inline: 10px !important; font-size: 13px !important; font-weight: 600 !important; }',
    '  [data-dsh-mobile-action="desktop"] span { display: inline !important; }',
    '  [data-dsh-mobile-action="settings"] { grid-column: 4; padding: 0 !important; }',
    '  [data-dsh-remote-session-header] { min-width: 0 !important; padding: 8px 10px 0 !important; }',
    '  [data-dsh-remote-session-header] > div:first-child { min-width: 0 !important; gap: 6px !important; }',
    '  [data-dsh-remote-header-utilities] { min-width: 0 !important; max-width: 42vw !important; margin-left: 6px !important; gap: 4px !important; overflow-x: auto !important; overscroll-behavior-inline: contain; scrollbar-width: none; }',
    '  [data-dsh-remote-header-utilities]::-webkit-scrollbar { display: none; }',
    '  [data-dsh-remote-session-log] { min-width: 0 !important; max-width: 100% !important; min-height: 36px !important; padding-inline: 10px !important; }',
    '  [data-dsh-remote-session-header] [role="tablist"] { min-width: 0 !important; gap: 24px !important; padding-left: 4px !important; overflow-x: auto !important; scrollbar-width: none; }',
    '  [data-dsh-remote-session-header] [role="tablist"]::-webkit-scrollbar { display: none; }',
    '  [data-question-key], [data-plan-review-key] { box-sizing: border-box !important; width: 100% !important; max-width: 100% !important; min-width: 0 !important; padding: 6px 8px calc(10px + env(safe-area-inset-bottom)) !important; }',
    '  [data-question-key] > section, [data-plan-review-key] > section { box-sizing: border-box !important; width: 100% !important; max-width: 100% !important; min-width: 0 !important; border-radius: 14px !important; }',
    '  [data-question-key] > section > header { min-width: 0 !important; gap: 8px !important; padding: 12px 12px 0 14px !important; }',
    '  [data-question-key] > section > header > :first-child { min-width: 0 !important; }',
    '  [data-question-key] > section > header h2 { overflow-wrap: anywhere !important; word-break: break-word !important; }',
    '  [data-question-key] > section > [data-question-scroll] { min-width: 0 !important; }',
    '  [data-question-key] > section > [data-question-scroll] button { max-width: 100% !important; min-width: 0 !important; overflow-wrap: anywhere !important; }',
    '  [data-question-key] > section > footer { display: grid !important; grid-template-columns: auto minmax(0, 1fr) !important; align-items: center !important; gap: 8px !important; margin-top: 8px !important; padding: 8px 10px 2px !important; }',
    '  [data-question-key] > section > footer > :nth-child(2) { min-width: 0 !important; overflow-wrap: anywhere !important; }',
    '  [data-question-key] > section > footer > :last-child { grid-column: 1 / -1 !important; box-sizing: border-box !important; width: 100% !important; min-width: 0 !important; display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 8px !important; }',
    '  [data-question-key] > section > footer > :last-child > button { box-sizing: border-box !important; width: 100% !important; max-width: 100% !important; min-width: 0 !important; min-height: 42px !important; padding-inline: 10px !important; white-space: normal !important; }',
    '  [data-plan-review-key] > section > footer { align-items: stretch !important; flex-direction: column !important; gap: 8px !important; padding: 8px 12px 10px !important; }',
    '  [data-plan-review-key] > section > footer > :last-child { box-sizing: border-box !important; width: 100% !important; min-width: 0 !important; display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 8px !important; }',
    '  [data-plan-review-key] > section > footer > :last-child > button { box-sizing: border-box !important; width: 100% !important; max-width: 100% !important; min-width: 0 !important; min-height: 42px !important; white-space: normal !important; }',
    '  [data-dsh-remote-composer-stack], [data-dsh-remote-composer-root], [data-dsh-remote-composer-card], [data-dsh-remote-composer-row], [data-dsh-remote-composer-trailing] { box-sizing: border-box !important; min-width: 0 !important; max-width: 100% !important; }',
    '  [data-dsh-remote-composer-stack], [data-dsh-remote-composer-root] { width: 100% !important; }',
    '  [data-dsh-remote-composer-stack] { padding-inline: 0 !important; }',
    '  [data-dsh-remote-home-composer] { position: fixed !important; inset: 0 !important; box-sizing: border-box !important; height: 100dvh !important; display: flex !important; flex-direction: column !important; align-items: stretch !important; justify-content: flex-start !important; gap: 0 !important; padding: 56px 18px calc(18px + env(safe-area-inset-bottom)) !important; overflow: hidden !important; background: #fff !important; }',
    '  [data-dsh-remote-home-composer] > svg { display: none !important; }',
    '  [data-dsh-remote-composer-heading] { position: static !important; transform: none !important; flex: 0 0 auto !important; box-sizing: border-box !important; width: 100% !important; min-width: 0 !important; min-height: 0 !important; height: auto !important; max-height: 122px !important; margin-top: 78px !important; padding-inline: 0 !important; align-items: center !important; justify-content: center !important; }',
    '  [data-dsh-remote-hero-headline] { display: grid !important; grid-template-columns: auto auto !important; align-items: center !important; justify-content: center !important; column-gap: 12px !important; row-gap: 10px !important; width: 100% !important; min-width: 0 !important; font-size: clamp(25px, 7.5vw, 30px) !important; line-height: 1.2 !important; white-space: nowrap !important; }',
    '  [data-dsh-remote-hero-mark-wrap] { grid-column: 1 / 3 !important; grid-row: 1 !important; display: grid !important; place-items: center !important; width: 100% !important; height: 58px !important; margin: 0 !important; pointer-events: none !important; }',
    '  [data-dsh-remote-hero-headline] > [data-dsh-remote-hero-mark-wrap] + * { grid-column: 1 !important; grid-row: 2 !important; }',
    '  [data-dsh-remote-hero-headline] > [data-dsh-remote-hero-mark-wrap] + * + * { grid-column: 2 !important; grid-row: 2 !important; }',
    '  [data-dsh-remote-hero-mark-wrap] [data-dsh-remote-hero-mark] { display: contents !important; pointer-events: none !important; }',
    '  [data-dsh-remote-hero-mark-wrap] svg { display: block !important; width: 66px !important; height: auto !important; max-width: none !important; max-height: 58px !important; pointer-events: none !important; }',
    '  [data-dsh-remote-workspace-row] { position: static !important; transform: none !important; flex: 0 0 auto !important; box-sizing: border-box !important; width: min(100%, 276px) !important; min-height: 46px !important; margin: 28px auto 0 !important; padding: 4px 10px !important; display: flex !important; align-items: center !important; justify-content: center !important; gap: 0 !important; border: 1px solid #e2e8f0 !important; border-radius: 24px !important; background: rgba(255,255,255,.98) !important; }',
    '  [data-dsh-remote-workspace-row] > * { min-width: 0 !important; flex: 1 1 0 !important; justify-content: center !important; }',
    '  [data-dsh-remote-workspace-row] > * + * { border-left: 1px solid #e2e8f0 !important; }',
    '  [data-dsh-remote-composer-root] { padding-inline: 8px !important; }',
    '  [data-dsh-remote-home-composer] [data-dsh-remote-composer-root] { width: 100% !important; margin-top: auto !important; padding-inline: 0 !important; }',
    '  [data-dsh-remote-composer-card] { position: relative !important; overflow: visible !important; }',
    '  [data-dsh-remote-home-composer] [data-dsh-remote-composer-card] { height: 250px !important; min-height: 250px !important; max-height: 250px !important; display: flex !important; flex-direction: column !important; padding: 14px !important; border: 1px solid rgba(37,99,235,.24) !important; border-radius: 26px !important; background: rgba(255,255,255,.98) !important; box-shadow: 0 14px 34px rgba(37,99,235,.10) !important; }',
    '  [data-dsh-remote-composer-row], [data-dsh-remote-composer-trailing] { overflow: visible !important; }',
    '  [data-dsh-remote-home-composer] [data-dsh-remote-composer-row] { min-height: 82px !important; margin-top: auto !important; display: flex !important; flex-direction: column !important; justify-content: flex-end !important; gap: 14px !important; }',
    '  [data-dsh-remote-home-composer] [data-dsh-remote-composer-leading] { display: flex !important; align-items: center !important; gap: 8px !important; }',
    '  [data-dsh-remote-upload-controls] { display: inline-flex !important; align-items: center !important; gap: 6px !important; min-width: 0 !important; }',
    '  [data-dsh-remote-upload-controls] button { min-width: 0 !important; height: 34px !important; padding: 0 10px !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; gap: 5px !important; border: 1px solid rgba(37,99,235,.20) !important; border-radius: 10px !important; background: #f8fbff !important; color: #245ea9 !important; font: 600 12px/1 system-ui,sans-serif !important; white-space: nowrap !important; }',
    '  [data-dsh-remote-upload-controls] button svg { width: 16px !important; height: 16px !important; flex: none !important; }',
    '  [data-dsh-remote-composer-trailing] { display: grid !important; grid-template-columns: auto minmax(96px, 1fr) auto !important; align-items: center !important; gap: 6px !important; width: 100% !important; position: relative !important; }',
    '  [data-dsh-remote-home-composer] [data-dsh-remote-composer-trailing] { grid-template-columns: minmax(62px, auto) minmax(0, 1fr) 42px !important; gap: 8px !important; }',
    '  [data-dsh-remote-composer-trailing] > * { min-width: 0 !important; max-width: 100% !important; }',
    '  [data-dsh-remote-composer-trailing] button:not([data-dsh-remote-send]) { min-width: 0 !important; max-width: 100% !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }',
    '  [data-dsh-remote-composer-trailing] [role="menu"] { max-width: min(230px, calc(100vw - 80px)) !important; z-index: 2147483000 !important; }',
    '  [data-dsh-remote-send] { display: grid !important; visibility: visible !important; opacity: 1 !important; flex: 0 0 34px !important; width: 34px !important; min-width: 34px !important; max-width: 34px !important; height: 34px !important; margin-left: 4px !important; position: relative !important; z-index: 2 !important; }',
    '  [data-dsh-remote-home-composer] [data-dsh-remote-send] { width: 42px !important; min-width: 42px !important; max-width: 42px !important; height: 42px !important; margin-left: 0 !important; border-radius: 50% !important; }',
    '}',
    '@media (max-width: 420px) and (orientation: portrait) {',
    '  [data-dsh-remote-session-log] { width: 36px !important; padding: 0 !important; justify-content: center !important; }',
    '  [data-dsh-remote-session-log] span { display: none !important; }',
    '}'
  ].join('\\n')

  const installRemoteMobileLayout = () => {
    if (document.getElementById(MOBILE_LAYOUT_STYLE_ID)) return
    const style = document.createElement('style')
    style.id = MOBILE_LAYOUT_STYLE_ID
    style.setAttribute('data-dsh-remote-mobile-layout', '')
    style.textContent = mobileLayoutCss
    ;(document.head || document.documentElement).appendChild(style)
  }

  const markRemoteMobileLayout = () => {
    if (!document.querySelector('[data-dsh-remote-session-log]')) {
      document.querySelectorAll('button').forEach(button => {
        if (!(button.textContent || '').trim().startsWith('Session log')) return
        button.setAttribute('data-dsh-remote-session-log', '')
        if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', 'Session log')
        if (!button.getAttribute('title')) button.setAttribute('title', 'Session log')
        const utilities = button.parentElement
        if (utilities) utilities.setAttribute('data-dsh-remote-header-utilities', '')
        const header = button.closest('header')
        if (header) header.setAttribute('data-dsh-remote-session-header', '')
      })
    }
    document.querySelectorAll('button[aria-label="发送消息"],button[aria-label="Send message"]').forEach(button => {
      button.setAttribute('data-dsh-remote-send', '')
      const trailing = button.parentElement
      const row = trailing && trailing.parentElement
      const card = row && row.parentElement
      const root = card && card.parentElement
      if (trailing) trailing.setAttribute('data-dsh-remote-composer-trailing', '')
      if (row) row.setAttribute('data-dsh-remote-composer-row', '')
      if (card) card.setAttribute('data-dsh-remote-composer-card', '')
      if (root) root.setAttribute('data-dsh-remote-composer-root', '')
      if (row && row.firstElementChild) row.firstElementChild.setAttribute('data-dsh-remote-composer-leading', '')
      const slot = button.closest('[data-slot="conversation.composer.bar"]')
      if (slot && slot.parentElement) {
        const stack = slot.parentElement
        stack.setAttribute('data-dsh-remote-composer-stack', '')
        const heroMark = Array.from(stack.querySelectorAll('[data-slot]')).find(node => node.getAttribute('data-slot') === 'conversation.hero.brand.mark')
        const heading = heroMark
          ? Array.from(stack.children).find(child => child.contains(heroMark))
          : Array.from(stack.children).find(child => child !== slot && child.tagName !== 'svg' && (child.textContent || '').trim() && child.getBoundingClientRect().height > 0)
        if (heading) {
          stack.setAttribute('data-dsh-remote-home-composer', '')
          heading.setAttribute('data-dsh-remote-composer-heading', '')
        }
        if (heroMark) {
          heroMark.setAttribute('data-dsh-remote-hero-mark', '')
          if (heroMark.parentElement) {
            heroMark.parentElement.setAttribute('data-dsh-remote-hero-mark-wrap', '')
            if (heroMark.parentElement.parentElement) heroMark.parentElement.parentElement.setAttribute('data-dsh-remote-hero-headline', '')
          }
        }
        const workspaceButton = Array.from(stack.querySelectorAll('button')).find(node => node.getAttribute('aria-label') === '选择工作区')
        if (workspaceButton) {
          const workspaceRow = Array.from(stack.children).find(child => child.contains(workspaceButton))
          if (workspaceRow) workspaceRow.setAttribute('data-dsh-remote-workspace-row', '')
        }
      }
    })
  }

  const findRemoteImageInput = () => Array.from(document.querySelectorAll('input[type="file"]')).find(input => {
    if (input.disabled) return false
    const accepted = String(input.getAttribute('accept') || '').toLowerCase()
    return !accepted || accepted.includes('image') || accepted.includes('*/*')
  }) || null

  const dispatchRemoteImageDrop = files => {
    if (!files.length || typeof DataTransfer !== 'function') return
    const transfer = new DataTransfer()
    files.forEach(file => transfer.items.add(file))
    let event
    if (typeof DragEvent === 'function') event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
    else {
      event = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: transfer })
    }
    document.dispatchEvent(event)
  }

  const ensureRemoteImageInput = () => {
    const existing = findRemoteImageInput()
    if (existing) return existing
    let bridge = document.querySelector('input[data-dsh-remote-image-bridge]')
    if (bridge) return bridge
    bridge = document.createElement('input')
    bridge.type = 'file'
    bridge.accept = 'image/*'
    bridge.multiple = true
    bridge.tabIndex = -1
    bridge.setAttribute('aria-hidden', 'true')
    bridge.setAttribute('data-dsh-remote-image-bridge', '')
    bridge.style.cssText = 'position:fixed!important;left:-10000px!important;top:auto!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;'
    bridge.addEventListener('change', () => {
      const files = Array.from(bridge.files || [])
      dispatchRemoteImageDrop(files)
      bridge.value = ''
    })
    ;(document.body || document.documentElement).appendChild(bridge)
    return bridge
  }

  const requestRemoteImageInput = (input, capture) => {
    const token = String(Date.now()) + '-' + Math.random().toString(36).slice(2)
    const originalCapture = input.getAttribute('capture')
    input.dataset.dshRemoteUploadToken = token
    if (capture) input.setAttribute('capture', 'environment')
    else input.removeAttribute('capture')
    const restore = () => {
      if (input.dataset.dshRemoteUploadToken !== token) return
      if (originalCapture === null) input.removeAttribute('capture')
      else input.setAttribute('capture', originalCapture)
      delete input.dataset.dshRemoteUploadToken
    }
    input.addEventListener('change', restore, { once: true })
    addEventListener('focus', () => setTimeout(restore, 0), { once: true })
    setTimeout(restore, 30_000)
    input.click()
  }

  const ensureMobileUploadControls = () => {
    const leading = document.querySelector('[data-dsh-remote-composer-leading]')
    const existing = document.querySelector('[data-dsh-remote-upload-controls]')
    if (!leading) {
      existing?.remove()
      return
    }
    ensureRemoteImageInput()
    let controls = existing
    if (!controls) {
      controls = document.createElement('span')
      controls.setAttribute('data-dsh-remote-upload-controls', '')
      ;[
        ['gallery', '相册', imageIcon, false],
        ['camera', '拍照', cameraIcon, true]
      ].forEach(([kind, label, icon, capture]) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('data-dsh-remote-upload-action', kind)
        button.setAttribute('aria-label', label + '上传图片')
        button.title = label + '上传图片'
        button.innerHTML = icon + '<span>' + label + '</span>'
        button.addEventListener('click', () => {
          requestRemoteImageInput(ensureRemoteImageInput(), capture)
        })
        controls.appendChild(button)
      })
      leading.appendChild(controls)
    } else if (controls.parentElement !== leading) leading.appendChild(controls)
  }

  const setMobileNavOpen = open => {
    const sidebar = document.querySelector('[data-dsh-remote-sidebar-column]')
    if (!sidebar) return
    const mobilePortrait = matchMedia('(max-width: 720px) and (orientation: portrait)').matches
    const nextOpen = mobilePortrait && Boolean(open)
    const settingsOpen = mobilePortrait && Boolean(document.querySelector('[data-dsh-remote-sidebar-settings] button[aria-haspopup="dialog"][aria-expanded="true"],[data-dsh-remote-sidebar-settings] [data-slot="sidebar.settings"] > [role="presentation"] [role="dialog"]'))
    document.documentElement.toggleAttribute('data-dsh-mobile-nav-open', nextOpen)
    document.documentElement.toggleAttribute('data-dsh-mobile-settings-open', settingsOpen)
    sidebar.inert = mobilePortrait && !nextOpen && !settingsOpen
    if (mobilePortrait && !nextOpen && !settingsOpen) sidebar.setAttribute('aria-hidden', 'true')
    else sidebar.removeAttribute('aria-hidden')
    if (mobilePortrait) {
      sidebar.style.setProperty('visibility', nextOpen || settingsOpen ? 'visible' : 'hidden', 'important')
      sidebar.style.setProperty('transform', nextOpen ? 'translateX(0)' : settingsOpen ? 'none' : 'translateX(-110%)', 'important')
    } else {
      sidebar.style.removeProperty('visibility')
      sidebar.style.removeProperty('transform')
    }
    const settingsOverlay = settingsOpen && document.querySelector('[data-dsh-remote-sidebar-settings] [data-slot="sidebar.settings"] > [role="presentation"]')
    if (settingsOverlay) {
      settingsOverlay.style.removeProperty('transform')
      const offset = -settingsOverlay.getBoundingClientRect().left
      settingsOverlay.style.setProperty('transform', 'translateX(' + offset + 'px)', 'important')
    }
  }

  const syncMobileSidebarExpansion = () => {
    const sidebar = document.querySelector('[data-dsh-remote-sidebar-column]')
    if (!sidebar) return
    const inlineWidth = Number.parseFloat(sidebar.style.getPropertyValue('width'))
    const expandedControl = sidebar.querySelector('button[aria-label="收起侧边栏"],button[aria-label="Collapse sidebar"],button[aria-label="搜索会话"][aria-expanded="true"],button[aria-label="Search conversations"][aria-expanded="true"]')
    sidebar.toggleAttribute('data-dsh-remote-sidebar-expanded', inlineWidth > 96 || Boolean(expandedControl))
  }

  const ensureMobileTopbar = () => {
    const heroMark = document.querySelector('[data-dsh-remote-hero-mark]')
    const desktop = document.querySelector('[data-dsh-remote-desktop-entry]')
    const settings = document.querySelector('[data-dsh-remote-sidebar-settings] button[aria-haspopup="dialog"]')
    const sidebar = document.querySelector('[data-dsh-remote-sidebar-column]')
    if (!heroMark || !desktop || !settings || !sidebar) return
    sidebar.setAttribute('data-dsh-remote-sidebar-root', '')
    if (sidebar.parentElement) sidebar.parentElement.setAttribute('data-dsh-remote-app-shell', '')
    if (sidebar.parentElement && sidebar.parentElement.parentElement) sidebar.parentElement.parentElement.setAttribute('data-dsh-remote-sidebar-viewport', '')
    let bar = document.querySelector('[data-dsh-remote-mobile-topbar]')
    if (bar && !bar.querySelector('[data-dsh-mobile-action="menu"]')) {
      bar.remove()
      bar = null
    }
    if (!document.documentElement.hasAttribute('data-dsh-mobile-settings-close-sync')) {
      document.documentElement.setAttribute('data-dsh-mobile-settings-close-sync', '')
      document.addEventListener('click', () => {
        requestAnimationFrame(syncMobileSidebarExpansion)
        setTimeout(syncMobileSidebarExpansion, 0)
        if (document.documentElement.hasAttribute('data-dsh-mobile-settings-open')) {
          setTimeout(() => setMobileNavOpen(document.documentElement.hasAttribute('data-dsh-mobile-nav-open')), 0)
        }
      }, true)
    }
    if (!bar) {
      bar = document.createElement('div')
      bar.setAttribute('data-dsh-remote-mobile-topbar', '')
      ;['menu', 'desktop', 'settings'].forEach(action => {
        const proxy = document.createElement('button')
        proxy.type = 'button'
        proxy.setAttribute('data-dsh-mobile-action', action)
        bar.appendChild(proxy)
      })
      bar.addEventListener('click', event => {
        const proxy = event.target.closest('button[data-dsh-mobile-action]')
        if (!proxy) return
        const action = proxy.getAttribute('data-dsh-mobile-action')
        if (action === 'menu') {
          setMobileNavOpen(!document.documentElement.hasAttribute('data-dsh-mobile-nav-open'))
          return
        }
        const source = action === 'desktop'
            ? document.querySelector('[data-dsh-remote-desktop-entry]')
            : document.querySelector('[data-dsh-remote-sidebar-settings] button[aria-haspopup="dialog"]')
        if (source) {
          const inertRoot = source.closest('[inert]')
          if (inertRoot) inertRoot.inert = false
          source.click()
        }
        if (action === 'settings') {
          setMobileNavOpen(false)
          setTimeout(() => setMobileNavOpen(false), 0)
          requestAnimationFrame(() => setMobileNavOpen(false))
        } else requestAnimationFrame(() => setMobileNavOpen(false))
      })
      document.body.appendChild(bar)
    }
    const sources = { menu: null, desktop, settings }
    Object.entries(sources).forEach(([action, source]) => {
      const proxy = bar.querySelector('[data-dsh-mobile-action="' + action + '"]')
      const html = action === 'menu' ? menuIcon : action === 'desktop' ? desktopIcon + '<span>桌面</span>' : settingsIcon
      if (proxy && proxy.innerHTML !== html) proxy.innerHTML = html
      if (proxy) proxy.className = ''
      if (proxy) proxy.setAttribute('aria-label', action === 'menu' ? '打开导航' : (source.getAttribute('aria-label') || action) + '快捷方式')
    })
    syncMobileSidebarExpansion()
    setMobileNavOpen(document.documentElement.hasAttribute('data-dsh-mobile-nav-open'))
  }

  const revealRemoteControls = () => {
    const buttons = document.querySelectorAll('button[aria-label^="选择模型"],button[aria-label^="访问模式"]')
    buttons.forEach(button => {
      button.style.setProperty('display', 'inline-flex', 'important')
      button.style.setProperty('visibility', 'visible', 'important')
      button.style.setProperty('opacity', '1', 'important')
      button.style.setProperty('min-width', '0', 'important')
      button.style.setProperty('max-width', '100%', 'important')
      button.style.setProperty('flex-shrink', '1', 'important')
      const group = button.parentElement
      if (group) {
        group.style.setProperty('display', 'flex', 'important')
        group.style.setProperty('visibility', 'visible', 'important')
        group.style.setProperty('opacity', '1', 'important')
        group.style.setProperty('min-width', '0', 'important')
      }
    })
  }

  const refreshRemoteCompatibility = () => {
    installRemoteMobileLayout()
    markRemoteMobileLayout()
    revealRemoteControls()
    ensureMobileUploadControls()
    ensureMobileTopbar()
  }

  let remoteCompatibilityPending = false
  const scheduleRemoteCompatibility = () => {
    if (remoteCompatibilityPending) return
    remoteCompatibilityPending = true
    requestAnimationFrame(() => {
      remoteCompatibilityPending = false
      refreshRemoteCompatibility()
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleRemoteCompatibility, { once: true })
  } else scheduleRemoteCompatibility()
  new MutationObserver(scheduleRemoteCompatibility).observe(document.documentElement, {
    childList: true,
    subtree: true
  })
  addEventListener('resize', scheduleRemoteCompatibility)

  const remoteStyle = document.createElement('style')
  remoteStyle.setAttribute('data-dsh-remote-desktop-style', '')
  remoteStyle.textContent = [
    '[data-dsh-remote-drive-bar]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid rgba(128,128,128,.22)}',
    '[data-dsh-remote-drive-bar] strong{font-size:12px;color:#64748b;margin-right:2px}',
    '[data-dsh-remote-drive-bar] button{min-width:48px;height:34px;padding:0 10px;border:1px solid rgba(128,128,128,.28);border-radius:9px;background:transparent;color:inherit}',
    '[data-dsh-remote-desktop-entry]{display:flex!important;align-items:center;justify-content:center;gap:9px;min-width:40px;min-height:40px;border:0;border-radius:12px;background:transparent;color:inherit;font:inherit}',
    '[data-dsh-remote-desktop-entry-wrap]{flex:none;min-width:0;width:100%}',
    '[data-dsh-remote-desktop-entry] svg{width:22px;height:22px;flex:none}',
    '[data-dsh-remote-desktop-entry] span{display:none}',
    '[data-dsh-remote-desktop-entry][data-expanded="true"]{width:100%;justify-content:flex-start;padding:0 12px}',
    '[data-dsh-remote-desktop-entry][data-expanded="true"] span{display:inline}',
    '[data-dsh-remote-desktop-viewer]{position:fixed;inset:0;z-index:2147483646;box-sizing:border-box;overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:#05080d;color:#f8fafc;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);font-family:system-ui,sans-serif;touch-action:none}',
    '[data-dsh-remote-desktop-viewer] *{box-sizing:border-box}',
    '[data-dsh-remote-desktop-toolbar]{display:flex;align-items:center;gap:8px;min-width:0;min-height:54px;overflow:hidden;padding:7px 10px;background:#0d1521;border-bottom:1px solid #263243}',
    '[data-dsh-remote-desktop-toolbar] button,[data-dsh-remote-desktop-toolbar] select{height:38px;border:1px solid #344257;border-radius:10px;background:#152033;color:#f8fafc;padding:0 11px;font:600 13px inherit}',
    '[data-dsh-remote-desktop-toolbar] button{flex:none}',
    '[data-dsh-remote-desktop-toolbar] select{min-width:0;max-width:min(38vw,190px);text-overflow:ellipsis}',
    '[data-dsh-remote-desktop-status]{min-width:0;flex:1;font-size:12px;color:#a8bad0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '[data-dsh-remote-desktop-stage]{position:relative;min-width:0;min-height:0;display:grid;place-items:center;overflow:hidden;background:#000;touch-action:none;user-select:none}',
    '[data-dsh-remote-desktop-stage] img{display:block!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;object-fit:contain!important;object-position:center!important;transform-origin:center center!important;pointer-events:none}',
    '[data-dsh-remote-desktop-empty]{position:absolute;inset:0;display:grid;place-items:center;color:#94a3b8;font-size:14px;padding:30px;text-align:center;pointer-events:none}',
    '[data-dsh-remote-desktop-notice]{position:fixed;left:50%;bottom:24px;z-index:2147483647;transform:translateX(-50%);max-width:min(88vw,520px);padding:12px 18px;border:1px solid #f87171;border-radius:12px;background:#7f1d1d;color:#fff;font:700 14px system-ui;box-shadow:0 12px 32px rgba(0,0,0,.38)}',
    '[data-dsh-remote-keyboard]{display:none;padding:8px 10px calc(8px + env(safe-area-inset-bottom));background:#0d1521;border-top:1px solid #263243}',
    '[data-dsh-remote-keyboard].open{display:grid;gap:8px}',
    '[data-dsh-remote-keyboard] textarea{width:100%;height:42px;resize:none;border:1px solid #344257;border-radius:10px;background:#101a2a;color:#fff;padding:9px 11px;font:16px system-ui}',
    '[data-dsh-remote-key-row]{display:flex;gap:6px;overflow-x:auto}',
    '[data-dsh-remote-key-row] button{flex:none;min-width:42px;height:38px;border:1px solid #344257;border-radius:9px;background:#18253a;color:#f8fafc;font:600 12px system-ui}',
    '[data-dsh-remote-key-row] button.active{background:#2563eb;border-color:#60a5fa}',
    '@media(orientation:landscape) and (max-height:500px){[data-dsh-remote-desktop-toolbar]{min-height:42px;padding:3px max(6px,env(safe-area-inset-right)) 3px max(6px,env(safe-area-inset-left))}[data-dsh-remote-desktop-toolbar] button,[data-dsh-remote-desktop-toolbar] select{height:34px}[data-dsh-remote-desktop-toolbar] select{max-width:min(30vw,180px)}[data-dsh-remote-keyboard]{position:absolute;left:0;right:0;bottom:0;z-index:2;max-height:calc(100% - 42px);overflow:auto;background:rgba(13,21,33,.97)}}'
  ].join('')
  ;(document.head || document.documentElement).appendChild(remoteStyle)

  const setReactInputValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
  }

  const chooseDrive = (dialog, root) => {
    const edit = dialog.querySelector('button[aria-label="编辑路径"],button[aria-label="Edit path"]')
    if (!edit) return
    edit.click()
    let attempts = 0
    const findInput = () => {
      const input = dialog.querySelector('input')
      if (input) { input.focus(); setReactInputValue(input, root); return }
      attempts += 1
      if (attempts < 12) requestAnimationFrame(findInput)
    }
    requestAnimationFrame(findInput)
  }

  const installDriveBars = () => {
    document.querySelectorAll('[role="dialog"],dialog').forEach(dialog => {
      const title = dialog.querySelector('h1,h2,h3,[role="heading"]')
      if (!title || !/^(选择工作区目录|Select Workspace Directory)$/.test((title.textContent || '').trim())) return
      if (dialog.dataset.dshRemoteDrives) return
      dialog.dataset.dshRemoteDrives = 'loading'
      fetch('/_dsh_remote/v1/drives', { credentials: 'same-origin', cache: 'no-store' }).then(response => {
        if (!response.ok) throw new Error('drive request failed')
        return response.json()
      }).then(value => {
        const drives = Array.isArray(value.drives) ? value.drives : []
        if (drives.length === 0 || !dialog.isConnected) return
        const bar = document.createElement('div')
        bar.setAttribute('data-dsh-remote-drive-bar', '')
        const label = document.createElement('strong')
        label.textContent = '磁盘'
        bar.appendChild(label)
        drives.forEach(root => {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = root
          button.addEventListener('click', () => chooseDrive(dialog, root))
          bar.appendChild(button)
        })
        const header = title.parentElement
        if (header && header.parentElement) header.insertAdjacentElement('afterend', bar)
        else title.insertAdjacentElement('afterend', bar)
        dialog.dataset.dshRemoteDrives = 'ready'
      }).catch(() => { dialog.dataset.dshRemoteDrives = 'failed' })
    })
  }

  let desktopCapability = null
  let desktopCapabilityPending = false
  let desktopViewer = null
  let desktopSocket = null
  let desktopReconnects = 0
  let desktopReconnectTimer = null
  let desktopHeartbeat = null
  let desktopObjectUrl = null
  let desktopFramePending = null
  let desktopFrameRendering = false
  let desktopViewportFrame = null
  let desktopDisplays = []
  let desktopSelectedId = ''
  let desktopCanControl = false
  let desktopControlStateReceived = false
  let desktopViewScale = 1
  let desktopViewOffsetX = 0
  let desktopViewOffsetY = 0
  let desktopCloseRequested = false
  const remoteMobileClient = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || (typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches)

  const menuIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 6h16M4 12h16M4 18h16"/></svg>'
  const imageIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8.2" cy="9" r="1.5" fill="currentColor"/><path d="m5.5 17 4.6-4.6 3.2 3.1 2-2 3.2 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const cameraIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h3l1.2-2h7.6L17 7.5h3A1.5 1.5 0 0 1 21.5 9v9.5A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5V9A1.5 1.5 0 0 1 4 7.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="13.5" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>'
  const desktopIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 4.8h16v11.4H4zM8.5 20h7M12 16.2V20"/></svg>'
  const settingsIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.07a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.53-1H3v-4h.07A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.97 4.6 1.7 1.7 0 0 0 10 3.07V3h4v.07a1.7 1.7 0 0 0 1.03 1.53 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.62.66 1.08 1.3 1.08H21v4h-.3c-.64 0-1.18.45-1.3.92Z"/></svg>'

  const updateDesktopStatus = (text) => {
    const node = desktopViewer && desktopViewer.querySelector('[data-dsh-remote-desktop-status]')
    if (node) node.textContent = text
  }

  const showDesktopExitNotice = text => {
    document.querySelector('[data-dsh-remote-desktop-notice]')?.remove()
    const notice = document.createElement('div')
    notice.setAttribute('data-dsh-remote-desktop-notice', '')
    notice.textContent = text
    document.body.appendChild(notice)
    setTimeout(() => notice.remove(), 5000)
  }

  const applyDesktopTransform = () => {
    const image = desktopViewer && desktopViewer.querySelector('[data-dsh-remote-desktop-stage] img')
    if (!image) return
    image.style.setProperty('transform', 'translate(' + desktopViewOffsetX + 'px,' + desktopViewOffsetY + 'px) scale(' + desktopViewScale + ')', 'important')
  }

  const resetDesktopTransform = () => {
    desktopViewScale = 1
    desktopViewOffsetX = 0
    desktopViewOffsetY = 0
    applyDesktopTransform()
  }

  const sendDesktop = value => {
    if (desktopSocket && desktopSocket.readyState === WebSocket.OPEN) desktopSocket.send(JSON.stringify(value))
  }

  const renderDisplaySelect = () => {
    if (!desktopViewer) return
    const select = desktopViewer.querySelector('select')
    select.replaceChildren()
    desktopDisplays.forEach(display => {
      const option = document.createElement('option')
      option.value = display.id
      option.textContent = display.name + (display.primary ? '（主屏）' : '')
      option.selected = display.id === desktopSelectedId
      select.appendChild(option)
    })
  }

  const closeDesktopSocket = () => {
    clearTimeout(desktopReconnectTimer)
    clearInterval(desktopHeartbeat)
    desktopReconnectTimer = null
    desktopHeartbeat = null
    if (desktopSocket) {
      const socket = desktopSocket
      desktopSocket = null
      try { socket.close(1000, 'viewer closed') } catch {}
    }
  }

  const renderDesktopFrame = () => {
    if (desktopFrameRendering || !desktopFramePending || !desktopViewer) return
    const image = desktopViewer.querySelector('img')
    if (!image) return
    const frame = desktopFramePending
    desktopFramePending = null
    desktopFrameRendering = true
    const oldUrl = desktopObjectUrl
    const nextUrl = URL.createObjectURL(frame)
    desktopObjectUrl = nextUrl
    const finish = () => {
      image.onload = null
      image.onerror = null
      if (oldUrl) URL.revokeObjectURL(oldUrl)
      desktopFrameRendering = false
      if (desktopFramePending) requestAnimationFrame(renderDesktopFrame)
    }
    image.onload = finish
    image.onerror = finish
    image.src = nextUrl
    const empty = desktopViewer.querySelector('[data-dsh-remote-desktop-empty]')
    if (empty) empty.hidden = true
  }

  const queueDesktopFrame = frame => {
    desktopFramePending = frame
    renderDesktopFrame()
  }

  const syncDesktopViewport = () => {
    desktopViewportFrame = null
    if (!desktopViewer) return
    const viewport = window.visualViewport
    const width = Math.max(1, viewport ? viewport.width : document.documentElement.clientWidth)
    const height = Math.max(1, viewport ? viewport.height : document.documentElement.clientHeight)
    desktopViewer.style.left = (viewport ? viewport.offsetLeft : 0) + 'px'
    desktopViewer.style.top = (viewport ? viewport.offsetTop : 0) + 'px'
    desktopViewer.style.right = 'auto'
    desktopViewer.style.bottom = 'auto'
    desktopViewer.style.width = width + 'px'
    desktopViewer.style.height = height + 'px'
    applyDesktopTransform()
  }

  const scheduleDesktopViewportSync = () => {
    if (desktopViewportFrame !== null) cancelAnimationFrame(desktopViewportFrame)
    desktopViewportFrame = requestAnimationFrame(syncDesktopViewport)
  }

  const teardownDesktopViewer = () => {
    closeDesktopSocket()
    if (desktopViewportFrame !== null) cancelAnimationFrame(desktopViewportFrame)
    desktopViewportFrame = null
    const image = desktopViewer && desktopViewer.querySelector('img')
    if (image) { image.onload = null; image.onerror = null }
    if (desktopObjectUrl) URL.revokeObjectURL(desktopObjectUrl)
    desktopObjectUrl = null
    desktopFramePending = null
    desktopFrameRendering = false
    desktopViewer && desktopViewer.remove()
    desktopViewer = null
    desktopDisplays = []
    desktopCanControl = false
    desktopControlStateReceived = false
    desktopViewScale = 1
    desktopViewOffsetX = 0
    desktopViewOffsetY = 0
    desktopCloseRequested = false
  }

  const requestDesktopClose = () => {
    if (history.state && history.state.dshRemoteDesktop) {
      desktopCloseRequested = true
      history.back()
    }
    else teardownDesktopViewer()
  }

  const connectDesktopSocket = () => {
    if (!desktopViewer) return
    closeDesktopSocket()
    updateDesktopStatus(desktopReconnects ? '正在重新连接…' : '正在连接…')
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(protocol + '//' + location.host + '/_dsh_remote/v1/desktop/socket')
    desktopSocket = socket
    socket.binaryType = 'blob'
    socket.onopen = () => {
      desktopReconnects = 0
      updateDesktopStatus('已连接 · 正在等待画面')
      desktopHeartbeat = setInterval(() => sendDesktop({ type: 'heartbeat' }), 5000)
      sendDesktop({ type: 'heartbeat' })
    }
    socket.onmessage = event => {
      if (event.data instanceof Blob) {
        if (!desktopControlStateReceived) updateDesktopStatus('已连接 · 画面已就绪，正在获取控制权限…')
        queueDesktopFrame(event.data)
        return
      }
      let value
      try { value = JSON.parse(event.data) } catch { return }
      if (value.type === 'hello') desktopSelectedId = value.selectedDisplayId || desktopSelectedId
      if (value.type === 'display-list') {
        desktopDisplays = Array.isArray(value.displays) ? value.displays : []
        if (value.selectedDisplayId) desktopSelectedId = value.selectedDisplayId
        renderDisplaySelect()
      }
      if (value.type === 'control-state') {
        desktopControlStateReceived = true
        desktopCanControl = value.canControl === true
        updateDesktopStatus(desktopCanControl ? '已连接 · 你正在控制' : (value.active ? '已连接 · 仅查看，' + value.controller.deviceName + ' 正在控制' : '已连接 · 仅查看'))
      }
      if (value.type === 'stream-state' && value.state === 'paused') updateDesktopStatus(value.reason === 'screen-locked' ? '电脑已锁屏，画面已暂停' : '画面暂时不可用')
      if (value.type === 'session-ended') {
        const message = value.reason === 'local-input' ? '检测到电脑端操作，远程桌面已强制退出。' : '远程桌面会话已结束。'
        teardownDesktopViewer()
        showDesktopExitNotice(message)
        return
      }
      if (value.type === 'error') updateDesktopStatus(value.message || '远程桌面发生错误')
    }
    socket.onclose = event => {
      if (desktopSocket === socket) desktopSocket = null
      clearInterval(desktopHeartbeat)
      if (!desktopViewer) return
      if (event.code === 1008 || event.code === 4002 || event.code === 4401) {
        teardownDesktopViewer()
        if (event.code === 4002) showDesktopExitNotice('检测到电脑端操作，远程桌面已强制退出。')
        else if (event.code === 1008) showDesktopExitNotice('远程输入被拒绝，桌面会话已退出，请重新进入。')
        else showDesktopExitNotice('远程桌面授权已失效，请重新连接。')
        return
      }
      const retry = () => {
        if (!desktopViewer) return
        if (desktopReconnects >= 3) { updateDesktopStatus('连接已断开，请返回后重试'); return }
        desktopReconnects += 1
        updateDesktopStatus('连接中断，正在重试…')
        desktopReconnectTimer = setTimeout(connectDesktopSocket, [500, 1000, 2000][desktopReconnects - 1])
      }
      fetch('/_dsh_remote/v1/desktop/capabilities', { credentials: 'same-origin', cache: 'no-store' }).then(response => {
        if (response.status === 401 || response.status === 403) {
          teardownDesktopViewer()
          showDesktopExitNotice('远程连接授权已失效，请重新认证。')
        }
        else retry()
      }).catch(retry)
    }
    socket.onerror = () => {}
  }

  const installTouchControls = stage => {
    const tapSlop = 20
    const active = new Map()
    let gesture = null
    let pendingMove = null
    let pendingWheel = 0
    let inputFrame = null
    const point = touch => ({ x: touch.clientX, y: touch.clientY })
    const midpoint = touches => ({ x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 })
    const spacing = touches => Math.max(1, Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY))
    const imageMetrics = () => {
      const display = desktopDisplays.find(item => item.id === desktopSelectedId)
      if (!display) return null
      const rect = stage.getBoundingClientRect()
      const image = stage.querySelector('img')
      const sourceWidth = image && image.naturalWidth > 0 ? image.naturalWidth : display.width
      const sourceHeight = image && image.naturalHeight > 0 ? image.naturalHeight : display.height
      const fitScale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight)
      const baseWidth = sourceWidth * fitScale
      const baseHeight = sourceHeight * fitScale
      const width = baseWidth * desktopViewScale
      const height = baseHeight * desktopViewScale
      return {
        image, rect, baseWidth, baseHeight,
        baseLeft: rect.left + (rect.width - baseWidth) / 2,
        baseTop: rect.top + (rect.height - baseHeight) / 2,
        width, height,
        left: rect.left + (rect.width - width) / 2 + desktopViewOffsetX,
        top: rect.top + (rect.height - height) / 2 + desktopViewOffsetY
      }
    }
    const clampDesktopOffset = () => {
      const metrics = imageMetrics()
      if (!metrics) return
      const visibleEdge = 36
      const maxX = Math.max(0, (metrics.width + metrics.rect.width) / 2 - visibleEdge)
      const maxY = Math.max(0, (metrics.height + metrics.rect.height) / 2 - visibleEdge)
      desktopViewOffsetX = Math.max(-maxX, Math.min(maxX, desktopViewOffsetX))
      desktopViewOffsetY = Math.max(-maxY, Math.min(maxY, desktopViewOffsetY))
    }
    const mapped = touch => {
      const metrics = imageMetrics()
      if (!metrics) return null
      let clientX = touch.clientX
      let clientY = touch.clientY
      let left = metrics.left
      let top = metrics.top
      let width = metrics.width
      let height = metrics.height
      const Matrix = window.DOMMatrixReadOnly || window.DOMMatrix
      if (metrics.image && Matrix) {
        const transform = getComputedStyle(metrics.image).transform
        if (transform && transform !== 'none') {
          try {
            const inverse = new Matrix(transform).inverse()
            const originX = metrics.rect.left + metrics.rect.width / 2
            const originY = metrics.rect.top + metrics.rect.height / 2
            const point = new DOMPoint(clientX - originX, clientY - originY).matrixTransform(inverse)
            clientX = originX + point.x
            clientY = originY + point.y
            left = metrics.baseLeft
            top = metrics.baseTop
            width = metrics.baseWidth
            height = metrics.baseHeight
          } catch {}
        }
      }
      const tolerance = 2
      if (clientX < left - tolerance || clientX > left + width + tolerance || clientY < top - tolerance || clientY > top + height + tolerance) return null
      return {
        x: Math.max(0, Math.min(1, (clientX - left) / width)),
        y: Math.max(0, Math.min(1, (clientY - top) / height))
      }
    }
    const pointerValue = (action, value, button) => {
      if (!value) return false
      if (!desktopCanControl) {
        updateDesktopStatus(desktopControlStateReceived ? '已连接 · 当前仅可查看，无法发送输入' : '已连接 · 控制尚未就绪，请稍后重试')
        return false
      }
      if (!desktopSocket || desktopSocket.readyState !== WebSocket.OPEN) {
        updateDesktopStatus('连接中断 · 输入暂时不可用')
        return false
      }
      sendDesktop({ type: 'pointer', action, button: button || 'left', x: value.x, y: value.y })
      return true
    }
    const flushInput = () => {
      inputFrame = null
      if (pendingMove) { const move = pendingMove; pendingMove = null; pointerValue('move', move, 'left') }
      if (pendingWheel) {
        const deltaY = pendingWheel
        pendingWheel = 0
        if (desktopCanControl) sendDesktop({ type: 'wheel', deltaX: 0, deltaY })
      }
    }
    const scheduleInput = () => {
      if (inputFrame === null) inputFrame = requestAnimationFrame(flushInput)
    }
    stage.addEventListener('touchstart', event => {
      event.preventDefault()
      Array.from(event.changedTouches).forEach(touch => active.set(touch.identifier, point(touch)))
      if (active.size === 1) {
        const touch = event.touches[0]
        const start = point(touch)
        const startMapped = mapped(touch)
        gesture = { kind: 'tap', id: touch.identifier, start, last: start, startMapped, lastMapped: startMapped, maxDistance: 0, down: false, longTimer: setTimeout(() => {
          if (gesture && gesture.kind === 'tap' && !gesture.down && gesture.maxDistance <= tapSlop) {
            pointerValue('click', gesture.startMapped, 'right')
            gesture.kind = 'long'
          }
        }, 520) }
      } else if (active.size === 2) {
        if (gesture && gesture.longTimer) clearTimeout(gesture.longTimer)
        if (gesture && gesture.down) {
          if (inputFrame !== null) { cancelAnimationFrame(inputFrame); flushInput() }
          pointerValue('up', gesture.lastMapped || gesture.startMapped, 'left')
        }
        const touches = Array.from(event.touches).slice(0, 2)
        const mid = midpoint(touches)
        const rect = stage.getBoundingClientRect()
        gesture = {
          kind: 'two', mode: null, startDistance: spacing(touches), startMid: mid, lastMid: mid,
          startScale: desktopViewScale, startOffsetX: desktopViewOffsetX, startOffsetY: desktopViewOffsetY,
          anchorX: mid.x - (rect.left + rect.width / 2 + desktopViewOffsetX),
          anchorY: mid.y - (rect.top + rect.height / 2 + desktopViewOffsetY)
        }
      }
    }, { passive: false })
    stage.addEventListener('touchmove', event => {
      event.preventDefault()
      if (!gesture) return
      if (gesture.kind === 'two' && event.touches.length >= 2) {
        const touches = Array.from(event.touches).slice(0, 2)
        const mid = midpoint(touches)
        const distanceRatio = spacing(touches) / gesture.startDistance
        if (!gesture.mode) {
          if (Math.abs(distanceRatio - 1) > 0.04 || desktopViewScale !== 1 && Math.hypot(mid.x - gesture.startMid.x, mid.y - gesture.startMid.y) > 4) gesture.mode = 'zoom'
          else if (desktopViewScale === 1 && Math.abs(mid.y - gesture.startMid.y) > 8) gesture.mode = 'scroll'
        }
        if (gesture.mode === 'scroll') {
          const delta = Math.max(-1200, Math.min(1200, Math.round((gesture.lastMid.y - mid.y) * 6)))
          if (delta) { pendingWheel = Math.max(-1200, Math.min(1200, pendingWheel + delta)); scheduleInput() }
        } else if (gesture.mode === 'zoom') {
          desktopViewScale = Math.max(0.35, Math.min(4, gesture.startScale * distanceRatio))
          const scaleRatio = desktopViewScale / gesture.startScale
          const rect = stage.getBoundingClientRect()
          desktopViewOffsetX = mid.x - (rect.left + rect.width / 2) - gesture.anchorX * scaleRatio
          desktopViewOffsetY = mid.y - (rect.top + rect.height / 2) - gesture.anchorY * scaleRatio
          clampDesktopOffset()
          applyDesktopTransform()
        }
        gesture.lastMid = mid
        return
      }
      const touch = Array.from(event.touches).find(item => item.identifier === gesture.id)
      if (!touch) return
      const now = point(touch)
      const distance = Math.hypot(now.x - gesture.start.x, now.y - gesture.start.y)
      gesture.maxDistance = Math.max(gesture.maxDistance, distance)
      const currentMapped = mapped(touch)
      if (currentMapped) gesture.lastMapped = currentMapped
      if (gesture.maxDistance > tapSlop && gesture.kind === 'tap') {
        clearTimeout(gesture.longTimer)
        gesture.down = pointerValue('down', gesture.startMapped, 'left')
        gesture.kind = 'drag'
      }
      if (gesture.kind === 'drag' && gesture.down && currentMapped) { pendingMove = currentMapped; scheduleInput() }
      gesture.last = now
    }, { passive: false })
    stage.addEventListener('touchend', event => {
      event.preventDefault()
      Array.from(event.changedTouches).forEach(touch => active.delete(touch.identifier))
      if (gesture && gesture.kind === 'two') { gesture = null; return }
      if (!gesture || active.size > 0) return
      clearTimeout(gesture.longTimer)
      const touch = event.changedTouches[0]
      const endMapped = touch ? mapped(touch) : null
      if (endMapped) gesture.lastMapped = endMapped
      if (inputFrame !== null) { cancelAnimationFrame(inputFrame); flushInput() }
      if (gesture.kind === 'drag' && gesture.down) pointerValue('up', gesture.lastMapped || gesture.startMapped, 'left')
      else if (gesture.kind === 'tap') pointerValue('click', gesture.startMapped, 'left')
      gesture = null
    }, { passive: false })
    stage.addEventListener('touchcancel', event => {
      if (inputFrame !== null) { cancelAnimationFrame(inputFrame); flushInput() }
      if (gesture && gesture.down) {
        const touch = event.changedTouches[0]
        const cancelledMapped = touch ? mapped(touch) : null
        pointerValue('up', cancelledMapped || gesture.lastMapped || gesture.startMapped, 'left')
      }
      active.clear(); gesture = null
    }, { passive: false })
  }

  const installKeyboard = viewer => {
    const panel = viewer.querySelector('[data-dsh-remote-keyboard]')
    const input = panel.querySelector('textarea')
    const modifiers = new Set()
    let composing = false
    const resetModifiers = () => {
      modifiers.clear()
      panel.querySelectorAll('[data-modifier]').forEach(button => button.classList.remove('active'))
    }
    panel.addEventListener('click', event => {
      const button = event.target.closest('button')
      if (!button) return
      const modifier = button.dataset.modifier
      if (modifier) {
        if (modifiers.has(modifier)) modifiers.delete(modifier); else modifiers.add(modifier)
        button.classList.toggle('active', modifiers.has(modifier)); input.focus(); return
      }
      const key = button.dataset.key
      if (key) { sendDesktop({ type: 'key', action: 'press', key, modifiers: Array.from(modifiers) }); resetModifiers(); input.focus() }
    })
    input.addEventListener('compositionstart', () => { composing = true })
    input.addEventListener('compositionend', event => {
      composing = false
      if (event.data) sendDesktop({ type: 'text', text: event.data.slice(0, 256) })
      input.value = ''
    })
    input.addEventListener('input', () => {
      if (composing || !input.value) return
      const text = input.value.slice(0, 256)
      input.value = ''
      if (modifiers.size && text.length === 1 && /^[a-z0-9]$/i.test(text)) sendDesktop({ type: 'key', action: 'press', key: text.toUpperCase(), modifiers: Array.from(modifiers) })
      else sendDesktop({ type: 'text', text })
      resetModifiers()
    })
  }

  const openDesktopViewer = () => {
    if (desktopViewer) return
    desktopCloseRequested = false
    history.pushState({ dshRemoteDesktop: true }, '', location.href)
    const viewer = document.createElement('div')
    viewer.setAttribute('data-dsh-remote-desktop-viewer', '')
    viewer.innerHTML = '<div data-dsh-remote-desktop-toolbar><button type="button" data-action="back" aria-label="返回">← 返回</button><span data-dsh-remote-desktop-status>正在连接…</span><select aria-label="选择显示器"></select><button type="button" data-action="fit" aria-label="适应画面">适应</button><button type="button" data-action="keyboard" aria-label="键盘">⌨ 键盘</button></div><div data-dsh-remote-desktop-stage><img alt="远程桌面画面"><div data-dsh-remote-desktop-empty>正在等待桌面画面…</div></div><div data-dsh-remote-keyboard><textarea inputmode="text" enterkeyhint="done" aria-label="远程输入" placeholder="在此输入中文或英文"></textarea><div data-dsh-remote-key-row><button data-key="Enter">Enter</button><button data-key="Escape">Esc</button><button data-key="Tab">Tab</button><button data-key="Backspace">⌫</button><button data-key="ArrowLeft">←</button><button data-key="ArrowUp">↑</button><button data-key="ArrowDown">↓</button><button data-key="ArrowRight">→</button></div><div data-dsh-remote-key-row><button data-modifier="Control">Ctrl</button><button data-modifier="Alt">Alt</button><button data-modifier="Shift">Shift</button><button data-key="A">A</button><button data-key="C">C</button><button data-key="V">V</button><button data-key="X">X</button><button data-key="Z">Z</button><button data-key="Y">Y</button></div></div>'
    document.body.appendChild(viewer)
    desktopViewer = viewer
    resetDesktopTransform()
    syncDesktopViewport()
    viewer.querySelector('[data-action="back"]').addEventListener('click', requestDesktopClose)
    viewer.querySelector('[data-action="fit"]').addEventListener('click', resetDesktopTransform)
    viewer.querySelector('[data-action="keyboard"]').addEventListener('click', () => {
      const panel = viewer.querySelector('[data-dsh-remote-keyboard]')
      panel.classList.toggle('open')
      if (panel.classList.contains('open')) panel.querySelector('textarea').focus()
    })
    viewer.querySelector('select').addEventListener('change', event => {
      desktopSelectedId = event.target.value
      resetDesktopTransform()
      sendDesktop({ type: 'select-display', displayId: desktopSelectedId })
    })
    installTouchControls(viewer.querySelector('[data-dsh-remote-desktop-stage]'))
    installKeyboard(viewer)
    desktopReconnects = 0
    connectDesktopSocket()
  }

  const installDesktopEntry = () => {
    if (!remoteMobileClient || !desktopCapability || desktopCapability.available !== true) return
    const existing = document.querySelector('[data-dsh-remote-desktop-entry]')
    const markedSettingsArea = document.querySelector('[data-dsh-remote-sidebar-settings]')
    if (existing && markedSettingsArea) {
      const markedSettings = markedSettingsArea.querySelector('button[aria-haspopup="dialog"][aria-expanded]')
      if (markedSettings) {
        if (!markedSettings.getAttribute('aria-label')) markedSettings.setAttribute('aria-label', '设置')
        if (!markedSettings.getAttribute('title')) markedSettings.setAttribute('title', '设置')
      }
      existing.dataset.expanded = markedSettingsArea.getBoundingClientRect().width > 96 ? 'true' : 'false'
      return
    }
    const isVisible = element => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'
    }
    const isInSidebar = element => {
      let parent = element.parentElement
      while (parent && parent !== document.body && parent !== document.documentElement) {
        const rect = parent.getBoundingClientRect()
        const style = getComputedStyle(parent)
        if (rect.height >= innerHeight * 0.6 && rect.left <= 16 && rect.width <= Math.min(440, innerWidth) && style.flexDirection === 'column') return true
        parent = parent.parentElement
      }
      return false
    }
    const buttons = [...document.querySelectorAll('button')].filter(isVisible)
    const labelled = buttons.filter(button => [
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.textContent
    ].some(value => /^(设置|settings)$/i.test((value || '').trim())))
    const settings = labelled.find(isInSidebar) || labelled[0] || buttons
      .filter(button => button.getAttribute('aria-haspopup') === 'dialog' && button.hasAttribute('aria-expanded') && isInSidebar(button))
      .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom)[0]
    if (!settings || !settings.parentElement) return
    const settingsHost = settings.parentElement
    if (!settings.getAttribute('aria-label')) settings.setAttribute('aria-label', '设置')
    if (!settings.getAttribute('title')) settings.setAttribute('title', '设置')
    const settingsArea = settingsHost.parentElement
    const footArea = settingsArea && settingsArea.parentElement
    if (settingsArea) settingsArea.setAttribute('data-dsh-remote-sidebar-settings', '')
    if (footArea) footArea.setAttribute('data-dsh-remote-sidebar-foot', '')
    let sidebarColumn = footArea
    while (sidebarColumn && sidebarColumn !== document.body && sidebarColumn !== document.documentElement) {
      const rect = sidebarColumn.getBoundingClientRect()
      const style = getComputedStyle(sidebarColumn)
      if (rect.height >= innerHeight * 0.6 && rect.left <= 16 && rect.width <= Math.min(440, innerWidth) && style.flexDirection === 'column') {
        sidebarColumn.setAttribute('data-dsh-remote-sidebar-column', '')
        break
      }
      sidebarColumn = sidebarColumn.parentElement
    }
    if (existing) {
      existing.dataset.expanded = settingsArea && settingsArea.getBoundingClientRect().width > 96 ? 'true' : 'false'
      return
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-dsh-remote-desktop-entry', '')
    button.setAttribute('aria-label', '桌面')
    button.setAttribute('title', '桌面')
    button.innerHTML = desktopIcon + '<span>桌面</span>'
    button.dataset.expanded = settingsArea && settingsArea.getBoundingClientRect().width > 96 ? 'true' : 'false'
    button.addEventListener('click', openDesktopViewer)
    if (settingsHost.parentElement) {
      const wrapper = document.createElement('div')
      wrapper.className = settingsHost.className
      wrapper.setAttribute('data-dsh-remote-desktop-entry-wrap', '')
      wrapper.appendChild(button)
      settingsHost.parentElement.insertBefore(wrapper, settingsHost)
    } else settingsHost.insertBefore(button, settings)
  }

  const refreshRemoteDesktopFeatures = () => {
    installDriveBars()
    installDesktopEntry()
    if (remoteMobileClient && !desktopCapability && !desktopCapabilityPending) {
      desktopCapabilityPending = true
      fetch('/_dsh_remote/v1/desktop/capabilities', { credentials: 'same-origin', cache: 'no-store' }).then(response => {
        if (!response.ok) throw new Error('desktop unavailable')
        return response.json()
      }).then(value => { desktopCapability = value; installDesktopEntry() }).catch(() => { desktopCapability = { available: false } }).finally(() => { desktopCapabilityPending = false })
    }
  }

  let remoteDesktopFeaturesPending = false
  const scheduleRemoteDesktopFeatures = () => {
    if (remoteDesktopFeaturesPending) return
    remoteDesktopFeaturesPending = true
    requestAnimationFrame(() => {
      remoteDesktopFeaturesPending = false
      refreshRemoteDesktopFeatures()
    })
  }

  addEventListener('popstate', () => {
    if (!desktopViewer || (history.state && history.state.dshRemoteDesktop)) return
    if (desktopCloseRequested) {
      teardownDesktopViewer()
      return
    }
    history.pushState({ dshRemoteDesktop: true }, '', location.href)
  })
  addEventListener('resize', () => { installDesktopEntry(); scheduleDesktopViewportSync() })
  addEventListener('orientationchange', () => { scheduleDesktopViewportSync(); setTimeout(scheduleDesktopViewportSync, 250) })
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleDesktopViewportSync)
    window.visualViewport.addEventListener('scroll', scheduleDesktopViewportSync)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scheduleRemoteDesktopFeatures, { once: true })
  else scheduleRemoteDesktopFeatures()
  new MutationObserver(scheduleRemoteDesktopFeatures).observe(document.documentElement, { childList: true, subtree: true })
})()
`

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function jsonResponse(response, statusCode, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  })
  response.end(body)
}

function javascriptResponse(response, source) {
  const body = Buffer.from(source, 'utf8')
  response.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(body)
}

function parseCookies(header) {
  const result = new Map()
  for (const item of String(header || '').split(';')) {
    const index = item.indexOf('=')
    if (index <= 0) continue
    result.set(item.slice(0, index).trim(), item.slice(index + 1).trim())
  }
  return result
}

function normalizeDnsName(value) {
  return String(value || '').trim().replace(/\.$/, '').toLowerCase()
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_BYTES) {
        reject(new Error('请求正文过大。'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.once('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.length === 0 ? {} : JSON.parse(text))
      } catch {
        reject(new Error('请求正文不是有效 JSON。'))
      }
    })
    request.once('error', reject)
  })
}

function makeDeviceId() {
  return crypto.randomUUID()
}

async function listDriveRoots(options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'win32') return ['/']
  const probe = options.probe || (root => fsPromises.access(root, fsConstants.R_OK))
  const timeoutMs = Math.max(1, Math.min(1000, Number(options.timeoutMs) || 1000))
  const available = new Set()
  const probes = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    probes.push(Promise.resolve().then(() => probe(root)).then(() => available.add(root)).catch(() => {}))
  }
  let timer
  await Promise.race([
    Promise.allSettled(probes),
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) })
  ])
  clearTimeout(timer)
  return [...available].sort((left, right) => left.localeCompare(right, 'en-US'))
}

const KEY_NAMES = new Set([
  'Enter', 'Escape', 'Tab', 'Backspace', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
  'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Control', 'Alt', 'Shift'
])
const MODIFIER_NAMES = new Set(['Control', 'Alt', 'Shift'])
const POINTER_ACTIONS = new Set(['move', 'down', 'up', 'click', 'double-click'])
const POINTER_BUTTONS = new Set(['left', 'right', 'middle', 'none'])

function finiteNumber(value, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

class RemoteGateway extends EventEmitter {
  constructor(options) {
    super()
    this.userDataPath = options.userDataPath
    this.log = options.log || (() => {})
    this.cloudflaredPath = options.cloudflaredPath || path.join(__dirname, 'vendor', 'cloudflared.exe')
    this.allowTestIdentity = options.allowTestIdentity === true
    this.skipTunnel = options.skipTunnel === true || options.skipTailscaleServe === true
    this.allowPublicTunnel = options.allowPublicTunnel !== false && !this.skipTunnel
    this.testRemoteUrl = options.testRemoteUrl || null
    this.tunnelProcess = null
    this.tunnelState = 'Stopped'
    this.tunnelError = ''
    this.tunnelRetryTimer = null
    this.tunnelRetryAttempt = 0
    // Connection-set tracking for the tunnel watchdog: cloudflared stays alive
    // while its edge connections drop, so process liveness proves nothing.
    this.tunnelWatchdog = null
    this.tunnelConnections = new Set()
    this.tunnelLastAliveAt = 0
    this.tunnelRestarting = false
    this.server = null
    this.proxy = null
    this.gatewayPort = null
    this.remoteUrl = null
    // A permanent named tunnel, when the machine has one configured. Chosen in
    // preference to a quick tunnel so the phone keeps one stable address.
    this.namedTunnel = options.namedTunnel === false ? null : resolveNamedTunnel(options)
    this.namedTunnelConfigPath = options.namedTunnelConfigPath
      || path.join(this.userDataPath || __dirname, 'cloudflared-named.yml')
    this.harnessUrl = null
    // DSH 0.1.5+ rejects unauthenticated loopback requests. The gateway exchanges
    // the harness startup token for a `dsh-auth-*` cookie once and presents it
    // upstream on every paired device's behalf; devices never see it.
    this.harnessCookie = null
    // Supplies a fresh token when the current cookie stops working. The harness
    // mints a new token when it restarts, so a cookie captured at launch goes
    // stale and every phone would silently fall back to the auth-required page.
    this.harnessTokenProvider = typeof options.harnessTokenProvider === 'function'
      ? options.harnessTokenProvider
      : null
    this.harnessToken = null
    this.harnessAuthRetry = null
    // Transport for the named tunnel. Defaults to HTTP/2 because QUIC (UDP) is
    // frequently broken behind VPNs and proxies, and the failure mode is a tunnel
    // that retries forever with the public address answering 530.
    this.tunnelProtocol = options.tunnelProtocol
      || process.env.DSH_TUNNEL_PROTOCOL
      || 'http2'
    this.pairings = new Map()
    this.challenges = new Map()
    this.sessions = new Map()
    this.deviceSockets = new Map()
    this.desktopProvider = options.desktopProvider || null
    this.desktopWss = null
    this.desktopClients = new Set()
    this.desktopController = null
    this.desktopCaptureTimer = null
    this.desktopCaptureBusy = false
    this.desktopLocked = false
    this.desktopEndingForLocalInput = false
    this.devicesPath = path.join(this.userDataPath, 'remote-devices.json')
    this.devices = this.loadDevices()
    this.desktopProvider?.on?.('input-error', error => {
      this.log(`Desktop input helper failed: ${error.stack || error.message}`)
      const controller = this.desktopController
      this.stopDesktopControl('input-helper-failed')
      if (controller?.ws.readyState === WebSocket.OPEN) {
        this.sendDesktopJson(controller, { type: 'error', code: 'input-failed', message: '桌面输入暂时不可用，请重新进入远程桌面。' })
      }
    })
    this.desktopProvider?.on?.('local-input', value => this.handleLocalDesktopInput(value))
  }

  loadDevices() {
    try {
      const parsed = JSON.parse(readFileSync(this.devicesPath, 'utf8'))
      if (!Array.isArray(parsed.devices)) return []
      return parsed.devices.filter((device) => device && typeof device.id === 'string' && typeof device.publicKey === 'string')
    } catch {
      return []
    }
  }

  saveDevices() {
    mkdirSync(path.dirname(this.devicesPath), { recursive: true })
    const tempPath = `${this.devicesPath}.tmp`
    writeFileSync(tempPath, JSON.stringify({ version: 1, devices: this.devices }, null, 2), 'utf8')
    renameSync(tempPath, this.devicesPath)
  }

  getStatus() {
    const controller = this.desktopController
    return {
      running: this.server !== null && this.remoteUrl !== null,
      gatewayPort: this.gatewayPort,
      remoteUrl: this.remoteUrl,
      tunnel: {
        provider: this.skipTunnel
          ? 'Test'
          : (this.namedTunnel !== null ? NAMED_TUNNEL_PROVIDER : QUICK_TUNNEL_PROVIDER),
        installed: this.skipTunnel || existsSync(this.cloudflaredPath),
        state: this.tunnelState,
        error: this.tunnelError,
        // A permanent address survives restarts; a quick tunnel does not, and
        // the phone has to re-pair each time its hostname changes.
        permanent: this.namedTunnel !== null && !this.skipTunnel,
        hostname: this.namedTunnel?.hostname ?? null
      },
      devices: this.devices.map(({ publicKey, ...device }) => device),
      desktop: {
        available: this.desktopProvider?.isAvailable?.() === true,
        viewerCount: this.desktopClients.size,
        locked: this.desktopLocked
      },
      desktopControl: controller ? {
        active: true,
        deviceId: controller.auth.device.id,
        deviceName: controller.auth.device.name,
        displayId: controller.selectedDisplayId
      } : { active: false }
    }
  }

  /**
   * Exchange the harness startup token for its own auth cookie.
   *
   * DSH 0.1.5+ answers an unauthenticated loopback request with 401, so the
   * gateway authenticates once and then presents that cookie upstream for every
   * paired device. Devices never receive it.
   *
   * Returns true when a cookie was acquired. The caller may retry this later:
   * a harness restart mints a new token and invalidates the old cookie.
   */
  async authenticateHarness(token) {
    this.harnessCookie = null
    if (typeof token !== 'string' || token.length === 0) return false
    try {
      const entry = new URL(`/?token=${encodeURIComponent(token)}`, this.harnessUrl)
      const upstream = await fetch(entry, {
        redirect: 'manual',
        headers: { 'accept-encoding': 'identity' }
      })
      const pair = String(upstream.headers.get('set-cookie') || '').split(';')[0]
      if (!pair.includes('=')) {
        this.log(`Harness auth exchange returned no cookie (status ${upstream.status})`)
        return false
      }
      this.harnessCookie = pair
      this.harnessToken = token
      this.log(`Harness auth cookie acquired (status ${upstream.status})`)
      return true
    } catch (error) {
      this.log(`Harness auth exchange failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Re-acquire the harness cookie after the upstream rejected it.
   *
   * Serialised: many concurrent 401s must not each start a memory scan. The
   * cache is invalidated first so an attempt during a harness restart is not
   * pinned to the dead cookie forever.
   */
  async refreshHarnessAuth() {
    if (this.harnessAuthRetry !== null) return this.harnessAuthRetry
    this.harnessCookie = null
    this.harnessAuthRetry = (async () => {
      try {
        // The provider can rescan memory for a rotated token; without one, a
        // restart makes the cached token useless and reusing it merely fails.
        let token = this.harnessToken
        if (this.harnessTokenProvider !== null) {
          try {
            token = await this.harnessTokenProvider()
          } catch (error) {
            this.log(`Harness token refresh failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (typeof token !== 'string' || token.length === 0) return false
        this.log('Harness rejected the cached cookie; re-authenticating.')
        return await this.authenticateHarness(token)
      } finally {
        this.harnessAuthRetry = null
      }
    })()
    return this.harnessAuthRetry
  }

  async start(harnessUrl, harnessToken) {
    if (this.server !== null) return this.getStatus()
    this.harnessUrl = harnessUrl
    await this.authenticateHarness(harnessToken)
    this.proxy = httpProxy.createProxyServer({ ws: true, xfwd: false, secure: true })
    // A harness restart rotates the token and invalidates the cached cookie. When
    // that happens the upstream answers 401; refresh once for the following
    // request instead of leaving every phone stuck on the auth-required page.
    this.proxy.on('proxyRes', (proxyRes) => {
      if (proxyRes.statusCode === 401) void this.refreshHarnessAuth()
    })
    this.proxy.on('error', (error, _request, responseOrSocket) => {
      this.log(`Remote proxy error: ${error.stack || error.message}`)
      if (responseOrSocket && typeof responseOrSocket.writeHead === 'function' && !responseOrSocket.headersSent) {
        jsonResponse(responseOrSocket, 502, { error: 'Harness 暂时不可用。' })
      } else if (responseOrSocket && typeof responseOrSocket.destroy === 'function') {
        responseOrSocket.destroy()
      }
    })

    this.server = http.createServer((request, response) => void this.handleRequest(request, response))
    this.desktopWss = new WebSocketServer({ noServer: true, maxPayload: DESKTOP_MESSAGE_BYTES, perMessageDeflate: false })
    this.server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head))
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.gatewayPort = this.server.address().port

    try {
      if (this.skipTunnel) {
        this.remoteUrl = this.testRemoteUrl || 'https://desktop.test.ts.net:8443'
        this.tunnelState = 'Connected'
      } else if (this.namedTunnel !== null) {
        this.remoteUrl = await this.startNamedTunnel()
      } else {
        this.remoteUrl = await this.startPublicTunnel()
      }
    } catch (error) {
      this.tunnelError = error instanceof Error ? error.message : String(error)
      this.tunnelState = 'Retrying'
      this.log(`安全隧道启动失败，将自动重试：${this.tunnelError}`)
      this.scheduleTunnelRetry()
      this.emit('status', this.getStatus())
      return this.getStatus()
    }
    this.log(`Remote gateway ready at ${this.remoteUrl} -> http://127.0.0.1:${this.gatewayPort}`)
    this.emit('status', this.getStatus())
    return this.getStatus()
  }

  scheduleTunnelRetry() {
    if (this.skipTunnel || this.server === null || this.remoteUrl !== null || this.tunnelRetryTimer !== null) return
    const nextAttempt = this.tunnelRetryAttempt + 1
    const delayMs = tunnelRetryDelayMs(nextAttempt)
    this.tunnelState = 'Retrying'
    this.tunnelError = `安全隧道暂时不可用，将在 ${Math.ceil(delayMs / 1000)} 秒后自动重试（第 ${nextAttempt} 次）。`
    this.log(this.tunnelError)
    this.emit('status', this.getStatus())
    this.tunnelRetryTimer = setTimeout(() => {
      this.tunnelRetryTimer = null
      void this.retryPublicTunnel()
    }, delayMs)
  }

  async retryPublicTunnel() {
    if (this.skipTunnel || this.server === null || this.remoteUrl !== null) return
    if (this.tunnelProcess !== null) {
      this.scheduleTunnelRetry()
      return
    }
    this.tunnelRetryAttempt += 1
    this.tunnelState = 'Connecting'
    this.tunnelError = ''
    this.emit('status', this.getStatus())
    try {
      this.remoteUrl = await this.startPublicTunnel()
      this.tunnelRetryAttempt = 0
      this.log(`安全隧道自动恢复：${this.remoteUrl} -> http://127.0.0.1:${this.gatewayPort}`)
      this.emit('status', this.getStatus())
    } catch (error) {
      this.tunnelError = error instanceof Error ? error.message : String(error)
      this.tunnelState = 'Retrying'
      this.log(`安全隧道自动重试失败：${this.tunnelError}`)
      this.scheduleTunnelRetry()
      this.emit('status', this.getStatus())
    }
  }

  /**
   * Start the permanent named tunnel.
   *
   * Unlike a quick tunnel there is no hostname to discover from the logs: the
   * hostname is already recorded in DNS, and cloudflared simply serves it. The
   * config file is rewritten on every start because the gateway's loopback port
   * is ephemeral — the ingress target has to follow it.
   */
  startNamedTunnel() {
    if (!existsSync(this.cloudflaredPath)) throw new Error('桌面端缺少内置安全隧道组件。')
    const tunnel = this.namedTunnel
    const origin = `http://127.0.0.1:${this.gatewayPort}`
    mkdirSync(path.dirname(this.namedTunnelConfigPath), { recursive: true })
    writeFileSync(
      this.namedTunnelConfigPath,
      renderNamedTunnelConfig({
        tunnelId: tunnel.tunnelId,
        credentialsFile: tunnel.credentialsFile,
        hostname: tunnel.hostname,
        origin
      }),
      'utf8'
    )
    this.tunnelState = 'Connecting'
    this.tunnelError = ''
    return new Promise((resolve, reject) => {
      let settled = false
      let output = ''
      const child = spawn(
        this.cloudflaredPath,
        // QUIC is cloudflared's default, but it rides UDP and VPN/proxy stacks
        // routinely intercept or drop it: the tunnel then retries forever while
        // the public address answers 530. HTTP/2 over TCP 443 survives those
        // networks, and the quick tunnel has always used it for this reason.
        ['tunnel', '--no-autoupdate', '--protocol', this.tunnelProtocol, '--config', this.namedTunnelConfigPath, 'run'],
        { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      this.tunnelProcess = child
      const finish = (error, url) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(url)
      }
      // A named tunnel is not ready just because the process is alive; wait for
      // cloudflared to report registered connections before advertising it.
      const registered = () => /Registered tunnel connection|Connection .* registered/i.test(output)
      const consume = (chunk) => {
        const text = chunk.toString('utf8')
        this.log(`Tunnel: ${text.trim()}`)
        this.trackTunnelLine(text)
        output = `${output}${text}`.slice(-65_536)
        if (registered()) {
          this.tunnelState = 'Connected'
          this.startTunnelWatchdog()
          finish(null, namedTunnelUrl(tunnel.hostname))
        }
      }
      child.stdout.on('data', consume)
      child.stderr.on('data', consume)
      const timer = setTimeout(() => {
        if (settled) return
        this.tunnelState = 'Failed'
        const error = new Error('永久隧道启动超时。')
        this.tunnelError = error.message
        finish(error)
      }, TUNNEL_START_TIMEOUT_MS)
      child.once('error', (error) => {
        if (this.tunnelProcess === child) this.tunnelProcess = null
        this.tunnelState = 'Failed'
        this.tunnelError = error.message
        finish(error)
      })
      child.once('exit', (code) => {
        if (this.tunnelProcess === child) this.tunnelProcess = null
        if (!settled) {
          const error = new Error(`永久隧道启动失败（退出代码 ${code ?? 'unknown'}）。`)
          this.tunnelState = 'Failed'
          this.tunnelError = error.message
          finish(error)
          return
        }
        if (this.server !== null) {
          this.remoteUrl = null
          this.tunnelState = 'Retrying'
          this.log(`永久隧道已退出（代码 ${code ?? 'unknown'}），将自动重试。`)
          this.scheduleTunnelRetry()
          this.emit('status', this.getStatus())
        }
      })
    })
  }

  /**
   * Track tunnel connections and restart cloudflared when they all drop.
   *
   * cloudflared keeps the process alive and retries internally, so a VPN blip can
   * leave it running while every edge connection is gone: the public address then
   * answers 530 and phones time out, with nothing looking wrong locally. The
   * watchdog watches the connection set rather than the process, and restarts it
   * once the set has been empty long enough to be a real failure rather than a
   * reconnect.
   */
  startTunnelWatchdog() {
    this.stopTunnelWatchdog()
    this.tunnelConnections = new Set()
    this.tunnelLastAliveAt = Date.now()

    this.tunnelWatchdog = setInterval(() => {
      if (this.server === null || this.tunnelProcess === null) return
      if (this.tunnelConnections.size > 0) {
        this.tunnelLastAliveAt = Date.now()
        return
      }
      const deadFor = Date.now() - this.tunnelLastAliveAt
      if (deadFor < TUNNEL_STALE_MS) return
      this.log(`安全隧道 ${Math.round(deadFor / 1000)}s 无可用连接，正在重启。`)
      this.restartTunnel()
    }, 15_000)
    this.tunnelWatchdog.unref?.()
  }

  stopTunnelWatchdog() {
    if (this.tunnelWatchdog !== null) {
      clearInterval(this.tunnelWatchdog)
      this.tunnelWatchdog = null
    }
  }

  /** Records one cloudflared log line into the connection-set tracker. */
  trackTunnelLine(text) {
    for (const match of text.matchAll(/Registered tunnel connection\b[^\n]*?connIndex=(\d+)/g)) {
      if (this.tunnelConnections !== null) this.tunnelConnections.add(match[1])
      this.tunnelLastAliveAt = Date.now()
    }
    for (const match of text.matchAll(/(?:Unregistered tunnel connection|Connection terminated)\b[^\n]*?connIndex=(\d+)/g)) {
      this.tunnelConnections?.delete(match[1])
    }
    // A line without a connIndex that still reports registration (older formats).
    if (/Registered tunnel connection/.test(text) && !/connIndex=/.test(text)) {
      this.tunnelConnections?.add('0')
      this.tunnelLastAliveAt = Date.now()
    }
  }

  /** Kill the current tunnel and start it again, with the state machine intact. */
  restartTunnel() {
    if (this.tunnelRestarting) return
    this.tunnelRestarting = true
    const child = this.tunnelProcess
    this.tunnelProcess = null
    this.stopTunnelWatchdog()
    if (child !== null) {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
    this.remoteUrl = null
    this.tunnelState = 'Connecting'
    this.emit('status', this.getStatus())
    setTimeout(() => {
      this.tunnelRestarting = false
      // start() is a no-op when a server is already listening, so re-enter the
      // tunnel phase directly.
      const startTunnel = this.namedTunnel !== null ? this.startNamedTunnel() : this.startPublicTunnel()
      Promise.resolve(startTunnel)
        .then((url) => {
          this.remoteUrl = url
          this.tunnelState = 'Connected'
          this.emit('status', this.getStatus())
        })
        .catch((error) => {
          this.tunnelState = 'Retrying'
          this.tunnelError = error instanceof Error ? error.message : String(error)
          this.log(`安全隧道重启失败：${this.tunnelError}`)
          this.scheduleTunnelRetry()
          this.emit('status', this.getStatus())
        })
    }, TUNNEL_RESTART_DELAY_MS)
  }

  startPublicTunnel() {
    if (!existsSync(this.cloudflaredPath)) throw new Error('桌面端缺少内置安全隧道组件。')
    this.tunnelState = 'Connecting'
    this.tunnelError = ''
    const origin = `http://127.0.0.1:${this.gatewayPort}`
    return new Promise((resolve, reject) => {
      let settled = false
      let output = ''
      const child = spawn(this.cloudflaredPath, [
        'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', origin
      ], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      this.tunnelProcess = child
      const finish = (error, url) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(url)
      }
      const consume = (chunk) => {
        const text = chunk.toString('utf8')
        this.log(`Tunnel: ${text.trim()}`)
        this.trackTunnelLine(text)
        output = `${output}${text}`.slice(-65_536)
        const tunnelUrl = extractQuickTunnelUrl(output)
        if (tunnelUrl) {
          this.tunnelState = 'Connected'
          this.startTunnelWatchdog()
          finish(null, tunnelUrl)
        }
      }
      child.stdout.on('data', consume)
      child.stderr.on('data', consume)
      child.once('error', (error) => {
        if (this.tunnelProcess === child) this.tunnelProcess = null
        this.tunnelState = 'Failed'
        this.tunnelError = error.message
        finish(error)
      })
      child.once('exit', (code) => {
        if (this.tunnelProcess === child) this.tunnelProcess = null
        if (!settled) {
          const error = new Error(`安全隧道启动失败（退出代码 ${code ?? 'unknown'}）。`)
          this.tunnelState = 'Failed'
          this.tunnelError = error.message
          finish(error)
          return
        }
        if (this.server !== null) {
          this.remoteUrl = null
          this.tunnelState = 'Disconnected'
          this.tunnelError = `安全隧道已断开（退出代码 ${code ?? 'unknown'}）。`
          this.emit('status', this.getStatus())
          this.scheduleTunnelRetry()
        }
      })
      const timer = setTimeout(() => {
        const error = new Error('安全隧道连接超时，请检查电脑网络后重试。')
        this.tunnelState = 'Failed'
        this.tunnelError = error.message
        child.kill()
        finish(error)
      }, TUNNEL_START_TIMEOUT_MS)
    })
  }

  async stop(disableServe = true) {
    this.stopTunnelWatchdog()
    this.tunnelConnections = new Set()
    if (this.tunnelRetryTimer !== null) clearTimeout(this.tunnelRetryTimer)
    this.tunnelRetryTimer = null
    this.tunnelRetryAttempt = 0
    if (!this.stopDesktopControl('gateway-stopped')) {
      try { this.desktopProvider?.releaseAll?.() } catch (error) { this.log(`Desktop input release failed: ${error.message}`) }
    }
    this.stopDesktopCapture()
    for (const client of this.desktopClients) client.ws.close(1001, 'gateway stopped')
    this.desktopClients.clear()
    this.desktopWss?.close()
    this.desktopWss = null
    for (const sockets of this.deviceSockets.values()) {
      for (const socket of sockets) socket.destroy()
    }
    this.deviceSockets.clear()
    this.sessions.clear()
    this.challenges.clear()
    this.pairings.clear()
    if (this.server !== null) {
      const server = this.server
      this.server = null
      await new Promise((resolve) => server.closeAllConnections ? (server.closeAllConnections(), server.close(resolve)) : server.close(resolve))
    }
    this.proxy?.close()
    this.proxy = null
    this.gatewayPort = null
    if (this.tunnelProcess !== null) {
      const child = this.tunnelProcess
      this.tunnelProcess = null
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
      } else child.kill('SIGTERM')
    }
    this.remoteUrl = null
    this.tunnelState = 'Stopped'
    if (disableServe) this.tunnelError = ''
    this.emit('status', this.getStatus())
  }

  desktopDisplays() {
    try {
      const displays = this.desktopProvider?.listDisplays?.() || []
      return displays.filter(display => display && typeof display.id === 'string' && display.id.length > 0)
    } catch (error) {
      this.log(`Desktop display enumeration failed: ${error.stack || error.message}`)
      return []
    }
  }

  sendDesktopJson(client, value) {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(value))
  }

  broadcastDesktopJson(value) {
    for (const client of this.desktopClients) this.sendDesktopJson(client, value)
  }

  desktopControlView(client) {
    const controller = this.desktopController
    return {
      type: 'control-state',
      active: Boolean(controller),
      controller: controller ? { deviceId: controller.auth.device.id, deviceName: controller.auth.device.name } : null,
      canControl: controller === client,
      reason: client?.controlReason || ''
    }
  }

  broadcastDesktopControl() {
    for (const client of this.desktopClients) this.sendDesktopJson(client, this.desktopControlView(client))
    this.emit('desktop-control', this.getStatus().desktopControl)
    this.emit('status', this.getStatus())
  }

  acquireDesktopControl(client) {
    if (this.desktopController || this.desktopLocked || !this.desktopClients.has(client)) return false
    this.desktopController = client
    client.controlReason = ''
    this.broadcastDesktopControl()
    return true
  }

  stopDesktopControl(reason = 'local-stop', reassign = false) {
    const controller = this.desktopController
    if (!controller) return false
    this.desktopController = null
    controller.controlReason = reason
    try { this.desktopProvider?.releaseAll?.() } catch (error) { this.log(`Desktop input release failed: ${error.message}`) }
    if (reassign && !this.desktopLocked) {
      const next = [...this.desktopClients].find(client => client !== controller && client.ws.readyState === WebSocket.OPEN)
      if (next) this.desktopController = next
    }
    this.broadcastDesktopControl()
    return true
  }

  handleLocalDesktopInput(value) {
    if (this.desktopClients.size === 0 || this.desktopEndingForLocalInput) return
    this.desktopEndingForLocalInput = true
    this.log(`Local ${value?.kind === 'keyboard' ? 'keyboard' : 'mouse'} input detected; ending remote desktop session`)
    if (!this.stopDesktopControl('local-input', false)) {
      try { this.desktopProvider?.releaseAll?.() } catch (error) { this.log(`Desktop input release failed: ${error.message}`) }
    }
    this.stopDesktopCapture()
    for (const client of [...this.desktopClients]) {
      if (client.ws.readyState !== WebSocket.OPEN) continue
      client.ws.send(JSON.stringify({ type: 'session-ended', reason: 'local-input' }), () => {
        try { client.ws.close(4002, 'local input') } catch {}
      })
    }
    this.emit('status', this.getStatus())
  }

  setDesktopLocked(locked) {
    const next = locked === true
    if (next === this.desktopLocked) return
    this.desktopLocked = next
    if (next) this.stopDesktopControl('screen-locked', false)
    else this.startDesktopCapture()
    this.broadcastDesktopJson({ type: 'stream-state', state: next ? 'paused' : 'streaming', reason: next ? 'screen-locked' : '' })
    this.emit('status', this.getStatus())
  }

  registerDesktopClient(ws, auth) {
    const displays = this.desktopDisplays()
    const selected = displays.find(display => display.primary) || displays[0] || null
    const client = { ws, auth, selectedDisplayId: selected?.id || '', lastHeartbeat: Date.now(), controlReason: '', rateWindow: Date.now(), rateCount: 0 }
    this.desktopClients.add(client)
    this.desktopEndingForLocalInput = false
    let sockets = this.deviceSockets.get(auth.device.id)
    if (!sockets) this.deviceSockets.set(auth.device.id, sockets = new Set())
    if (ws._socket) sockets.add(ws._socket)
    try { this.desktopProvider?.prepare?.() } catch (error) {
      this.log(`Desktop input preparation failed: ${error.stack || error.message}`)
    }

    this.sendDesktopJson(client, {
      type: 'hello',
      version: 1,
      maxFrameEdge: 1280,
      maxFps: 10,
      selectedDisplayId: client.selectedDisplayId,
      desktopAvailable: this.desktopProvider?.isAvailable?.() === true,
      locked: this.desktopLocked
    })
    this.sendDesktopJson(client, { type: 'display-list', displays, selectedDisplayId: client.selectedDisplayId })
    if (!this.desktopController) this.acquireDesktopControl(client)
    else this.sendDesktopJson(client, this.desktopControlView(client))
    this.startDesktopCapture()
    this.emit('status', this.getStatus())

    ws.on('message', (data, isBinary) => this.handleDesktopMessage(client, data, isBinary))
    ws.on('close', () => {
      this.desktopClients.delete(client)
      if (ws._socket) sockets.delete(ws._socket)
      if (sockets.size === 0) this.deviceSockets.delete(auth.device.id)
      if (this.desktopController === client) this.stopDesktopControl('controller-disconnected', true)
      if (this.desktopClients.size === 0) {
        this.stopDesktopCapture()
        this.desktopEndingForLocalInput = false
      }
      this.emit('status', this.getStatus())
    })
    ws.on('error', error => this.log(`Desktop WebSocket error: ${error.message}`))
  }

  handleDesktopMessage(client, data, isBinary) {
    const now = Date.now()
    if (now - client.rateWindow >= 1000) { client.rateWindow = now; client.rateCount = 0 }
    client.rateCount += 1
    if (client.rateCount > 240) {
      client.ws.close(1008, 'rate limit')
      return
    }
    if (isBinary || data.length > DESKTOP_MESSAGE_BYTES) {
      client.ws.close(1008, 'invalid message')
      return
    }
    let message
    try { message = JSON.parse(data.toString('utf8')) } catch {
      client.ws.close(1008, 'invalid json')
      return
    }
    if (!message || typeof message.type !== 'string') {
      client.ws.close(1008, 'invalid message')
      return
    }
    if (message.type === 'heartbeat') {
      client.lastHeartbeat = now
      this.sendDesktopJson(client, this.desktopControlView(client))
      if (this.desktopController === client) this.desktopProvider?.ping?.()
      return
    }
    if (message.type === 'select-display') {
      const displays = this.desktopDisplays()
      const selected = displays.find(display => display.id === String(message.displayId || ''))
      if (!selected) {
        this.sendDesktopJson(client, { type: 'error', code: 'display-not-found', message: '显示器已不可用。' })
        return
      }
      client.selectedDisplayId = selected.id
      this.sendDesktopJson(client, { type: 'display-list', displays, selectedDisplayId: selected.id })
      if (this.desktopController === client) this.emit('status', this.getStatus())
      return
    }
    if (this.desktopController !== client || this.desktopLocked) return
    let valid = false
    if (message.type === 'pointer') {
      valid = POINTER_ACTIONS.has(message.action) && POINTER_BUTTONS.has(message.button) && finiteNumber(message.x, 0, 1) && finiteNumber(message.y, 0, 1)
    } else if (message.type === 'wheel') {
      valid = finiteNumber(message.deltaX, -1200, 1200) && finiteNumber(message.deltaY, -1200, 1200)
    } else if (message.type === 'text') {
      valid = typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 256 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message.text)
    } else if (message.type === 'key') {
      const modifiers = Array.isArray(message.modifiers) ? message.modifiers : []
      valid = ['press', 'down', 'up'].includes(message.action) &&
        (KEY_NAMES.has(message.key) || /^[A-Z0-9]$/.test(message.key)) &&
        modifiers.length <= 3 && modifiers.every(value => MODIFIER_NAMES.has(value))
      if (message.key === 'Delete' && modifiers.includes('Control') && modifiers.includes('Alt')) valid = false
    }
    if (!valid) {
      client.ws.close(1008, 'invalid input')
      return
    }
    try { this.desktopProvider.dispatchInput(client.selectedDisplayId, message) } catch (error) {
      this.log(`Desktop input failed: ${error.stack || error.message}`)
      this.sendDesktopJson(client, { type: 'error', code: 'input-failed', message: '桌面输入暂时不可用。' })
      this.stopDesktopControl('input-failed', false)
    }
  }

  startDesktopCapture() {
    if (this.desktopCaptureTimer || this.desktopLocked || this.desktopClients.size === 0) return
    this.desktopCaptureTimer = setInterval(() => void this.captureDesktopTick(), DESKTOP_FRAME_INTERVAL_MS)
    this.desktopCaptureTimer.unref?.()
    void this.captureDesktopTick()
  }

  stopDesktopCapture() {
    if (this.desktopCaptureTimer) clearInterval(this.desktopCaptureTimer)
    this.desktopCaptureTimer = null
  }

  async captureDesktopTick() {
    if (this.desktopCaptureBusy || this.desktopLocked || this.desktopClients.size === 0) return
    this.desktopCaptureBusy = true
    try {
      const displays = this.desktopDisplays()
      const primary = displays.find(display => display.primary) || displays[0]
      const availableIds = new Set(displays.map(display => display.id))
      for (const client of [...this.desktopClients]) {
        if (Date.now() - client.lastHeartbeat > DESKTOP_HEARTBEAT_TIMEOUT_MS) {
          client.ws.close(1001, 'heartbeat timeout')
          continue
        }
        if (!availableIds.has(client.selectedDisplayId) && primary) {
          client.selectedDisplayId = primary.id
          this.sendDesktopJson(client, { type: 'display-list', displays, selectedDisplayId: primary.id })
        }
      }
      for (const displayId of new Set([...this.desktopClients].map(client => client.selectedDisplayId).filter(Boolean))) {
        const viewers = [...this.desktopClients].filter(client => client.selectedDisplayId === displayId && client.ws.readyState === WebSocket.OPEN && client.ws.bufferedAmount <= DESKTOP_MAX_BUFFERED_BYTES)
        if (viewers.length === 0) continue
        const frame = await this.desktopProvider.captureFrame(displayId)
        if (!Buffer.isBuffer(frame) || frame.length === 0) continue
        for (const client of viewers) {
          if (client.ws.bufferedAmount <= DESKTOP_MAX_BUFFERED_BYTES) client.ws.send(frame, { binary: true })
        }
      }
    } catch (error) {
      this.log(`Desktop capture failed: ${error.stack || error.message}`)
      this.broadcastDesktopJson({ type: 'stream-state', state: 'paused', reason: 'capture-failed' })
    } finally {
      this.desktopCaptureBusy = false
    }
  }

  async createPairing() {
    if (this.server === null || this.remoteUrl === null) throw new Error('请先启用手机远程访问。')
    const pairingId = crypto.randomUUID()
    const secret = base64url(crypto.randomBytes(32))
    const verificationCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = Date.now() + PAIRING_TTL_MS
    this.pairings.set(pairingId, { pairingId, secret, verificationCode, expiresAt, status: 'waiting', claim: null })
    const payload = `dshremote://pair?host=${encodeURIComponent(this.remoteUrl)}&pairingId=${encodeURIComponent(pairingId)}#secret=${encodeURIComponent(secret)}`
    const qrDataUrl = await QRCode.toDataURL(payload, { width: 420, margin: 2, errorCorrectionLevel: 'M' })
    return { pairingId, verificationCode, expiresAt, qrDataUrl, payload }
  }

  approvePairing(pairingId) {
    const pairing = this.pairings.get(pairingId)
    if (!pairing || pairing.expiresAt < Date.now() || pairing.status !== 'pending' || !pairing.claim) {
      throw new Error('配对请求不存在、已过期或尚未由手机提交。')
    }
    const claim = pairing.claim
    const now = new Date().toISOString()
    const existingIndex = this.devices.findIndex((device) => device.id === claim.deviceId)
    const device = {
      id: claim.deviceId,
      name: claim.deviceName,
      publicKey: claim.publicKey,
      tailscaleLogin: claim.tailscaleLogin,
      createdAt: existingIndex >= 0 ? this.devices[existingIndex].createdAt : now,
      lastSeenAt: now,
      revokedAt: null
    }
    if (existingIndex >= 0) this.devices.splice(existingIndex, 1, device)
    else this.devices.push(device)
    pairing.status = 'approved'
    pairing.approvedAt = Date.now()
    this.saveDevices()
    this.emit('pairing', this.getPairingView(pairing))
    this.emit('status', this.getStatus())
    return { device: { ...device, publicKey: undefined } }
  }

  revokeDevice(deviceId) {
    const device = this.devices.find((item) => item.id === deviceId)
    if (!device) throw new Error('找不到该设备。')
    device.revokedAt = new Date().toISOString()
    for (const [token, session] of this.sessions) {
      if (session.deviceId === deviceId) this.sessions.delete(token)
    }
    const sockets = this.deviceSockets.get(deviceId)
    if (sockets) for (const socket of sockets) socket.destroy()
    this.deviceSockets.delete(deviceId)
    this.saveDevices()
    this.emit('status', this.getStatus())
  }

  getPairingView(pairing) {
    return {
      pairingId: pairing.pairingId,
      verificationCode: pairing.verificationCode,
      expiresAt: pairing.expiresAt,
      status: pairing.status,
      deviceName: pairing.claim?.deviceName || '',
      tailscaleLogin: pairing.claim?.tailscaleLogin || ''
    }
  }

  getIdentity(request) {
    if (this.allowPublicTunnel) return PUBLIC_TUNNEL_IDENTITY
    const login = String(request.headers['tailscale-user-login'] || '').trim().toLowerCase()
    if (login.length > 0) return login
    if (this.allowTestIdentity) return String(request.headers['x-dsh-test-identity'] || '').trim().toLowerCase()
    return ''
  }

  validateOrigin(request, allowMissing = false) {
    const origin = String(request.headers.origin || '')
    if (origin.length === 0) return allowMissing
    return this.remoteUrl !== null && origin === this.remoteUrl
  }

  cleanupExpired() {
    const now = Date.now()
    for (const [id, pairing] of this.pairings) if (pairing.expiresAt < now || (pairing.approvedAt && pairing.approvedAt + 60_000 < now)) this.pairings.delete(id)
    for (const [id, challenge] of this.challenges) if (challenge.expiresAt < now || challenge.used) this.challenges.delete(id)
    for (const [token, session] of this.sessions) if (session.expiresAt < now) this.sessions.delete(token)
  }

  findSession(request) {
    this.cleanupExpired()
    const token = parseCookies(request.headers.cookie).get(COOKIE_NAME)
    if (!token) return null
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const session = this.sessions.get(tokenHash)
    if (!session || session.expiresAt < Date.now()) return null
    const device = this.devices.find((item) => item.id === session.deviceId && item.revokedAt === null)
    if (!device) return null
    const identity = this.getIdentity(request)
    if (identity.length === 0 || identity !== device.tailscaleLogin) return null
    return { tokenHash, session, device }
  }

  async handleRequest(request, response) {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      if (url.pathname === `${API_PREFIX}/health` && request.method === 'GET') {
        jsonResponse(response, 200, { ok: true, version: 1, remoteUrl: this.remoteUrl })
        return
      }
      if (url.pathname.startsWith(`${API_PREFIX}/`)) {
        await this.handleControlRequest(request, response, url)
        return
      }
      const auth = this.findSession(request)
      if (!auth) {
        jsonResponse(response, 401, { error: '此设备尚未通过手机远程认证。' })
        return
      }
      if (!this.validateOrigin(request, true)) {
        jsonResponse(response, 403, { error: '请求来源不受信任。' })
        return
      }
      if (url.pathname === MOBILE_COMPAT_PATH && request.method === 'GET') {
        javascriptResponse(response, MOBILE_COMPAT_SCRIPT)
        return
      }
      if (request.method === 'GET' && String(request.headers.accept || '').toLowerCase().includes('text/html')) {
        await this.proxyHtmlWithCompatibility(request, response)
        return
      }
      this.prepareProxyRequest(request)
      this.proxy.web(request, response, { target: this.harnessUrl })
    } catch (error) {
      this.log(`Remote request failed: ${error.stack || error.message}`)
      if (!response.headersSent) jsonResponse(response, 400, { error: error.message || '远程请求失败。' })
    }
  }

  async handleControlRequest(request, response, url) {
    const identity = this.getIdentity(request)
    if (identity.length === 0) {
      jsonResponse(response, 403, { error: '缺少可信连接身份。' })
      return
    }
    if (request.method === 'GET' && (url.pathname === `${API_PREFIX}/drives` || url.pathname === `${API_PREFIX}/desktop/capabilities`)) {
      const auth = this.findSession(request)
      if (!auth) {
        jsonResponse(response, 401, { error: '此设备尚未通过手机远程认证。' })
        return
      }
      if (!this.validateOrigin(request, true)) {
        jsonResponse(response, 403, { error: '请求来源不受信任。' })
        return
      }
      if (url.pathname === `${API_PREFIX}/drives`) {
        jsonResponse(response, 200, { drives: await listDriveRoots() })
      } else {
        const displays = this.desktopDisplays()
        jsonResponse(response, 200, {
          available: this.desktopProvider?.isAvailable?.() === true,
          locked: this.desktopLocked,
          supportsControl: this.desktopProvider?.isAvailable?.() === true,
          maxFrameEdge: 1280,
          maxFps: 10,
          displays
        })
      }
      return
    }
    if (request.method !== 'POST') {
      jsonResponse(response, 405, { error: '仅支持 POST。' }, { Allow: 'POST' })
      return
    }
    const body = await readJsonBody(request)
    if (url.pathname === `${API_PREFIX}/pair/claim`) {
      this.handlePairClaim(identity, body, response)
      return
    }
    if (url.pathname === `${API_PREFIX}/pair/status`) {
      this.handlePairStatus(body, response)
      return
    }
    if (url.pathname === `${API_PREFIX}/session/challenge`) {
      this.handleSessionChallenge(identity, body, response)
      return
    }
    if (url.pathname === `${API_PREFIX}/session/open`) {
      this.handleSessionOpen(identity, body, response)
      return
    }
    if (url.pathname === `${API_PREFIX}/session/close`) {
      const auth = this.findSession(request)
      if (auth) this.sessions.delete(auth.tokenHash)
      jsonResponse(response, 200, { ok: true }, {
        'Set-Cookie': `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`
      })
      return
    }
    jsonResponse(response, 404, { error: '未知远程接口。' })
  }

  handlePairClaim(identity, body, response) {
    this.cleanupExpired()
    const pairing = this.pairings.get(String(body.pairingId || ''))
    if (!pairing || pairing.expiresAt < Date.now() || pairing.status !== 'waiting') {
      jsonResponse(response, 410, { error: '配对码无效或已过期。' })
      return
    }
    if (!timingSafeEqualText(pairing.secret, String(body.secret || ''))) {
      jsonResponse(response, 403, { error: '配对密钥不正确。' })
      return
    }
    const deviceId = String(body.deviceId || '')
    const deviceName = String(body.deviceName || '').trim().slice(0, 80)
    const publicKey = String(body.publicKey || '')
    if (!/^[0-9a-f-]{36}$/i.test(deviceId) || deviceName.length < 1 || publicKey.length < 80 || publicKey.length > 4096) {
      jsonResponse(response, 400, { error: '设备信息无效。' })
      return
    }
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
      if (key.asymmetricKeyType !== 'ec') throw new Error('wrong key type')
    } catch {
      jsonResponse(response, 400, { error: '设备公钥无效。' })
      return
    }
    pairing.claim = { deviceId, deviceName, publicKey, tailscaleLogin: identity }
    pairing.status = 'pending'
    this.emit('pairing', this.getPairingView(pairing))
    jsonResponse(response, 202, { status: 'pending', verificationCode: pairing.verificationCode, expiresAt: pairing.expiresAt })
  }

  handlePairStatus(body, response) {
    this.cleanupExpired()
    const pairing = this.pairings.get(String(body.pairingId || ''))
    if (!pairing || !timingSafeEqualText(pairing.secret, String(body.secret || ''))) {
      jsonResponse(response, 410, { error: '配对请求无效或已过期。' })
      return
    }
    jsonResponse(response, 200, {
      status: pairing.status,
      verificationCode: pairing.verificationCode,
      expiresAt: pairing.expiresAt,
      deviceId: pairing.status === 'approved' ? pairing.claim.deviceId : undefined
    })
  }

  handleSessionChallenge(identity, body, response) {
    const device = this.devices.find((item) => item.id === String(body.deviceId || '') && item.revokedAt === null)
    if (!device || device.tailscaleLogin !== identity) {
      jsonResponse(response, 403, { error: '设备未获授权。' })
      return
    }
    const challengeId = crypto.randomUUID()
    const nonce = base64url(crypto.randomBytes(32))
    const expiresAt = Date.now() + CHALLENGE_TTL_MS
    this.challenges.set(challengeId, { challengeId, nonce, deviceId: device.id, identity, expiresAt, used: false })
    jsonResponse(response, 200, { challengeId, nonce, expiresAt })
  }

  handleSessionOpen(identity, body, response) {
    this.cleanupExpired()
    const challenge = this.challenges.get(String(body.challengeId || ''))
    const device = this.devices.find((item) => item.id === String(body.deviceId || '') && item.revokedAt === null)
    if (!challenge || challenge.used || challenge.expiresAt < Date.now() || !device || challenge.deviceId !== device.id || identity !== device.tailscaleLogin) {
      jsonResponse(response, 403, { error: '认证挑战无效。' })
      return
    }
    const payload = Buffer.from(`dsh-remote-v1|${device.id}|${challenge.challengeId}|${challenge.nonce}`, 'utf8')
    let verified = false
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(device.publicKey, 'base64'), format: 'der', type: 'spki' })
      verified = crypto.verify('sha256', payload, key, Buffer.from(String(body.signature || ''), 'base64'))
    } catch {
      verified = false
    }
    challenge.used = true
    if (!verified) {
      jsonResponse(response, 403, { error: '设备签名无效。' })
      return
    }
    const token = base64url(crypto.randomBytes(32))
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const expiresAt = Date.now() + SESSION_TTL_MS
    this.sessions.set(tokenHash, { deviceId: device.id, identity, expiresAt })
    device.lastSeenAt = new Date().toISOString()
    this.saveDevices()
    jsonResponse(response, 200, { ok: true, expiresAt, remoteUrl: this.remoteUrl }, {
      'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    })
  }

  prepareProxyRequest(request) {
    const target = new URL(this.harnessUrl)
    // Present the harness's own cookie; a paired device's cookie is meaningless
    // upstream and must not be forwarded.
    if (this.harnessCookie === null) delete request.headers.cookie
    else request.headers.cookie = this.harnessCookie
    delete request.headers['tailscale-user-login']
    delete request.headers['tailscale-user-name']
    delete request.headers['tailscale-user-profile-pic']
    request.headers.host = target.host
    if (request.headers.origin) request.headers.origin = target.origin
    if (request.headers.referer) request.headers.referer = `${target.origin}/`
  }

  async proxyHtmlWithCompatibility(request, response) {
    const target = new URL(request.url || '/', this.harnessUrl)
    const headers = { ...request.headers }
    delete headers.host
    // Same as prepareProxyRequest: the upstream needs the harness cookie, not
    // whatever the device presented.
    if (this.harnessCookie === null) delete headers.cookie
    else headers.cookie = this.harnessCookie
    delete headers.connection
    delete headers.upgrade
    delete headers['content-length']
    // The HTML response is patched with the current compatibility script. Do not
    // allow a WebView conditional request to turn it into a 304 and resurrect an
    // older, already-patched document from its cache.
    delete headers['if-match']
    delete headers['if-none-match']
    delete headers['if-modified-since']
    delete headers['if-unmodified-since']
    headers['accept-encoding'] = 'identity'
    if (headers.origin) headers.origin = target.origin
    if (headers.referer) headers.referer = `${target.origin}/`

    const upstream = await fetch(target, { method: 'GET', headers, redirect: 'manual' })
    const body = Buffer.from(await upstream.arrayBuffer())
    const contentType = String(upstream.headers.get('content-type') || '')
    let output = body
    if (contentType.toLowerCase().includes('text/html')) {
      const html = body.toString('utf8')
      // Inline, because an external script is itself a request that can fail — and
      // the case being diagnosed is a blank page where nothing else loads. Without
      // this a failure inside the Android WebView is completely silent.
      const tag = `${BOOT_DIAGNOSTIC_SCRIPT}<script src="${MOBILE_COMPAT_PATH}"></script>`
      const patched = /<head(?:\s[^>]*)?>/i.test(html)
        ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${tag}`)
        : `${tag}${html}`
      output = Buffer.from(patched, 'utf8')
    }

    const outputHeaders = {}
    for (const [name, value] of upstream.headers) {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) {
        outputHeaders[name] = value
      }
    }
    outputHeaders['content-length'] = String(output.length)
    if (contentType.toLowerCase().includes('text/html')) {
      outputHeaders['cache-control'] = 'no-store, no-cache, must-revalidate'
      outputHeaders.pragma = 'no-cache'
      outputHeaders.expires = '0'
      delete outputHeaders.etag
      delete outputHeaders['last-modified']
    }
    response.writeHead(upstream.status, outputHeaders)
    response.end(output)
  }

  handleUpgrade(request, socket, head) {
    const auth = this.findSession(request)
    if (!auth || !this.validateOrigin(request, false) || this.proxy === null) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname === DESKTOP_SOCKET_PATH) {
      if (!this.desktopWss || this.desktopProvider?.isAvailable?.() !== true) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.desktopWss.handleUpgrade(request, socket, head, ws => this.registerDesktopClient(ws, auth))
      return
    }
    this.prepareProxyRequest(request)
    let sockets = this.deviceSockets.get(auth.device.id)
    if (!sockets) this.deviceSockets.set(auth.device.id, sockets = new Set())
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
      if (sockets.size === 0) this.deviceSockets.delete(auth.device.id)
    })
    this.proxy.ws(request, socket, head, { target: this.harnessUrl })
  }
}

module.exports = { RemoteGateway, API_PREFIX, COOKIE_NAME, MOBILE_COMPAT_SCRIPT, listDriveRoots, extractQuickTunnelUrl, tunnelRetryDelayMs, resolveNamedTunnel, renderNamedTunnelConfig, namedTunnelUrl, NAMED_TUNNEL_PROVIDER, QUICK_TUNNEL_PROVIDER }
