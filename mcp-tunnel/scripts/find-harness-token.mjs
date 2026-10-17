// Recover the running DeepSeek Harness instance's auth token from process memory.
//
// Why: DSH rejects even loopback requests without auth. It mints a random token
// at startup, embeds it in the URL `http://127.0.0.1:<port>/?token=<43 chars>`
// and hands that URL to the process that spawned it (the Electron main
// process). The token is never written to disk, so the only way to reuse the
// instance the user is already running — without restarting it — is to read it
// out of that process's readable memory.
//
// This is read-only: OpenProcess + VirtualQueryEx + ReadProcessMemory. Nothing
// is written to the target. Every candidate is verified against the live HTTP
// server before it is accepted, so a false positive cannot be reported as a hit.
//
//   node scripts/find-harness-token.mjs            # auto-detect port+pid
//   node scripts/find-harness-token.mjs --port 19387 --pid 16512
//   node scripts/find-harness-token.mjs --write    # cache to the tunnel state dir

import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const writeCache = args.includes('--write')
const portIndex = args.indexOf('--port')
const pidIndex = args.indexOf('--pid')
const explicitPort = portIndex >= 0 ? Number(args[portIndex + 1]) : null
const explicitPid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : null

const TOKEN_RE = /token=([A-Za-z0-9_-]{20,64})/g
// The token is a 43-char base64url string (32 bytes). It also appears in memory
// as a bare value once the URL has been parsed, so match that shape too and let
// HTTP verification reject false positives.
const BARE_TOKEN_RE = /\b([A-Za-z0-9_-]{43})\b/g
const MAX_REGION_BYTES = 64 * 1024 * 1024

/**
 * Locate the native koffi addon inside the DSH install.
 * Walks the whole unpacked tree (bounded) rather than guessing directory
 * names — the addon sits at
 * `dsh/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node`.
 */
function findKoffi() {
  const roots = [
    'E:\\DSH\\resources\\app.asar.unpacked',
    'E:\\DSH\\resources',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness Desktop', 'resources', 'app.asar.unpacked')
      : null,
  ].filter(Boolean)

  const MAX_DIRS = 20_000
  for (const root of roots) {
    if (!existsSync(root)) continue
    const stack = [{ dir: root, depth: 0 }]
    let visited = 0
    while (stack.length > 0 && visited < MAX_DIRS) {
      const { dir, depth } = stack.pop()
      visited += 1
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          // koffi.node is 4 levels down from the unpacked root.
          if (depth < 8) stack.push({ dir: full, depth: depth + 1 })
          continue
        }
        if (entry.name === 'koffi.node') return { addon: full, dir }
      }
    }
  }
  return null
}

const koffiLocation = findKoffi()
if (!koffiLocation) {
  console.error(JSON.stringify({ ok: false, error: 'koffi.node not found in the DSH install' }, null, 2))
  process.exit(1)
}

const { createRequire } = await import('node:module')
const requireFrom = createRequire(path.join(koffiLocation.dir, 'noop.cjs'))

let koffi
try {
  koffi = requireFrom(koffiLocation.addon)
  if (typeof koffi?.load !== 'function') throw new Error('unexpected koffi exports')
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: `koffi load failed: ${error.message}`, addon: koffiLocation.addon }, null, 2))
  process.exit(1)
}

const kernel32 = koffi.load('kernel32.dll')

const PROCESS_QUERY_INFORMATION = 0x0400
const PROCESS_VM_READ = 0x0010

const MEM_COMMIT = 0x1000
const PAGE_READONLY = 0x02
const PAGE_READWRITE = 0x04
const PAGE_WRITECOPY = 0x08
const PAGE_EXECUTE_READ = 0x20
const PAGE_EXECUTE_READWRITE = 0x40
const PAGE_EXECUTE_WRITECOPY = 0x80
const PAGE_GUARD = 0x100
const PAGE_NOACCESS = 0x01
const READABLE = PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY

const MEMORY_BASIC_INFORMATION = koffi.struct('MEMORY_BASIC_INFORMATION', {
  BaseAddress: 'void *',
  AllocationBase: 'void *',
  AllocationProtect: 'uint32',
  PartitionId: 'uint16',
  __pad: 'uint16',
  RegionSize: 'uintptr',
  State: 'uint32',
  Protect: 'uint32',
  Type: 'uint32',
  __pad2: 'uint32',
})
// The packaged addon ships without koffi's JS wrapper, so `koffi.sizeof` is
// unavailable; the type object exposes its own size.
const MBI_SIZE = MEMORY_BASIC_INFORMATION.size ?? MEMORY_BASIC_INFORMATION.sizeof

const OpenProcess = kernel32.func('void *OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)')
const CloseHandle = kernel32.func('int CloseHandle(void *hObject)')
const VirtualQueryEx = kernel32.func('uintptr VirtualQueryEx(void *hProcess, void *lpAddress, _Out_ MEMORY_BASIC_INFORMATION *lpBuffer, uintptr dwLength)')
const ReadProcessMemory = kernel32.func('int ReadProcessMemory(void *hProcess, void *lpBaseAddress, _Out_ uint8_t *lpBuffer, uintptr nSize, _Out_ uintptr *lpNumberOfBytesRead)')

/** Find the pid listening on a loopback port, via netstat. */
async function pidForPort(port) {
  const { execFile } = await import('node:child_process')
  const out = await new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout))
  })
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
    if (match && Number(match[1]) === port) return Number(match[2])
  }
  return null
}

