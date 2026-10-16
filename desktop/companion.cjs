'use strict'

const { app, BrowserWindow, Menu, Tray, clipboard, desktopCapturer, dialog, ipcMain, powerMonitor, screen, session } = require('electron')
const { appendFileSync, existsSync, mkdirSync } = require('node:fs')
const path = require('node:path')
const { RemoteGateway } = require('./remote-gateway.cjs')
const { createElectronDesktopProvider } = require('./remote-desktop.cjs')
const { trayMenuTemplate, trayTooltip } = require('./tray-menu.cjs')

const DEFAULT_UPSTREAM_URL = 'http://127.0.0.1:32145'

let remoteWindow = null
let remoteGateway = null
let tray = null
let controlIndicators = []
let upstreamUrl = null
let logPath = null
let shutdownStarted = false

function readArgument(name) {
  const prefix = `${name}=`
  const exactIndex = process.argv.indexOf(name)
  if (exactIndex >= 0 && process.argv[exactIndex + 1]) return process.argv[exactIndex + 1]
  const inline = process.argv.find((value) => value.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : null
}

function normalizeUpstream(rawValue) {
  const value = String(rawValue || '').trim()
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:') throw new Error('上游地址必须使用 http://。')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('出于安全考虑，上游地址必须指向本机回环地址。')
  }
  if (!parsed.port) throw new Error('上游地址必须包含端口号。')
  parsed.pathname = '/'
  parsed.search = ''
  parsed.hash = ''
  return parsed.origin
}

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

function trayIconPath() {
  const png = path.join(__dirname, 'build', 'icon.png')
  const ico = path.join(__dirname, 'build', 'icon.ico')
  if (process.platform === 'win32' && existsSync(ico)) return ico
  return existsSync(png) ? png : ico
}

function createTray() {
  if (tray !== null && !tray.isDestroyed()) return
  tray = new Tray(trayIconPath())
  tray.on('double-click', showRemoteWindow)
  tray.on('click', showRemoteWindow)
  updateTrayMenu()
}

async function enableRemote() {
  const status = await remoteGateway.start(upstreamUrl)
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
    icon: path.join(__dirname, 'build', 'icon.png'),
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

async function boot() {
  const logDirectory = path.join(app.getPath('userData'), 'logs')
  mkdirSync(logDirectory, { recursive: true })
  logPath = path.join(logDirectory, 'remote.log')

  upstreamUrl = normalizeUpstream(
    readArgument('--upstream') || process.env.DSH_UPSTREAM_URL || DEFAULT_UPSTREAM_URL
  )
  configureSessionSecurity()
  remoteGateway = new RemoteGateway({
    userDataPath: app.getPath('userData'),
    cloudflaredPath: cloudflaredPath(),
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
