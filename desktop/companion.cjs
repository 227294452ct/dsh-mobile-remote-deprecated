'use strict'

const { app, BrowserWindow, Menu, Tray, clipboard, desktopCapturer, dialog, ipcMain, powerMonitor, screen, session } = require('electron')
const { appendFileSync, existsSync, mkdirSync } = require('node:fs')
const path = require('node:path')
const { RemoteGateway } = require('./remote-gateway.cjs')
const { createElectronDesktopProvider } = require('./remote-desktop.cjs')
const { trayMenuTemplate, trayTooltip } = require('./tray-menu.cjs')
const { readArgument, resolveHostname, resolveUpstreamWithDiscovery } = require('./startup-options.cjs')
const { findHarnessToken } = require('./harness-token.cjs')

let remoteWindow = null
let remoteGateway = null
let tray = null
let controlIndicators = []
let upstreamUrl = null
let logPath = null
let shutdownStarted = false

function writeLog(message) {
  if (!logPath) return
  const line = `[${new Date().toISOString()}] ${String(message)}\n`
  try {
    appendFileSync(logPath, line, 'utf8')
  } catch {
    // Logging must never interrupt the gateway.
  }
}

function cloudflaredPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'cloudflared.exe')
    : path.join(__dirname, 'vendor', 'cloudflared.exe')
}

function configureSessionSecurity() {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

function currentStatus() {
  return remoteGateway?.getStatus() || {
    running: false,
    remoteUrl: null,
    devices: [],
    tunnel: { installed: false, state: 'Stopped' }
  }
}

function broadcastStatus() {
  if (remoteWindow && !remoteWindow.isDestroyed()) {
    remoteWindow.webContents.send('remote:status', currentStatus())
  }
  // The tray shows the live address and pairing count, so it has to follow the
  // same status stream as the window.
  updateTrayMenu()
}

function showControlIndicator(state) {
  if (!state?.active) {
    for (const indicator of controlIndicators) if (!indicator.isDestroyed()) indicator.destroy()
    controlIndicators = []
    return
  }
  const displays = screen.getAllDisplays()
  while (controlIndicators.length > displays.length) controlIndicators.pop()?.destroy()
  displays.forEach((display, index) => {
    let controlIndicator = controlIndicators[index]
    if (!controlIndicator || controlIndicator.isDestroyed()) {
      controlIndicator = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: false,
      backgroundColor: '#020617',
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, 'control-indicator-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
      })
      controlIndicator.setContentProtection(true)
      controlIndicator.setIgnoreMouseEvents(true)
      controlIndicator.setAlwaysOnTop(true, 'screen-saver')
      controlIndicator.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      controlIndicator.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      controlIndicator.webContents.on('will-navigate', event => event.preventDefault())
      void controlIndicator.loadFile(path.join(__dirname, 'control-indicator.html'))
      controlIndicators[index] = controlIndicator
    }
    controlIndicator.setBounds(display.bounds, false)
    controlIndicator.showInactive()
    const sendState = () => !controlIndicator.isDestroyed() && controlIndicator.webContents.send('remote:desktop-control', state)
    if (controlIndicator.webContents.isLoadingMainFrame()) controlIndicator.webContents.once('did-finish-load', sendState)
    else sendState()
  })
}

/**
 * Bring the pairing panel to the front, creating it if the user closed it.
 *
 * Closing the window must not tear down the tunnel — the phone keeps working
 * while the panel is hidden, which is the whole point of running in the tray.
 */
function showRemoteWindow() {
  if (remoteWindow === null || remoteWindow.isDestroyed()) {
    void createRemoteWindow()
    return
  }
  if (remoteWindow.isMinimized()) remoteWindow.restore()
  remoteWindow.show()
  remoteWindow.focus()
}

/**
 * Rebuild the tray menu from live gateway status.
 *
 * Called on every status change so the labels and the control entry always
 * reflect reality instead of a snapshot taken at startup.
 */