/** Ports the DeepSeek Harness processes are listening on. */
async function dshListeningPorts() {
  const { execFile } = await import('node:child_process')
  const run = (cmd, cmdArgs) => new Promise((resolve) => {
    execFile(cmd, cmdArgs, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : stdout))
  })
  const [netstat, procs] = await Promise.all([
    run('netstat', ['-ano', '-p', 'TCP']),
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'DeepSeek Harness' } | ForEach-Object { \"$($_.ProcessId)\" }"]),
  ])
  const pids = new Set(procs.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line)))
  const ports = []
  for (const line of netstat.split(/\r?\n/)) {
    const match = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
    if (!match) continue
    if (!pids.has(match[2])) continue
    ports.push(Number(match[1]))
  }
  return [...new Set(ports)]
}

/** Verify a candidate token against the live server. */
async function tokenWorks(port, token) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
    const setCookie = String(response.headers.get('set-cookie') || '')
    // A valid token redirects and sets the auth cookie; an invalid one returns 401.
    return { ok: setCookie.includes('=') && response.status !== 401, status: response.status, setCookie: setCookie.split(';')[0] }
  } catch (error) {
    return { ok: false, status: null, error: error.message }
  }
}

/** Scan one process's readable private memory for `token=<value>` occurrences. */
function scanProcess(pid, onCandidate) {
  const handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid)
  if (handle === null || handle === 0) return { scanned: false, reason: 'OpenProcess denied' }

  const mbi = {}
  let address = 0n
  let regionsScanned = 0
  let bytesScanned = 0
  const maxAddress = 0x7fffffffffff

  try {
    while (address < BigInt(maxAddress)) {
      let written
      try {
        written = VirtualQueryEx(handle, koffi.as(address, 'void *'), mbi, MBI_SIZE)
      } catch {
        break
      }
      if (written === 0n || written === 0) break

      const base = BigInt(koffi.address(mbi.BaseAddress))
      const size = BigInt(mbi.RegionSize)
      if (size <= 0n) break

      const readable = mbi.State === MEM_COMMIT
        && (mbi.Protect & READABLE) !== 0
        && (mbi.Protect & PAGE_GUARD) === 0
        && (mbi.Protect & PAGE_NOACCESS) === 0
        && size <= BigInt(MAX_REGION_BYTES)

      if (readable) {
        const length = Number(size)
        const buffer = Buffer.allocUnsafe(length)
        const readOut = [0n]
        let ok = false
        try {
          const result = ReadProcessMemory(handle, koffi.as(base, 'void *'), buffer, BigInt(length), readOut)
          ok = result !== 0 && Number(readOut[0]) > 0
        } catch {
          ok = false
        }
        if (ok) {
          regionsScanned += 1
          bytesScanned += Number(readOut[0])
          const text = buffer.subarray(0, Number(readOut[0])).toString('latin1')
          if (text.includes('token=')) {
            for (const match of text.matchAll(TOKEN_RE)) onCandidate(match[1])
          }
          // Also collect bare 43-char base64url runs near the loopback URL.
          if (text.includes('127.0.0.1')) {
            for (const match of text.matchAll(BARE_TOKEN_RE)) onCandidate(match[1])
          }
        }
      }
      address = base + size
    }
  } finally {
    CloseHandle(handle)
  }
  return { scanned: true, regionsScanned, bytesScanned }
}

const port = explicitPort ?? (await dshListingPortGuess())
async function dshListingPortGuess() {
  const ports = await dshListeningPorts()
  // Prefer the port that answers 401 on / (the authenticated web server).
  for (const candidate of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${candidate}/`, { redirect: 'manual' })
      if (response.status === 401 || response.status === 200 || response.status === 303) return candidate
    } catch {
      // not it
    }
  }
  return ports[0] ?? null
}

if (!port) {
  console.error(JSON.stringify({ ok: false, error: 'No DeepSeek Harness loopback port found.' }, null, 2))
  process.exit(1)
}

const pid = explicitPid ?? (await pidForPort(port))
if (!pid) {
  console.error(JSON.stringify({ ok: false, error: `No process is listening on port ${port}.` }, null, 2))
  process.exit(1)
}

const report = { port, pid, koffiAddon: koffiLocation.addon, candidates: 0, verified: false }
const seen = new Set()
const hits = []

const scan = scanProcess(pid, (token) => {
  if (seen.has(token)) return
  seen.add(token)
  hits.push(token)
})
report.scan = { scanned: scan.scanned, regionsScanned: scan.regionsScanned, bytesScanned: scan.bytesScanned, reason: scan.reason }
report.candidates = hits.length

for (const token of hits) {
  const check = await tokenWorks(port, token)
  if (check.ok) {
    report.verified = true
    report.token = token
    report.verifyStatus = check.status
    report.cookieName = check.setCookie.split('=')[0]
    if (writeCache) {
      const { writeCachedHarness } = await import('../src/harness.mjs')
      const file = writeCachedHarness({
        url: `http://127.0.0.1:${port}/?token=${token}`,
        port,
        token,
        pid,
        discoveredAt: new Date().toISOString(),
        via: 'memory-scan',
      })
      report.cachedTo = file
    }
    break
  }
}

if (!report.verified) {
  report.error = hits.length === 0
    ? 'No token= string found in readable memory of the harness process.'
    : `Found ${hits.length} candidate(s) but none authenticated (server may have rotated the token).`
}

console.log(JSON.stringify(report, null, 2))
process.exit(report.verified ? 0 : 1)
