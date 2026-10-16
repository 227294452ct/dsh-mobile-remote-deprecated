'use strict'

/**
 * Tray menu assertions.
 *
 * Run: node test-tray-menu.cjs
 *
 * Pure Node, no Electron: the tray is the main entry point, so its labels and
 * actions are asserted directly rather than by launching a desktop window.
 */

const assert = require('node:assert/strict')
const { menuLabels, trayMenuTemplate, trayTooltip } = require('./tray-menu.cjs')

const stopped = {
  running: false,
  remoteUrl: null,
  devices: [],
  tunnel: { provider: 'Cloudflare Quick Tunnel', state: 'Stopped', permanent: false, hostname: null }
}

const runningQuick = {
  running: true,
  remoteUrl: 'https://random-name.trycloudflare.com',
  devices: [{ id: 'a' }],
  tunnel: { provider: 'Cloudflare Quick Tunnel', state: 'Connected', permanent: false, hostname: null }
}

const runningNamed = {
  running: true,
  remoteUrl: 'https://dsh.example.com',
  devices: [{ id: 'a' }, { id: 'b' }],
  tunnel: { provider: 'Cloudflare Named Tunnel', state: 'Connected', permanent: true, hostname: 'dsh.example.com' }
}

// --- stopped ---------------------------------------------------------------

{
  const labels = menuLabels(trayMenuTemplate(stopped, {}))
  assert.deepEqual(labels, ['打开配对面板…', '---', '启用手机远程', '---', '退出'])
  assert.equal(trayTooltip(stopped), 'DeepSeek Harness Remote')
}

// --- running on a quick tunnel ---------------------------------------------
// The address must be labelled 临时 so nobody is told it is stable.

{
  const labels = menuLabels(trayMenuTemplate(runningQuick, {}))
  assert.ok(labels.includes('临时地址：https://random-name.trycloudflare.com'), labels.join(' | '))
  assert.ok(labels.includes('1 台设备已配对'), labels.join(' | '))
  assert.ok(labels.includes('暂停手机远程'))
  assert.ok(!labels.some((label) => label.startsWith('永久地址')), 'a quick tunnel must never read as permanent')
  assert.equal(trayTooltip(runningQuick), 'DeepSeek Harness · 手机远程已启用')
}

// --- running on a named tunnel ---------------------------------------------

{
  const labels = menuLabels(trayMenuTemplate(runningNamed, {}))
  assert.ok(labels.includes('永久地址：dsh.example.com'), labels.join(' | '))
  assert.ok(labels.includes('2 台设备已配对'))
  assert.equal(trayTooltip(runningNamed), 'DeepSeek Harness · 永久地址 · dsh.example.com')
}

// --- device count is live, not a startup snapshot --------------------------

{
  const one = menuLabels(trayMenuTemplate(runningNamed, {}))
  const three = menuLabels(trayMenuTemplate({ ...runningNamed, devices: [{}, {}, {}] }, {}))
  assert.ok(one.includes('2 台设备已配对'))
  assert.ok(three.includes('3 台设备已配对'), 'the count must follow the current status')
}

// --- actions are wired and reachable ---------------------------------------

{
  const calls = []
  const template = trayMenuTemplate(runningNamed, {
    onShow: () => calls.push('show'),
    onToggle: () => calls.push('toggle'),
    onCopy: (url) => calls.push(`copy:${url}`),
    onQuit: () => calls.push('quit'),
    onStopDesktopControl: () => calls.push('stop-desktop')
  })
  const click = (label) => template.find((item) => item.label === label).click()

  click('打开配对面板…')
  click('暂停手机远程')
  click('复制手机地址')
  click('退出')
  assert.deepEqual(calls, ['show', 'toggle', 'copy:https://dsh.example.com', 'quit'])
}

// --- the toggle label follows state ----------------------------------------

{
  const stoppedToggle = trayMenuTemplate(stopped, { onToggle: () => {} })
    .find((item) => item.label === '启用手机远程' || item.label === '暂停手机远程')
  const runningToggle = trayMenuTemplate(runningNamed, { onToggle: () => {} })
    .find((item) => item.label === '启用手机远程' || item.label === '暂停手机远程')
  assert.equal(stoppedToggle.label, '启用手机远程')
  assert.equal(runningToggle.label, '暂停手机远程')
}

// --- desktop control entry appears only while a phone is in control --------

{
  const idle = menuLabels(trayMenuTemplate(runningNamed, {}))
  assert.ok(!idle.some((label) => label.includes('正在控制桌面')))

  const active = menuLabels(trayMenuTemplate({
    ...runningNamed,
    desktopControl: { active: true, deviceName: 'vivo V2454DA' }
  }, {}))
  assert.ok(active.includes('vivo V2454DA 正在控制桌面'), active.join(' | '))
  assert.ok(active.includes('立即停止桌面控制'))
}

{
  // An unnamed controller still gets a readable label.
  const active = menuLabels(trayMenuTemplate({
    ...runningNamed,
    desktopControl: { active: true, deviceName: null }
  }, {}))
  assert.ok(active.includes('已配对手机 正在控制桌面'), active.join(' | '))
}

// --- separators never carry state ------------------------------------------

{
  for (const status of [stopped, runningQuick, runningNamed]) {
    const template = trayMenuTemplate(status, {})
    assert.ok(template.every((item) => (item.type === 'separator') === (item.label === undefined)))
    // A disabled item is informational and must not be clickable.
    for (const item of template) {
      if (item.enabled === false) assert.equal(item.click, undefined, `${item.label} must not be clickable`)
    }
  }
}

console.log('tray-menu-test-ok')