function updateTrayMenu() {
  if (tray === null || tray.isDestroyed()) return
  const status = currentStatus()
  const template = trayMenuTemplate(status, {
    onShow: showRemoteWindow,
    onToggle: () => {
      void (status.running === true ? disableRemote() : enableRemote()).catch((error) => {
        dialog.showErrorBox('手机远程', error instanceof Error ? error.message : String(error))
      })
    },
    onCopy: (url) => clipboard.writeText(url),
    onQuit: () => { shutdownStarted = true; app.quit() },
    onStopDesktopControl: () => remoteGateway?.stopDesktopControl('local-stop', false)
  })
  tray.setContextMenu(Menu.buildFromTemplate(template))
  tray.setToolTip(trayTooltip(status))
}

function createTray() {
  if (tray !== null && !tray.isDestroyed()) return
  // The tray is a convenience, not a correctness requirement. A missing or
  // unreadable icon must not take the whole app down, because the phone gateway
  // is perfectly usable from the pairing window alone.
  const icon = resolveIconPath()
  try {
    tray = new Tray(icon ?? undefined)
  } catch (error) {
    writeLog(`Tray unavailable: ${error instanceof Error ? error.message : String(error)}`)
    tray = null
    return
  }
  tray.on('double-click', showRemoteWindow)
  tray.on('click', showRemoteWindow)
  try {
    updateTrayMenu()
  } catch (error) {
    writeLog(`Tray menu failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Obtain the harness auth token.
 *
 * Precedence: an explicit value, then the one recovered from the running harness
 * process. The harness mints its token at startup and never writes it to disk, so
 * attaching to an instance the user already has running means reading it from
 * that process's memory. A failure is logged and tolerated: the gateway still
 * starts, and the pairing window explains what the phone will see.
 */
async function resolveHarnessToken() {
  const explicit = readArgument('--harness-token') || process.env.DSH_HARNESS_TOKEN || null
  if (explicit) {
    writeLog('Harness token: supplied explicitly')
    return explicit
  }

  const upstream = (() => {
    try {
      return new URL(upstreamUrl ?? '')
    } catch {
      return null
    }
  })()
  const port = upstream?.port ? Number(upstream.port) : null
  writeLog(`Harness token: recovering from the running harness (port ${port ?? 'auto'})...`)
  const found = await findHarnessToken({ port, log: writeLog })
  if (!found.ok) {
    writeLog(`Harness token unavailable: ${found.error}`)
    return null
  }
  writeLog(`Harness token recovered (port ${found.port}, pid ${found.pid}, ${found.candidates} candidate(s))`)
  return found.token
}

async function enableRemote() {
  // DSH 0.1.5+ refuses unauthenticated loopback requests, so the harness token
  // has to be presented upstream or every paired phone sees the "dsh web
  // authentication required" page instead of the interface.
  const token = await resolveHarnessToken()
  const status = await remoteGateway.start(upstreamUrl, token)
  broadcastStatus()
  updateTrayMenu()
  return status
}

async function disableRemote() {
  await remoteGateway.stop(true)
  broadcastStatus()
  updateTrayMenu()
  return currentStatus()
}

function registerIpc() {
  ipcMain.handle('remote:get-status', () => currentStatus())
  ipcMain.handle('remote:enable', () => enableRemote())
  ipcMain.handle('remote:disable', () => disableRemote())
  ipcMain.handle('remote:create-pairing', () => remoteGateway.createPairing())
  ipcMain.handle('remote:approve-pairing', (_event, pairingId) => remoteGateway.approvePairing(String(pairingId)))
  ipcMain.handle('remote:revoke-device', (_event, deviceId) => remoteGateway.revokeDevice(String(deviceId)))
  ipcMain.handle('remote:stop-desktop-control', () => remoteGateway.stopDesktopControl('local-stop', false))
}

function createRemoteWindow() {
  remoteWindow = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 700,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#07111f',
    icon: resolveIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'remote-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false
    }
  })
  remoteWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  remoteWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  remoteWindow.once('ready-to-show', () => remoteWindow?.show())
  remoteWindow.on('closed', () => { remoteWindow = null })
  return remoteWindow.loadFile(path.join(__dirname, 'remote.html'))
}

/**
 * Pick an icon that actually exists.
 *
 * Electron throws from `new BrowserWindow({icon})` when the path is missing,
 * which turns a cosmetic problem into a failed launch. Prefer the packaged ICO
 * on Windows and fall back to the PNG, then to no icon at all.
 */
function resolveIconPath() {
  const candidates = process.platform === 'win32'
    ? [path.join(__dirname, 'build', 'icon.ico'), path.join(__dirname, 'build', 'icon.png')]
    : [path.join(__dirname, 'build', 'icon.png'), path.join(__dirname, 'build', 'icon.ico')]
  return candidates.find((candidate) => existsSync(candidate)) ?? undefined
}

async function boot() {
  const logDirectory = path.join(app.getPath('userData'), 'logs')
  mkdirSync(logDirectory, { recursive: true })
  logPath = path.join(logDirectory, 'remote.log')

  // Both options decide whether a phone keeps its pairing after a restart, so
  // they are resolved by the tested startup-options module rather than inline.
  // The upstream is auto-discovered when not given, so the app works without
  // being told which port the harness happens to be on.
  const upstream = await resolveUpstreamWithDiscovery()
  upstreamUrl = upstream.origin
  const hostname = resolveHostname()
  writeLog(`Starting: upstream=${upstreamUrl} (${upstream.source}) hostname=${hostname ?? '(none, will use a temporary address)'}`)
  configureSessionSecurity()
  remoteGateway = new RemoteGateway({
    userDataPath: app.getPath('userData'),
    cloudflaredPath: cloudflaredPath(),
    hostname,
    // Lets the gateway recover on its own when a harness restart invalidates the
    // cookie captured at launch, instead of every phone falling back to the
    // auth-required page until the companion is restarted.
    harnessTokenProvider: resolveHarnessToken,
    log: writeLog,
    desktopProvider: createElectronDesktopProvider({
      desktopCapturer,
      screen,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      log: writeLog
    })
  })
  remoteGateway.on('status', broadcastStatus)
  remoteGateway.on('pairing', (pairing) => {
    if (remoteWindow && !remoteWindow.isDestroyed()) remoteWindow.webContents.send('remote:pairing', pairing)
  })
  remoteGateway.on('desktop-control', showControlIndicator)
  powerMonitor.on('lock-screen', () => remoteGateway.setDesktopLocked(true))
  powerMonitor.on('unlock-screen', () => remoteGateway.setDesktopLocked(false))
  // Report the resolved tunnel up front: it is decided by hostname/credentials
  // availability, so knowing it before the first connect explains why an address
  // is or is not permanent.
  const planned = remoteGateway.namedTunnel
  writeLog(planned
    ? `Tunnel: permanent named tunnel ${planned.hostname} (id ${planned.tunnelId})`
    : 'Tunnel: no named tunnel configured, will fall back to a temporary address')
  registerIpc()
  // The tray is created before the window so the app is reachable even if the
  // window fails to open, and it survives the window being closed.
  createTray()
  await createRemoteWindow()
  try {
    await enableRemote()
  } catch (error) {
    writeLog(error instanceof Error ? error.stack || error.message : String(error))
    broadcastStatus()
    dialog.showErrorBox(
      'DeepSeek Harness Remote',
      `无法连接本机 Harness：${upstreamUrl}\n\n请先启动 Harness Web 服务，或使用 --upstream 指定地址。\n\n${error instanceof Error ? error.message : String(error)}`
    )
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showRemoteWindow()
  })
  app.whenReady().then(boot).catch((error) => {
    dialog.showErrorBox('DeepSeek Harness Remote 启动失败', error instanceof Error ? error.message : String(error))
    app.quit()
  })
  // Closing the pairing panel must not stop the tunnel: the phone stays
  // connected through the tray, which is the only way to keep a long-lived
  // session across a desktop window being closed.
  app.on('window-all-closed', () => {
    // Intentionally left resident in the tray.
  })
  app.on('before-quit', (event) => {
    if (shutdownStarted) return
    event.preventDefault()
    shutdownStarted = true
    Promise.resolve(remoteGateway?.stop(true)).finally(() => {
      tray?.destroy()
      app.exit(0)
    })
  })
}

// Exported for the headless tray test; the application lifecycle above only
// runs when this file is the Electron entry point.
module.exports = { updateTrayMenu }
