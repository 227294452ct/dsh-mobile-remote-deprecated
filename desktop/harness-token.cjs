'use strict'

/**
 * Recover the running DeepSeek Harness instance's auth token from its memory.
 *
 * Why this exists: the companion attaches to a harness that is already running,
 * and DSH 0.1.5+ refuses even loopback requests without auth. It mints a random
 * token at startup, embeds it in `http://127.0.0.1:<port>/?token=<43 chars>` and
 * hands that URL to the process that spawned it. The token is never written to
 * disk, so reusing the user's existing instance — without restarting it and
 * losing their session — means reading it out of that process.
 *
 * This is read-only: OpenProcess + VirtualQueryEx + ReadProcessMemory. Nothing is
 * written to the target. Every candidate is verified against the live HTTP server
 * before it is accepted, so a false positive cannot be returned as a token.
 *
 * The native addon is taken from the DSH install's own unpacked tree rather than
 * bundled here, because that is the one build known to match this machine's
 * architecture and Electron ABI.
 */

const { execFile } = require('node:child_process')
const { existsSync, readdirSync } = require('node:fs')
const path = require('node:path')

const TOKEN_RE = /token=([A-Za-z0-9_-]{20,64})/g
// The token is 43 base64url chars (32 bytes). Once the URL has been parsed it
// also sits in memory as a bare value, so match that shape and let HTTP
// verification reject false positives.
const BARE_TOKEN_RE = /\b([A-Za-z0-9_-]{43})\b/g
const MAX_REGION_BYTES = 64 * 1024 * 1024

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
const READABLE = PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY
  | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY

/** Locate the native koffi addon inside a DSH install. */
function findKoffi() {
  const roots = [
    'E:\\DSH\\resources\\app.asar.unpacked',
    'E:\\DSH\\resources',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness Desktop', 'resources', 'app.asar.unpacked')
      : null
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
          if (depth < 8) stack.push({ dir: full, depth: depth + 1 })
          continue
        }
        if (entry.name === 'koffi.node') return { addon: full, dir }
      }
    }
  }
  return null
}

function loadKoffi() {
  const location = findKoffi()
  if (location === null) throw new Error('koffi.node not found in the DSH install')
  const { createRequire } = require('node:module')
  const requireFrom = createRequire(path.join(location.dir, 'noop.cjs'))
  const koffi = requireFrom(location.addon)
  if (typeof koffi?.load !== 'function') throw new Error('unexpected koffi exports')
  return { koffi, addon: location.addon }
}

function run(command, commandArgs) {
  return new Promise((resolve) => {
    execFile(command, commandArgs, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : stdout)
    })
  })
}

/** Find the pid listening on one loopback port. */
async function pidForPort(port) {
  const out = await run('netstat', ['-ano', '-p', 'TCP'])
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
    if (match && Number(match[1]) === port) return Number(match[2])
  }
  return null
}

/** Does this port answer like the authenticated harness web server? */
async function looksLikeHarness(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })
    return response.status === 401 || response.status === 200 || response.status === 303
  } catch {
    return false
  }
}

/** Ports DeepSeek Harness processes are listening on. */
async function harnessPorts() {
  const [netstat, procs] = await Promise.all([
    run('netstat', ['-ano', '-p', 'TCP']),
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'DeepSeek Harness' } | ForEach-Object { \"$($_.ProcessId)\" }"])
  ])
  const pids = new Set(procs.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line)))
  const ports = new Set()
  for (const line of netstat.split(/\r?\n/)) {
    const match = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
    if (match && pids.has(match[2])) ports.add(Number(match[1]))
  }
  return [...ports]
}

/** Verify a candidate token against the live server. */
async function tokenWorks(port, token) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
    const setCookie = String(response.headers.get('set-cookie') || '')
    // A valid token redirects and sets the auth cookie; an invalid one is 401.
    return { ok: setCookie.includes('=') && response.status !== 401, status: response.status }
  } catch (error) {
    return { ok: false, status: null, error: error.message }
  }
}

/** Scan one process's readable committed memory for token candidates. */
function scanProcess(koffi, pid, onCandidate) {
  const kernel32 = koffi.load('kernel32.dll')

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
    __pad2: 'uint32'
  })
  // The packaged addon ships without koffi's JS wrapper, so `koffi.sizeof` is
  // unavailable; the type object exposes its own size.
  const MBI_SIZE = MEMORY_BASIC_INFORMATION.size ?? MEMORY_BASIC_INFORMATION.sizeof

  const OpenProcess = kernel32.func('void *OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)')
  const CloseHandle = kernel32.func('int CloseHandle(void *hObject)')
  const VirtualQueryEx = kernel32.func('uintptr VirtualQueryEx(void *hProcess, void *lpAddress, _Out_ MEMORY_BASIC_INFORMATION *lpBuffer, uintptr dwLength)')
  const ReadProcessMemory = kernel32.func('int ReadProcessMemory(void *hProcess, void *lpBaseAddress, _Out_ uint8_t *lpBuffer, uintptr nSize, _Out_ uintptr *lpNumberOfBytesRead)')

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

/**
 * Find a token that authenticates against the harness on `port`.
 *
 * `port` may be omitted, in which case the harness's listening ports are probed.
 * Returns `{ ok: true, port, pid, token, status }` or `{ ok: false, error }`;
 * it never throws, because the companion must still start (degraded) if the
 * token cannot be recovered.
 */
async function findHarnessToken({ port: explicitPort = null, log = () => {} } = {}) {
  try {
    let port = explicitPort
    if (!port) {
      for (const candidate of await harnessPorts()) {
        if (await looksLikeHarness(candidate)) { port = candidate; break }
      }
    }
    if (!port) return { ok: false, error: 'No DeepSeek Harness loopback port found.' }
    if (!(await looksLikeHarness(port))) return { ok: false, error: `Nothing answers like the harness on port ${port}.` }

    const pid = await pidForPort(port)
    if (!pid) return { ok: false, error: `No process is listening on port ${port}.` }

    const { koffi, addon } = loadKoffi()
    log(`Scanning pid ${pid} for the harness token (addon ${path.basename(addon)})...`)

    const seen = new Set()
    const hits = []
    const scan = scanProcess(koffi, pid, (token) => {
      if (seen.has(token)) return
      seen.add(token)
      hits.push(token)
    })
    if (!scan.scanned) return { ok: false, error: `Memory scan failed: ${scan.reason}` }

    for (const token of hits) {
      // eslint-disable-next-line no-await-in-loop -- first verified candidate wins
      const check = await tokenWorks(port, token)
      if (check.ok) return { ok: true, port, pid, token, status: check.status, candidates: hits.length }
    }

    return {
      ok: false,
      error: hits.length === 0
        ? 'No token= string found in readable memory of the harness process.'
        : `Found ${hits.length} candidate(s) but none authenticated (the harness may have rotated its token).`
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

module.exports = { findHarnessToken, findKoffi, harnessPorts, pidForPort, tokenWorks, looksLikeHarness }
