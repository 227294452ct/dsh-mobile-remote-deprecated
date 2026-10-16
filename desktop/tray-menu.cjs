'use strict'

/**
 * Tray menu construction for the desktop companion.
 *
 * Kept separate from `companion.cjs` and free of any Electron import so the menu
 * shape can be asserted in plain Node, without launching Electron or creating a
 * real tray. The tray is the entry point users rely on, so its labels and its
 * enable/disable behaviour are worth testing directly.
 */

/** Placeholders replaced by companion.cjs at runtime. */
const noop = () => {}

function trayMenuTemplate(status, actions = {}) {
  const running = status?.running === true
  const permanent = status?.tunnel?.permanent === true
  const onShow = actions.onShow ?? noop
  const onToggle = actions.onToggle ?? noop
  const onQuit = actions.onQuit ?? noop
  const onCopy = actions.onCopy ?? noop
  const onStopDesktopControl = actions.onStopDesktopControl ?? noop

  const template = [
    { label: '打开配对面板…', click: onShow },
    { type: 'separator' }
  ]

  if (running && status.remoteUrl) {
    template.push(
      {
        label: permanent
          ? `永久地址：${status.tunnel?.hostname ?? status.remoteUrl}`
          : `临时地址：${status.remoteUrl}`,
        enabled: false
      },
      { label: `${status.devices?.length ?? 0} 台设备已配对`, enabled: false },
      { label: '复制手机地址', click: () => onCopy(status.remoteUrl) },
      { type: 'separator' }
    )
  }

  if (status?.desktopControl?.active) {
    template.push(
      { label: `${status.desktopControl.deviceName || '已配对手机'} 正在控制桌面`, enabled: false },
      { label: '立即停止桌面控制', click: onStopDesktopControl },
      { type: 'separator' }
    )
  }

  template.push(
    { label: running ? '暂停手机远程' : '启用手机远程', click: onToggle },
    { type: 'separator' },
    { label: '退出', click: onQuit }
  )

  return template
}

/** The tooltip for a given status, so the two never disagree. */
function trayTooltip(status) {
  if (status?.running !== true) return 'DeepSeek Harness Remote'
  if (status?.tunnel?.permanent === true) {
    return `DeepSeek Harness · 永久地址 · ${status.tunnel?.hostname ?? ''}`
  }
  return 'DeepSeek Harness · 手机远程已启用'
}

/** Labels only, for concise assertions. */
function menuLabels(template) {
  return template.map((item) => (item.type === 'separator' ? '---' : item.label))
}

module.exports = { trayMenuTemplate, trayTooltip, menuLabels }
