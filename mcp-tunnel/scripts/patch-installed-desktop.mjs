// Replace remote-gateway.cjs inside an installed DeepSeek Harness Desktop
// app.asar, so the shipped app gets permanent-tunnel support without rebuilding
// the 225 MB executable.
//
// This uses the official @electron/asar library. An earlier hand-rolled version
// of this script mis-parsed the asar header and corrupted the archive; do not
// reimplement the container format here.
//
//   node scripts/patch-installed-desktop.mjs --check
//   node scripts/patch-installed-desktop.mjs
//   node scripts/patch-installed-desktop.mjs --restore

import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const restore = args.includes('--restore')

const TARGET_FILE = 'remote-gateway.cjs'
const MARKERS = ['NAMED_TUNNEL_PROVIDER', 'startNamedTunnel', 'readNamedTunnelConfig']

function defaultAsarPath() {
  if (!process.env.LOCALAPPDATA) return null
  return path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness Desktop', 'resources', 'app.asar')
}

function defaultSourcePath() {
  const candidates = [
    'E:\\Deepseek harness\\zhuomianjiangou-0.1.5-rc.3\\remote-gateway.cjs',
    'E:\\Deepseek harness\\zhuomianjiangou\\remote-gateway.cjs',
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function loadAsar() {
  // @electron/asar is a transitive dependency of electron-builder; resolve it
  // from the Desktop project rather than adding a second copy here.
  const roots = [
    'E:\\Deepseek harness\\zhuomianjiangou-0.1.5-rc.3',
    'E:\\Deepseek harness',
    process.cwd(),
  ]
  for (const root of roots) {
    try {
      return createRequire(path.join(root, 'noop.js'))('@electron/asar')
    } catch {
      // try the next root
    }
  }
  try {
    return require('@electron/asar')
  } catch {
    return null
  }
}

const asarPath = defaultAsarPath()
if (!asarPath || !existsSync(asarPath)) {
  console.error(`app.asar not found: ${asarPath}`)
  process.exit(1)
}
const backupPath = `${asarPath}.orig-tunnel-mcp`
const sourcePath = defaultSourcePath()

const asar = loadAsar()
if (!asar || typeof asar.extractAll !== 'function' || typeof asar.createPackage !== 'function') {
  console.error('@electron/asar is not available; install it before patching (or rebuild the app instead).')
  process.exit(1)
}

const report = {
  asarPath,
  asarSize: statSync(asarPath).size,
  sourcePath,
  backupPath,
  hasBackup: existsSync(backupPath),
  targetFile: TARGET_FILE,
}

if (restore) {
  if (!existsSync(backupPath)) {
    console.error(`No backup to restore at ${backupPath}`)
    process.exit(1)
  }
  copyFileSync(backupPath, asarPath)
  report.restored = true
  report.note = 'Restart DeepSeek Harness Desktop for the restore to take effect.'
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

if (!sourcePath || !existsSync(sourcePath)) {
  console.error(`patched ${TARGET_FILE} not found: ${sourcePath}`)
  process.exit(1)
}
const newSource = readFileSync(sourcePath)
report.newSourceSize = newSource.length

// Read the current payload through the official extractor so the check is honest.
const probeDir = path.join(os.tmpdir(), `dsh-asar-probe-${Date.now()}`)
mkdirSync(probeDir, { recursive: true })
try {
  asar.extractAll(asarPath, probeDir)
  const installed = readFileSync(path.join(probeDir, TARGET_FILE), 'utf8')
  report.installedSize = Buffer.byteLength(installed)
  report.installedHasPatchedCode = MARKERS.every((marker) => installed.includes(marker))
} catch (error) {
  report.extractError = error.message
} finally {
  rmSync(probeDir, { recursive: true, force: true })
}

if (checkOnly) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

if (report.installedHasPatchedCode) {
  report.action = 'already-patched'
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

// Back up the pristine archive once.
if (!report.hasBackup) {
  copyFileSync(asarPath, backupPath)
  report.backupCreated = true
}

// Repack: extract, swap the one file, rebuild. The official library writes a
// container that matches Electron's expectations, including integrity fields.
const workDir = path.join(os.tmpdir(), `dsh-asar-repack-${Date.now()}`)
mkdirSync(workDir, { recursive: true })
try {
  asar.extractAll(asarPath, workDir)
  const targetInWork = path.join(workDir, TARGET_FILE)
  if (!existsSync(targetInWork)) throw new Error(`${TARGET_FILE} missing after extraction`)
  copyFileSync(sourcePath, targetInWork)

  const tempArchive = `${asarPath}.repack`
  rmSync(tempArchive, { force: true })
  await asar.createPackage(workDir, tempArchive)

  // Verify the repacked archive before letting it replace the installed one.
  const verifyDir = path.join(os.tmpdir(), `dsh-asar-verify-${Date.now()}`)
  mkdirSync(verifyDir, { recursive: true })
  try {
    asar.extractAll(tempArchive, verifyDir)
    const verifySource = readFileSync(path.join(verifyDir, TARGET_FILE), 'utf8')
    report.verified = MARKERS.every((marker) => verifySource.includes(marker))
      && Buffer.byteLength(verifySource) === newSource.length
    report.verifiedSize = Buffer.byteLength(verifySource)
  } finally {
    rmSync(verifyDir, { recursive: true, force: true })
  }

  if (!report.verified) {
    rmSync(tempArchive, { force: true })
    console.error(JSON.stringify({ ...report, error: 'verification failed; archive not installed' }, null, 2))
    process.exit(1)
  }

  copyFileSync(tempArchive, asarPath)
  rmSync(tempArchive, { force: true })
  report.written = true
  report.newArchiveSize = statSync(asarPath).size
  report.note = 'Restart DeepSeek Harness Desktop so the patched main process loads.'
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

console.log(JSON.stringify(report, null, 2))
