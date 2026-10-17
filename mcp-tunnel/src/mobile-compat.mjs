// Mobile layout compatibility for phones opening the DeepSeek Harness UI.
//
// Ported from DeepSeek Harness Desktop's `MOBILE_COMPAT_SCRIPT`
// (remote-gateway.cjs, the installRemoteMobileLayout / markRemoteMobileLayout /
// setMobileNavOpen / syncMobileSidebarExpansion / ensureMobileTopbar /
// revealRemoteControls / refreshRemoteCompatibility chain plus its stylesheet).
//
// Scope deliberately limited to layout: the Desktop original also included
// remote-desktop-viewer and drive-bar code tied to its own `/_dsh_remote` API,
// which this gateway does not implement, so those parts were left out rather
// than ported broken.
//
// This is a plain-JS asset served at COMPAT_PATH and injected into every HTML
// document the gateway proxies.

export const MOBILE_LAYOUT_SCRIPT = `'use strict';
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

  const MOBILE_LAYOUT_STYLE_ID = 'dsh-mobile-layout'
  const mobileLayoutCss = [
    '[data-dsh-mobile-sidebar-foot], [data-dsh-mobile-sidebar-settings] { box-sizing: border-box !important; flex: 0 0 auto !important; height: auto !important; min-height: 94px !important; overflow: visible !important; }',
    '[data-dsh-mobile-sidebar-foot] { display: flex !important; flex-direction: column !important; justify-content: flex-end !important; }',
    '[data-dsh-mobile-sidebar-settings] { display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: flex-end !important; gap: 2px !important; }',
    '[data-dsh-mobile-sidebar-column] { min-height: 0 !important; }',
    '[data-dsh-mobile-topbar] { display: none; }',
    '@media (max-width: 720px) and (orientation: portrait) {',
    '  html, body { width: 100%; max-width: 100vw; overflow-x: hidden; }',
    '  [data-dsh-mobile-app-shell] { width: 100% !important; grid-template-columns: minmax(0, 1fr) !important; }',
    '  [data-dsh-mobile-sidebar-column] { position: fixed !important; z-index: 9 !important; top: 56px !important; bottom: 0 !important; left: 0 !important; width: 64px !important; height: calc(100vh - 56px) !important; height: calc(100dvh - 56px) !important; min-height: 0 !important; max-height: calc(100vh - 56px) !important; max-height: calc(100dvh - 56px) !important; visibility: hidden !important; transform: translateX(-110%) !important; transition: none !important; background: rgba(248,250,252,.98) !important; box-shadow: 12px 0 30px rgba(15,23,42,.10) !important; }',
    '  html[data-dsh-mobile-nav-open] [data-dsh-mobile-sidebar-viewport], html[data-dsh-mobile-settings-open] [data-dsh-mobile-sidebar-viewport] { overflow: visible !important; position: relative !important; z-index: 2147483000 !important; }',
    '  html[data-dsh-mobile-nav-open] [data-dsh-mobile-sidebar-column], html[data-dsh-mobile-settings-open] [data-dsh-mobile-sidebar-column] { visibility: visible !important; transform: translateX(0) !important; overflow: visible !important; }',
    '  html[data-dsh-mobile-nav-open] [data-dsh-mobile-sidebar-column][data-dsh-mobile-sidebar-expanded] { width: min(280px, calc(100vw - 24px)) !important; overflow: hidden !important; box-shadow: 16px 0 36px rgba(15,23,42,.14) !important; }',
    '  html[data-dsh-mobile-settings-open] [data-dsh-mobile-sidebar-column] { z-index: 13 !important; width: 64px !important; transform: none !important; box-shadow: none !important; }',
    '  html[data-dsh-mobile-settings-open] [data-dsh-mobile-sidebar-settings] [data-slot="sidebar.settings"] > [role="presentation"] { box-sizing: border-box !important; position: fixed !important; z-index: 11 !important; inset: 56px 0 auto 0 !important; width: 100vw !important; height: calc(100vh - 56px) !important; height: calc(100dvh - 56px) !important; display: flex !important; align-items: stretch !important; justify-content: stretch !important; visibility: visible !important; transform: none !important; overflow: hidden !important; background: #fff !important; }',
    '  html[data-dsh-mobile-settings-open] [data-dsh-mobile-sidebar-settings] [role="dialog"] { box-sizing: border-box !important; width: 100% !important; min-width: 0 !important; max-width: none !important; height: 100% !important; min-height: 0 !important; max-height: none !important; margin: 0 !important; border-radius: 0 !important; visibility: visible !important; overflow: auto !important; }',
    '  [data-dsh-mobile-topbar] { position: fixed; z-index: 2147483001; top: 0; left: 0; right: 0; box-sizing: border-box; height: 56px; display: grid; grid-template-columns: 44px minmax(0, 1fr) auto 44px; align-items: center; gap: 4px; padding: 6px 12px; background: rgba(255,255,255,.96); border-bottom: 1px solid rgba(148,163,184,.16); backdrop-filter: blur(16px); }',
    '  [data-dsh-mobile-topbar] button { box-sizing: border-box !important; min-width: 0 !important; height: 44px !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; gap: 7px !important; padding: 0 8px !important; border: 0 !important; border-radius: 12px !important; background: transparent !important; color: #111827 !important; overflow: hidden !important; white-space: nowrap !important; text-overflow: ellipsis !important; }',
    '  [data-dsh-mobile-topbar] button svg { flex: none !important; width: 23px !important; height: 23px !important; }',
    '  [data-dsh-mobile-action="menu"] { grid-column: 1; padding: 0 !important; }',
    '  [data-dsh-mobile-action="menu"] svg { width: 25px !important; height: 25px !important; }',
    '  [data-dsh-mobile-action="settings"] { grid-column: 4; padding: 0 !important; }',
    '  [data-dsh-mobile-session-header] { min-width: 0 !important; padding: 8px 10px 0 !important; }',
    '  [data-dsh-mobile-session-header] > div:first-child { min-width: 0 !important; gap: 6px !important; }',
    '  [data-dsh-mobile-session-log] { min-width: 0 !important; max-width: 100% !important; min-height: 36px !important; padding-inline: 10px !important; }',
    '  [data-dsh-mobile-session-header] [role="tablist"] { min-width: 0 !important; gap: 24px !important; padding-left: 4px !important; overflow-x: auto !important; scrollbar-width: none; }',
    '  [data-dsh-mobile-session-header] [role="tablist"]::-webkit-scrollbar { display: none; }',
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
    '  [data-dsh-mobile-composer-stack], [data-dsh-mobile-composer-root], [data-dsh-mobile-composer-card], [data-dsh-mobile-composer-row], [data-dsh-mobile-composer-trailing] { box-sizing: border-box !important; min-width: 0 !important; max-width: 100% !important; }',
    '  [data-dsh-mobile-composer-stack], [data-dsh-mobile-composer-root] { width: 100% !important; }',
    '  [data-dsh-mobile-composer-stack] { padding-inline: 0 !important; }',
    '  [data-dsh-mobile-home-composer] { position: fixed !important; inset: 0 !important; box-sizing: border-box !important; height: 100vh !important; height: 100dvh !important; display: flex !important; flex-direction: column !important; align-items: stretch !important; justify-content: flex-start !important; gap: 0 !important; padding: 56px 18px calc(18px + env(safe-area-inset-bottom)) !important; overflow: hidden !important; background: #fff !important; }',
    '  [data-dsh-mobile-home-composer] > svg { display: none !important; }',
    '  [data-dsh-mobile-composer-heading] { position: static !important; transform: none !important; flex: 0 0 auto !important; box-sizing: border-box !important; width: 100% !important; min-width: 0 !important; min-height: 0 !important; height: auto !important; max-height: 122px !important; margin-top: 78px !important; padding-inline: 0 !important; align-items: center !important; justify-content: center !important; }',
    '  [data-dsh-mobile-hero-headline] { display: grid !important; grid-template-columns: auto auto !important; align-items: center !important; justify-content: center !important; column-gap: 12px !important; row-gap: 10px !important; width: 100% !important; min-width: 0 !important; font-size: clamp(25px, 7.5vw, 30px) !important; line-height: 1.2 !important; white-space: nowrap !important; }',
    '  [data-dsh-mobile-hero-mark-wrap] { grid-column: 1 / 3 !important; grid-row: 1 !important; display: grid !important; place-items: center !important; width: 100% !important; height: 58px !important; margin: 0 !important; pointer-events: none !important; }',
    '  [data-dsh-mobile-hero-headline] > [data-dsh-mobile-hero-mark-wrap] + * { grid-column: 1 !important; grid-row: 2 !important; }',
    '  [data-dsh-mobile-hero-headline] > [data-dsh-mobile-hero-mark-wrap] + * + * { grid-column: 2 !important; grid-row: 2 !important; }',
    '  [data-dsh-mobile-hero-mark-wrap] [data-dsh-mobile-hero-mark] { display: contents !important; pointer-events: none !important; }',
    '  [data-dsh-mobile-hero-mark-wrap] svg { display: block !important; width: 66px !important; height: auto !important; max-width: none !important; max-height: 58px !important; pointer-events: none !important; }',
    '  [data-dsh-mobile-workspace-row] { position: static !important; transform: none !important; flex: 0 0 auto !important; box-sizing: border-box !important; width: min(100%, 276px) !important; min-height: 46px !important; margin: 28px auto 0 !important; padding: 4px 10px !important; display: flex !important; align-items: center !important; justify-content: center !important; gap: 0 !important; border: 1px solid #e2e8f0 !important; border-radius: 24px !important; background: rgba(255,255,255,.98) !important; }',
    '  [data-dsh-mobile-workspace-row] > * { min-width: 0 !important; flex: 1 1 0 !important; justify-content: center !important; }',
    '  [data-dsh-mobile-workspace-row] > * + * { border-left: 1px solid #e2e8f0 !important; }',
    '  [data-dsh-mobile-composer-root] { padding-inline: 8px !important; }',
    '  [data-dsh-mobile-home-composer] [data-dsh-mobile-composer-root] { width: 100% !important; margin-top: auto !important; padding-inline: 0 !important; }',
    '  [data-dsh-mobile-composer-card] { position: relative !important; overflow: visible !important; }',
    '  [data-dsh-mobile-home-composer] [data-dsh-mobile-composer-card] { height: 250px !important; min-height: 250px !important; max-height: 250px !important; display: flex !important; flex-direction: column !important; padding: 14px !important; border: 1px solid rgba(37,99,235,.24) !important; border-radius: 26px !important; background: rgba(255,255,255,.98) !important; box-shadow: 0 14px 34px rgba(37,99,235,.10) !important; }',
    '  [data-dsh-mobile-composer-row], [data-dsh-mobile-composer-trailing] { overflow: visible !important; }',
    '  [data-dsh-mobile-home-composer] [data-dsh-mobile-composer-row] { min-height: 82px !important; margin-top: auto !important; display: flex !important; flex-direction: column !important; justify-content: flex-end !important; gap: 14px !important; }',
    '  [data-dsh-mobile-home-composer] [data-dsh-mobile-composer-leading] { display: flex !important; align-items: center !important; gap: 8px !important; }',
    '  [data-dsh-mobile-composer-trailing] { display: grid !important; grid-template-columns: auto minmax(96px, 1fr) auto !important; align-items: center !important; gap: 6px !important; width: 100% !important; position: relative !important; }',
    '  [data-dsh-mobile-home-composer] [data-dsh-mobile-composer-trailing] { grid-template-columns: minmax(62px, auto) minmax(0, 1fr) 42px !important; gap: 8px !important; }',
    '  [data-dsh-mobile-composer-trailing] > * { min-width: 0 !important; max-width: 100% !important; }',
    '  [data-dsh-mobile-composer-trailing] button:not([data-dsh-mobile-send]) { min-width: 0 !important; max-width: 100% !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }',
    '  [data-dsh-mobile-composer-trailing] [role="menu"] { max-width: min(230px, calc(100vw - 80px)) !important; z-index: 2147483000 !important; }',
    '  [data-dsh-mobile-send] { display: grid !important; visibility: visible !important; opacity: 1 !important; flex: 0 0 34px !important; width: 34px !important; min-width: 34px !important; max-width: 34px !important; height: 34px !important; margin-left: 4px !important; position: relative !important; z-index: 2 !important; }',
    '  [data-dsh-mobile-home-composer] [data-dsh-mobile-send] { width: 42px !important; min-width: 42px !important; max-width: 42px !important; height: 42px !important; margin-left: 0 !important; border-radius: 50% !important; }',
    '}',
    '@media (max-width: 420px) and (orientation: portrait) {',
    '  [data-dsh-mobile-session-log] { width: 36px !important; padding: 0 !important; justify-content: center !important; }',
    '  [data-dsh-mobile-session-log] span { display: none !important; }',
    '}'
  ].join('\\n')

  const installRemoteMobileLayout = () => {
    if (document.getElementById(MOBILE_LAYOUT_STYLE_ID)) return
    const style = document.createElement('style')
    style.id = MOBILE_LAYOUT_STYLE_ID
    style.setAttribute('data-dsh-mobile-layout', '')
    style.textContent = mobileLayoutCss
    ;(document.head || document.documentElement).appendChild(style)
  }

  const markRemoteMobileLayout = () => {
    if (!document.querySelector('[data-dsh-mobile-session-log]')) {
      document.querySelectorAll('button').forEach(button => {
        if (!(button.textContent || '').trim().startsWith('Session log')) return
        button.setAttribute('data-dsh-mobile-session-log', '')
        if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', 'Session log')
        if (!button.getAttribute('title')) button.setAttribute('title', 'Session log')
        const utilities = button.parentElement
        if (utilities) utilities.setAttribute('data-dsh-mobile-header-utilities', '')
        const header = button.closest('header')
        if (header) header.setAttribute('data-dsh-mobile-session-header', '')
      })
    }
    document.querySelectorAll('button[aria-label="发送消息"],button[aria-label="Send message"]').forEach(button => {
      button.setAttribute('data-dsh-mobile-send', '')
      const trailing = button.parentElement
      const row = trailing && trailing.parentElement
      const card = row && row.parentElement
      const root = card && card.parentElement
      if (trailing) trailing.setAttribute('data-dsh-mobile-composer-trailing', '')
      if (row) row.setAttribute('data-dsh-mobile-composer-row', '')
      if (card) card.setAttribute('data-dsh-mobile-composer-card', '')
      if (root) root.setAttribute('data-dsh-mobile-composer-root', '')
      if (row && row.firstElementChild) row.firstElementChild.setAttribute('data-dsh-mobile-composer-leading', '')
      const slot = button.closest('[data-slot="conversation.composer.bar"]')
      if (slot && slot.parentElement) {
        const stack = slot.parentElement
        stack.setAttribute('data-dsh-mobile-composer-stack', '')
        const heroMark = Array.from(stack.querySelectorAll('[data-slot]')).find(node => node.getAttribute('data-slot') === 'conversation.hero.brand.mark')
        const heading = heroMark
          ? Array.from(stack.children).find(child => child.contains(heroMark))
          : Array.from(stack.children).find(child => child !== slot && child.tagName !== 'svg' && (child.textContent || '').trim() && child.getBoundingClientRect().height > 0)
        if (heading) {
          stack.setAttribute('data-dsh-mobile-home-composer', '')
          heading.setAttribute('data-dsh-mobile-composer-heading', '')
        }
        if (heroMark) {
          heroMark.setAttribute('data-dsh-mobile-hero-mark', '')
          if (heroMark.parentElement) {
            heroMark.parentElement.setAttribute('data-dsh-mobile-hero-mark-wrap', '')
            if (heroMark.parentElement.parentElement) heroMark.parentElement.parentElement.setAttribute('data-dsh-mobile-hero-headline', '')
          }
        }
        const workspaceButton = Array.from(stack.querySelectorAll('button')).find(node => node.getAttribute('aria-label') === '选择工作区')
        if (workspaceButton) {
          const workspaceRow = Array.from(stack.children).find(child => child.contains(workspaceButton))
          if (workspaceRow) workspaceRow.setAttribute('data-dsh-mobile-workspace-row', '')
        }
      }
    })
  }

  const menuIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 6h16M4 12h16M4 18h16"/></svg>'
  const settingsIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.07a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.53-1H3v-4h.07A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.97 4.6 1.7 1.7 0 0 0 10 3.07V3h4v.07a1.7 1.7 0 0 0 1.03 1.53 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.62.66 1.08 1.3 1.08H21v4h-.3c-.64 0-1.18.45-1.3.92Z"/></svg>'

  const setMobileNavOpen = open => {
    const sidebar = document.querySelector('[data-dsh-mobile-sidebar-column]')
    if (!sidebar) return
    const mobilePortrait = matchMedia('(max-width: 720px) and (orientation: portrait)').matches
    const nextOpen = mobilePortrait && Boolean(open)
    const settingsOpen = mobilePortrait && Boolean(document.querySelector('[data-dsh-mobile-sidebar-settings] button[aria-haspopup="dialog"][aria-expanded="true"],[data-dsh-mobile-sidebar-settings] [data-slot="sidebar.settings"] > [role="presentation"] [role="dialog"]'))
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
    const settingsOverlay = settingsOpen && document.querySelector('[data-dsh-mobile-sidebar-settings] [data-slot="sidebar.settings"] > [role="presentation"]')
    if (settingsOverlay) {
      settingsOverlay.style.removeProperty('transform')
      const offset = -settingsOverlay.getBoundingClientRect().left
      settingsOverlay.style.setProperty('transform', 'translateX(' + offset + 'px)', 'important')
    }
  }

  const syncMobileSidebarExpansion = () => {
    const sidebar = document.querySelector('[data-dsh-mobile-sidebar-column]')
    if (!sidebar) return
    const inlineWidth = Number.parseFloat(sidebar.style.getPropertyValue('width'))
    const expandedControl = sidebar.querySelector('button[aria-label="收起侧边栏"],button[aria-label="Collapse sidebar"],button[aria-label="搜索会话"][aria-expanded="true"],button[aria-label="Search conversations"][aria-expanded="true"]')
    sidebar.toggleAttribute('data-dsh-mobile-sidebar-expanded', inlineWidth > 96 || Boolean(expandedControl))
  }

  const ensureMobileTopbar = () => {
    const heroMark = document.querySelector('[data-dsh-mobile-hero-mark]')
    const settings = document.querySelector('[data-dsh-mobile-sidebar-settings] button[aria-haspopup="dialog"]')
    const sidebar = document.querySelector('[data-dsh-mobile-sidebar-column]')
    if (!sidebar || !settings) return
    sidebar.setAttribute('data-dsh-mobile-sidebar-root', '')
    if (sidebar.parentElement) sidebar.parentElement.setAttribute('data-dsh-mobile-app-shell', '')
    if (sidebar.parentElement && sidebar.parentElement.parentElement) sidebar.parentElement.parentElement.setAttribute('data-dsh-mobile-sidebar-viewport', '')
    if (!document.querySelector('[data-dsh-mobile-sidebar-settings]')) {
      const settingsHost = settings.closest('div') || settings.parentElement
      if (settingsHost) settingsHost.setAttribute('data-dsh-mobile-sidebar-settings', '')
    }
    const foot = sidebar.lastElementChild
    if (foot) foot.setAttribute('data-dsh-mobile-sidebar-foot', '')
    let bar = document.querySelector('[data-dsh-mobile-topbar]')
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
      bar.setAttribute('data-dsh-mobile-topbar', '')
      ;['menu', 'settings'].forEach(action => {
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
        const source = document.querySelector('[data-dsh-mobile-sidebar-settings] button[aria-haspopup="dialog"]')
        if (source) {
          const inertRoot = source.closest('[inert]')
          if (inertRoot) inertRoot.inert = false
          source.click()
        }
        setMobileNavOpen(false)
        setTimeout(() => setMobileNavOpen(false), 0)
        requestAnimationFrame(() => setMobileNavOpen(false))
      })
      document.body.appendChild(bar)
    }
    const sources = { menu: null, settings }
    Object.entries(sources).forEach(([action, source]) => {
      const proxy = bar.querySelector('[data-dsh-mobile-action="' + action + '"]')
      const html = action === 'menu' ? menuIcon : settingsIcon
      if (proxy && proxy.innerHTML !== html) proxy.innerHTML = html
      if (proxy) proxy.className = ''
      if (proxy) proxy.setAttribute('aria-label', action === 'menu' ? '打开导航' : ((source && source.getAttribute('aria-label')) || action) + '快捷方式')
    })
    syncMobileSidebarExpansion()
    setMobileNavOpen(document.documentElement.hasAttribute('data-dsh-mobile-nav-open'))
    void heroMark
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

  if (!document.documentElement.hasAttribute('data-dsh-mobile-marked')) {
    document.documentElement.setAttribute('data-dsh-mobile-marked', '')
  }
})();
`
