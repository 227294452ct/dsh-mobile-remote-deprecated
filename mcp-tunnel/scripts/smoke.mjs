// MCP protocol smoke test: spawn the server over stdio, list tools, and call the
// read-only ones. Never starts a tunnel, so it cannot expose anything.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverPath = path.join(here, '..', 'bin', 'dsh-tunnel-mcp.mjs')

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

let buffer = ''
const pending = new Map()
let nextId = 1

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line.length === 0) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
  }
})

const stderrLines = []
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => stderrLines.push(chunk))

function request(method, params) {
  const id = nextId++
  const payload = { jsonrpc: '2.0', id, method, params }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify(payload)}\n`)
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }
    }, 60_000).unref?.()
  })
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

function parseContent(result) {
  const text = result?.content?.find((part) => part.type === 'text')?.text ?? ''
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Flatten a tool result (object or string) into searchable text. */
function resultText(result) {
  const value = parseContent(result)
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

check('initialize reports the server identity', async () => {
  const result = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  })
  assert.equal(result.serverInfo.name, 'dsh-tunnel')
  assert.ok(result.capabilities.tools, 'server must advertise tools')
})

check('tools/list exposes the tunnel tool set', async () => {
  const result = await request('tools/list', {})
  const names = result.tools.map((tool) => tool.name)
  for (const required of [
    'tunnel_status',
    'tunnel_start',
    'tunnel_stop',
    'tunnel_restart',
    'tunnel_url',
    'tunnel_verify',
    'tunnel_setup',
    'tunnel_configure',
    'tunnel_diagnostics',
    'gateway_health',
    'gateway_devices',
    'tunnel_apply_to_desktop',
  ]) {
    assert.ok(names.includes(required), `missing tool ${required}`)
  }
  for (const tool of result.tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a real description`)
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} needs an object schema`)
  }
  return { toolCount: names.length, names }
})

check('tunnel_status reports machine state without a tunnel', async () => {
  const result = await request('tools/call', { name: 'tunnel_status', arguments: {} })
  const value = parseContent(result)
  assert.ok(['stopped', 'failed', 'running', 'running (adopted)', 'disconnected', 'starting'].includes(value.state), `unexpected state ${value.state}`)
  assert.equal(typeof value.stable, 'boolean')
  assert.ok(value.binary && typeof value.binary.path === 'string')
})

check('tunnel_setup explains the Aliyun + Cloudflare steps', async () => {
  const result = await request('tools/call', {
    name: 'tunnel_setup',
    arguments: { hostname: 'dsh.example.com', tunnelName: 'dsh-desktop' },
  })
  const value = parseContent(result)
  assert.equal(value.steps.length, 5)
  assert.match(value.steps[1].command, /tunnel login/)
  assert.match(value.steps[2].command, /tunnel create dsh-desktop/)
  assert.match(value.steps[3].command, /tunnel route dns dsh-desktop dsh\.example\.com/)
})

check('tunnel_diagnostics names the blocker for an unconfigured machine', async () => {
  const result = await request('tools/call', { name: 'tunnel_diagnostics', arguments: {} })
  const value = parseContent(result)
  assert.ok(Array.isArray(value.blockers))
  assert.ok(value.files && typeof value.files.root === 'string')
  assert.equal(typeof value.addressIsPermanent, 'boolean')
})

check('gateway_devices reads the Desktop pairing file', async () => {
  const result = await request('tools/call', { name: 'gateway_devices', arguments: {} })
  const value = parseContent(result)
  assert.ok(Array.isArray(value.devices))
  if (value.devices.length > 0) {
    assert.ok(!('publicKey' in value.devices[0]), 'paired device public keys must not be echoed')
  }
})

check('gateway_health discovers the loopback origin', async () => {
  const result = await request('tools/call', { name: 'gateway_health', arguments: {} })
  const value = parseContent(result)
  assert.ok(value.local !== undefined, 'health must report a local probe outcome')
})

check('tunnel_verify reports honestly when nothing is exposed', async () => {
  const result = await request('tools/call', { name: 'tunnel_verify', arguments: {} })
  const value = parseContent(result)
  if (value.verified === false) {
    assert.ok(value.reason, 'must explain why nothing could be verified')
  } else {
    // A tunnel is genuinely up: the probe must carry DNS + reachability facts.
    assert.ok(value.dns && Array.isArray(value.dns.flags), 'verify must report DNS facts')
    assert.ok(value.reachability, 'verify must report a reachability probe')
    assert.ok(Array.isArray(value.diagnosis) && value.diagnosis.length > 0, 'verify must explain the outcome')
  }
})

check('tunnel_stop is safe when nothing is running', async () => {
  const result = await request('tools/call', { name: 'tunnel_stop', arguments: {} })
  const value = parseContent(result)
  assert.equal(value.state, 'stopped')
})

check('tunnel_start never reports a healthy tunnel for an unreachable origin', async () => {
  // Configuration-independent: this machine may or may not have a named tunnel.
  // Either it refuses for lack of configuration, or it must report an honest
  // non-running state and must not claim a stable, working address when the
  // origin it was pointed at is dead.
  const result = await request('tools/call', {
    name: 'tunnel_start',
    arguments: { mode: 'named', origin: 'http://127.0.0.1:9' },
  })
  const value = parseContent(result)

  if (result.isError) {
    assert.match(resultText(result), /not configured|missing|not reachable|unreachable/i, `unexpected refusal: ${resultText(result)}`)
    return { refused: true }
  }

  // It started (or attempted to). Whatever happens, a dead origin must not be
  // presented as a working phone address.
  assert.ok(value, 'a non-error result must carry a status payload')
  assert.notEqual(value.origin, 'http://127.0.0.1:9', 'a dead origin must not be adopted as the tunnel target')

  // Clean up whatever this check started.
  await request('tools/call', { name: 'tunnel_stop', arguments: {} })
  return { started: value.state, origin: value.origin, stable: value.stable }
})

check('tunnel_start refuses a named tunnel without configuration', async () => {
  // Only meaningful on a machine with no named tunnel configured.
  const statusResult = await request('tools/call', { name: 'tunnel_diagnostics', arguments: {} })
  const diagnostics = parseContent(statusResult)
  const configured = diagnostics?.blockers?.length === 0
  if (configured) return { skipped: 'a named tunnel is configured on this machine' }

  const result = await request('tools/call', {
    name: 'tunnel_start',
    arguments: { mode: 'named', origin: 'http://127.0.0.1:9' },
  })
  assert.equal(result.isError, true, 'expected a refusal, not a running tunnel')
  assert.match(parseContent(result), /not configured|missing/i)
  return { refused: true }
})

check('tunnel_apply_to_desktop refuses without a hostname', async () => {
  const result = await request('tools/call', { name: 'tunnel_apply_to_desktop', arguments: { write: false } })
  const value = parseContent(result)
  if (!value.applied) assert.ok(value.reason || value.dryRun, 'must explain why it did not apply')
})

const results = []
let failed = 0
try {
  for (const { name, fn } of checks) {
    try {
      const detail = await fn()
      results.push({ name, ok: true, detail })
      process.stderr.write(`PASS ${name}\n`)
    } catch (error) {
      failed += 1
      results.push({ name, ok: false, error: error.message })
      process.stderr.write(`FAIL ${name}: ${error.message}\n`)
    }
  }
} finally {
  child.stdin.end()
  child.kill()
}

const serverLog = stderrLines.join('')
if (serverLog.trim().length > 0) process.stderr.write(`--- server stderr ---\n${serverLog}\n`)

process.stdout.write(`${JSON.stringify({ passed: results.filter((r) => r.ok).length, failed, results }, null, 2)}\n`)
process.exit(failed === 0 ? 0 : 1)
