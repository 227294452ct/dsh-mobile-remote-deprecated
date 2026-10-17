#!/usr/bin/env node
// dsh-tunnel-mcp - a Model Context Protocol server that gives DeepSeek Harness
// a *permanent* public address for the DeepSeek Harness Desktop phone gateway.
//
// Root cause it fixes: the Desktop app used `cloudflared tunnel --url`, i.e. a
// Cloudflare Quick Tunnel, which mints a random `<random>.trycloudflare.com`
// hostname on every start and every edge reconnect. Reaching the phone then
// required re-pairing each time. A named tunnel keeps one hostname for as long
// as the domain exists.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import { resolveTunnelConfig } from './config.mjs'
import { listTunnels, readApiCredentials, verifyCredentials, verifyTunnel } from './cloudflare.mjs'
import { buildDesktopRemoteSettingsPatch, desktopRemoteSettingsPath, writeDesktopRemoteSettings } from './desktop-settings.mjs'
import { autoStartStatus, installAutoStart, removeAutoStart } from './autostart.mjs'
import { MobileGateway } from './gateway-server.mjs'
import { HarnessLauncher, readCachedHarness, resolveHarnessLauncher } from './harness.mjs'
import { statePaths } from './paths.mjs'
import { pairingUrl } from './pairing.mjs'
import { readJsonFile as readStateFile } from './tunnel.mjs'
import { describeBoundary, desktopUserDataDir, discoverOrigin, probeGateway, readGatewaySnapshot, readPairedDevices } from './gateway.mjs'
import { httpsProbe, inspectDns, inspectDomain, measureStability } from './probe.mjs'
import { TUNNEL_MODE_NAMED, TUNNEL_MODE_QUICK, TunnelManager, extractQuickTunnelUrl } from './tunnel.mjs'

const SERVER_NAME = 'dsh-tunnel'
const SERVER_VERSION = '0.1.0'

// stdout is the MCP wire. Every diagnostic must go to stderr.
const log = (message) => process.stderr.write(`[dsh-tunnel-mcp] ${message}\n`)

const manager = new TunnelManager({ log })
const gateway = new MobileGateway({ log, publicHost: null })

/**
 * Acquire the harness auth cookie for the gateway.
 *
 * Order: an explicit token, then the cached one, then a memory scan of the
 * running harness (the token is never written to disk, so an already-running
 * instance can only be reused this way).
 */
async function attachHarness(options = {}) {
  const explicitPort = options.harnessPort ?? null
  const explicitToken = typeof options.token === 'string' && options.token.length > 0 ? options.token : null

  if (explicitToken && explicitPort) {
    await gateway.attachHarness({ port: explicitPort, token: explicitToken })
    return { via: 'explicit token', port: explicitPort }
  }

  const cached = readCachedHarness(process.env)
  if (cached?.port && cached?.token) {
    try {
      await gateway.attachHarness({ port: cached.port, token: cached.token })
      return { via: 'cached token', port: cached.port }
    } catch {
      // The harness likely restarted and rotated its token; fall through.
    }
  }

  const scan = await findHarnessTokenAndCache(explicitPort)
  if (!scan.ok) {
    const error = new Error(scan.error ?? 'Could not obtain the harness auth token.')
    error.code = 'HARNESS_TOKEN_UNAVAILABLE'
    error.details = scan
    throw error
  }
  await gateway.attachHarness({ port: scan.port, token: scan.token })
  return { via: 'memory scan', port: scan.port, candidates: scan.candidates }
}

function findHarnessTokenAndCache(preferredPort) {
  return new Promise((resolve) => {
    const script = path.join(projectRoot, 'scripts', 'find-harness-token.mjs')
    if (!existsSync(script)) {
      resolve({ ok: false, error: `Token scan script missing at ${script}` })
      return
    }
    const args = [script, '--write']
    if (preferredPort) args.push('--port', String(preferredPort))
    const child = spawn(process.execPath, args, { windowsHide: true, shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => resolve({ ok: false, error: error.message }))
    child.once('close', () => {
      try {
        const parsed = JSON.parse(stdout)
        resolve(parsed.verified ? { ok: true, ...parsed } : { ok: false, error: parsed.error, port: parsed.port })
      } catch {
        resolve({ ok: false, error: `Token scan produced no result. ${stderr.slice(-300)}` })
      }
    })
  })
}

async function gatewayStatusPayload() {
  const status = gateway.getStatus()
  const paths = statePaths(process.env)
  const detachedState = readStateFile(path.join(paths.root, 'gateway-state.json'))
  const detachedPid = Number(detachedState?.pid)
  const detachedAlive = Number.isInteger(detachedPid) && detachedPid > 0
    ? (() => { try { process.kill(detachedPid, 0); return true } catch (error) { return error?.code === 'EPERM' } })()
    : false

  // The detached gateway owns the live devices and tunnel, so ask it directly
  // rather than reporting this process's stale view.
  let live = null
  if (detachedAlive && detachedState?.origin) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4_000)
      const response = await fetch(`${detachedState.origin}/_dsh_mobile/v1/status`, { signal: controller.signal })
      clearTimeout(timer)
      if (response.ok) live = await response.json()
    } catch {
      // The detached process may be mid-restart; fall back to the state file.
    }
  }

  const devices = live?.gateway?.devices ?? status.devices
  const pendingPairing = live?.gateway?.pendingPairing ?? status.pendingPairing

  return {
    running: detachedAlive || status.running,
    port: detachedAlive ? (detachedState?.port ?? null) : status.port,
    origin: detachedAlive ? (detachedState?.origin ?? null) : status.origin,
    harness: live?.gateway?.harness ?? status.harness,
    devices,
    pendingPairing,
    publicHost: status.publicHost ?? detachedState?.publicHost ?? null,
    uptimeFrom: detachedAlive ? (detachedState?.startedAt ?? null) : null,
    detached: {
      running: detachedAlive,
      state: detachedState,
      pid: detachedAlive ? detachedPid : null,
      live,
    },
    autoStart: autoStartStatus(process.env),
    // Report the tunnel that is actually carrying traffic.
    tunnel: detachedAlive
      ? {
          state: detachedState?.tunnelPid ? 'running' : 'stopped',
          stable: Boolean(detachedState?.tunnelPid),
          addressPermanent: true,
          provider: 'Cloudflare Named Tunnel',
          owner: 'detached gateway',
          pid: detachedState?.tunnelPid ?? null,
          publicUrl: detachedState?.publicHost ? `https://${detachedState.publicHost}` : null,
        }
      : { ...manager.status(), owner: 'in-process' },
    permanentUrl: (status.publicHost ?? detachedState?.publicHost)
      ? `https://${status.publicHost ?? detachedState?.publicHost}`
      : (manager.status().configuredPublicUrl ?? null),
  }
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error)
  return { isError: true, content: [{ type: 'text', text: message }] }
}

async function withErrors(fn) {
  try {
    return await fn()
  } catch (error) {
    return errorResult(error)
  }
}

function normalizeOrigin(value) {
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`
  return withScheme.replace(/\/+$/, '')
}

/**
 * Resolve the loopback origin to expose, from an argument, a saved value, or
 * live discovery. A saved origin is only trusted when it still answers: a stale
 * port from a previous Desktop run must never win over the live gateway.
 */
async function resolveOrigin(originArg) {
  const explicit = typeof originArg === 'string' && originArg.trim().length > 0
    ? normalizeOrigin(originArg.trim())
    : null

  // An explicit origin that still answers is authoritative.
  if (explicit) {
    const probe = await probeGateway(explicit)
    if (probe.looksLikeGateway) {
      manager.saveSettings({ origin: explicit, gatewayPort: portOf(explicit) })
      return { origin: explicit, discoveredBy: 'argument', probe }
    }
    // It does not answer: the Desktop app may have restarted on a new port, so
    // fall through to discovery instead of pointing a tunnel at a dead port.
    const discovered = await discoverOrigin(process.env)
    if (discovered) {
      manager.saveSettings({ origin: discovered.origin, gatewayPort: discovered.gatewayPort ?? null })
      return {
        ...discovered,
        requestedOrigin: explicit,
        requestedOriginError: probe.error ?? 'not reachable',
        note: `The requested origin ${explicit} did not answer; discovered ${discovered.origin} instead.`,
      }
    }
    return {
      origin: explicit,
      discoveredBy: 'argument (unreachable)',
      probe,
      stale: true,
      hint: 'This origin does not answer and no live gateway was found. Start DeepSeek Harness Desktop with phone access enabled.',
    }
  }

  const savedOrigin = manager.settings.origin
  const discovered = await discoverOrigin(process.env)
  if (discovered) {
    if (discovered.origin !== savedOrigin) {
      manager.saveSettings({ origin: discovered.origin, gatewayPort: discovered.gatewayPort ?? null })
    }
    return discovered
  }

  if (savedOrigin) {
    const probe = await probeGateway(savedOrigin)
    return {
      origin: savedOrigin,
      discoveredBy: 'settings (stale)',
      probe,
      stale: true,
      hint: probe.looksLikeGateway
        ? null
        : 'This saved origin no longer answers. DeepSeek Harness Desktop may be closed, or it restarted on a new port; open it and retry.',
    }
  }

  const error = new Error(
    'Could not find the DeepSeek Harness Desktop gateway on loopback. ' +
    'Open DeepSeek Harness Desktop, enable phone access, and pass origin explicitly if it uses a custom port.',
  )
  error.code = 'ORIGIN_NOT_FOUND'
  throw error
}

function portOf(origin) {
  try {
    const parsed = new URL(origin)
    const port = Number(parsed.port)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

const modeField = z
  .enum([TUNNEL_MODE_NAMED, TUNNEL_MODE_QUICK])
  .describe('Tunnel kind. "named" is the permanent one; "quick" gives a throwaway random hostname.')
const originField = z
  .string()
  .optional()
  .describe('Local gateway origin, e.g. http://127.0.0.1:52231. Auto-detected when omitted.')

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    instructions: [
      'Manage the public tunnel that exposes the DeepSeek Harness Desktop phone gateway.',
      'A named tunnel yields one permanent https hostname that survives restarts, sleep and reconnects;',
      'a quick tunnel yields a new random hostname every start and is only for throwaway testing.',
      'Prefer tunnel_status before acting, and never assume a quick-tunnel URL is reusable.',
    ].join(' '),
  },
)

server.registerTool(
  'tunnel_status',
  {
    title: 'Tunnel status',
    description:
      'Report the current public tunnel: provider, mode, state, the permanent public URL, the local origin, ' +
      'the cloudflared binary in use, the named-tunnel configuration and recent cloudflared output.',
    inputSchema: {
      includeOutput: z.boolean().optional().describe('Include the last cloudflared log lines.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ includeOutput }) => withErrors(async () => {
    const status = manager.status({ includeOutput: includeOutput === true })
    status.boundary = describeBoundary()
    return textResult(status)
  }),
)

server.registerTool(
  'tunnel_start',
  {
    title: 'Start tunnel',
    description:
      'Start the tunnel to the Desktop gateway. Defaults to the permanent named tunnel; ' +
      'pass mode "quick" only for a temporary throwaway address whose hostname will change.',
    inputSchema: {
      mode: modeField.optional(),
      origin: originField,
      hostname: z.string().optional().describe('Public hostname to serve for the named tunnel, e.g. dsh.example.com.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  async ({ mode, origin, hostname }) => withErrors(async () => {
    const resolved = await resolveOrigin(origin)

    // Refuse to publish an address that points at nothing. Without this the
    // tunnel starts happily, Cloudflare shows a healthy connector, and the
    // phone still cannot reach anything — the exact failure this server exists
    // to prevent.
    const reachable = resolved.probe?.looksLikeGateway === true
    if (!reachable) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            started: false,
            reason: 'The local gateway is not reachable, so starting the tunnel would publish an address that serves nothing.',
            origin: resolved.origin,
            originDiscoveredBy: resolved.discoveredBy,
            probe: resolved.probe ?? null,
            hint: resolved.hint
              ?? 'Open DeepSeek Harness Desktop and make sure phone access (手机远程) is enabled, then retry. Pass origin explicitly if it listens on a custom port.',
          }, null, 2),
        }],
      }
    }

    const effectiveMode = mode === TUNNEL_MODE_QUICK ? TUNNEL_MODE_QUICK : TUNNEL_MODE_NAMED
    const status = effectiveMode === TUNNEL_MODE_QUICK
      ? await manager.startQuick({ origin: resolved.origin })
      : await manager.startNamed({ origin: resolved.origin, hostname })

    return textResult({
      ...status,
      origin: resolved.origin,
      originDiscoveredBy: resolved.discoveredBy,
      originVerified: true,
      warning: status.stable
        ? null
        : 'This is a quick tunnel: the public hostname changes on every restart and cannot be reused.',
      guidance: status.stable
        ? 'Share this permanent URL with the phone once; it stays valid across restarts.'
        : 'Do not save this URL for later; use mode "named" for a permanent address.',
    })
  }),
)

server.registerTool(
  'tunnel_stop',
  {
    title: 'Stop tunnel',
    description: 'Stop the tunnel process this MCP server started. The permanent hostname stays reserved on the domain.',
    inputSchema: {
      keepUrl: z.boolean().optional().describe('Keep reporting the last known public URL (default false).'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async ({ keepUrl }) => withErrors(async () => textResult(await manager.stop({ keepUrl: keepUrl === true }))),
)

server.registerTool(
  'tunnel_restart',
  {
    title: 'Restart tunnel',
    description:
      'Restart the tunnel. For a named tunnel this reuses the same permanent hostname, which is how a dropped ' +
      'connection is recovered without asking the phone to reconnect to a new address.',
    inputSchema: {
      mode: modeField.optional(),
      origin: originField,
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  async ({ mode, origin }) => withErrors(async () => {
    const resolved = await resolveOrigin(origin)
    if (resolved.probe?.looksLikeGateway !== true) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            restarted: false,
            reason: 'The local gateway is not reachable; restarting would republish an address that serves nothing.',
            origin: resolved.origin,
            originDiscoveredBy: resolved.discoveredBy,
            probe: resolved.probe ?? null,
          }, null, 2),
        }],
      }
    }
    await manager.stop({ keepUrl: true })
    const effectiveMode = mode === TUNNEL_MODE_QUICK
      ? TUNNEL_MODE_QUICK
      : (mode === TUNNEL_MODE_NAMED ? TUNNEL_MODE_NAMED : manager.settings.mode)
    const status = effectiveMode === TUNNEL_MODE_QUICK
      ? await manager.startQuick({ origin: resolved.origin })
      : await manager.startNamed({ origin: resolved.origin })
    return textResult({ ...status, origin: resolved.origin, restarted: true, originVerified: true })
  }),
)

server.registerTool(
  'tunnel_url',
  {
    title: 'Permanent phone URL',
    description:
      'Return the single stable public URL to use on the phone, with a scannable pairing QR code. ' +
      'Use this instead of re-reading a changing quick-tunnel address.',
    inputSchema: {
      includeQr: z.boolean().optional().describe('Render a terminal QR code for the URL (default true).'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ includeQr }) => withErrors(async () => {
    const status = manager.status()
    const config = resolveTunnelConfig(manager.settings, process.env)
    const url = status.publicUrl ?? (config.hostname ? `https://${config.hostname}` : null)
    if (!url) {
      return textResult({
        publicUrl: null,
        configured: false,
        reason: 'No permanent hostname is configured yet.',
        next: 'Call tunnel_setup for the one-time Cloudflare + domain commands, then tunnel_configure.',
      })
    }
    const payload = { publicUrl: url, stable: status.stable, state: status.state, hostname: config.hostname }
    if (includeQr !== false) {
      try {
        const QRCode = (await import('qrcode')).default
        payload.qr = await QRCode.toString(url, { type: 'terminal', small: true })
      } catch (error) {
        payload.qrError = error instanceof Error ? error.message : String(error)
      }
    }
    return textResult(payload)
  }),
)

server.registerTool(
  'tunnel_verify',
  {
    title: 'Verify the public address really works',
    description:
      'Prove the phone can actually reach the address: resolve its DNS, fetch it through the public internet, and ' +
      'optionally repeat the fetch to measure flakiness. Use this after any tunnel change, because a tunnel can ' +
      'report "connected" while the public path is being reset.',
    inputSchema: {
      url: z.string().optional().describe('Public URL to verify; defaults to the configured permanent URL.'),
      attempts: z.number().int().min(1).max(20).optional().describe('How many probes to run (default 1, use 5+ to measure flakiness).'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ url, attempts }) => withErrors(async () => {
    const config = resolveTunnelConfig(manager.settings, process.env)
    const status = manager.status()
    const target = url ?? status.publicUrl ?? (config.hostname ? `https://${config.hostname}` : null)
    if (!target) {
      return textResult({ verified: false, reason: 'No public URL is configured or running yet.' })
    }

    const hostname = new URL(target).hostname
    const dnsReport = await inspectDns(hostname)
    const count = attempts ?? 1
    const reachability = count > 1
      ? await measureStability(target, { attempts: count })
      : { ...(await httpsProbe(target)), verdict: undefined }

    return textResult({
      url: target,
      dns: dnsReport,
      reachability,
      tunnel: { state: status.state, mode: status.mode, provider: status.provider, stable: status.stable },
      diagnosis: buildVerifyDiagnosis(dnsReport, reachability),
    })
  }),
)

/** Turn probe facts into the specific next action a human should take. */
function buildVerifyDiagnosis(dnsReport, reachability) {
  const notes = []
  const fakeIp = dnsReport.flags.some((flag) => flag.includes('proxy/VPN') || flag.includes('NAT64'))
  const succeeded = reachability.successRate !== undefined ? reachability.successRate > 0 : reachability.ok === true
  const allOk = reachability.successRate !== undefined ? reachability.successRate === 1 : reachability.ok === true

  if (fakeIp) {
    notes.push(
      'A proxy or VPN is answering DNS for this hostname with a synthetic address (198.18.0.0/15 or NAT64). ' +
      'That interception is a known cause of intermittent ECONNRESET on tunnelled hostnames; turn the proxy off and re-verify.',
    )
  }
  if (!succeeded) {
    notes.push(
      'The public address is not reachable from here, so the phone will not connect either. ' +
      'Check that the tunnel process is running, that the DNS record exists in Cloudflare, and that no proxy is intercepting it.',
    )
  } else if (!allOk) {
    notes.push(
      'The address works only part of the time. That is the reconnect symptom: the URL is fine, the path to the edge is not.',
    )
  } else {
    notes.push('The public address is reachable; the phone should connect through it.')
  }
  return notes
}

server.registerTool(
  'domain_check',
  {
    title: 'Domain readiness for the tunnel',
    description:
      'Check whether a domain can actually serve the permanent tunnel: whether its nameservers have moved to ' +
      'Cloudflare (required), plus any DNS interception on this machine. Run this before cloudflared tunnel create.',
    inputSchema: {
      domain: z.string().optional().describe('Domain to check, e.g. xinqiaopsy.top. Defaults to the configured hostname.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ domain }) => withErrors(async () => {
    const config = resolveTunnelConfig(manager.settings, process.env)
    const target = domain
      ?? config.hostname
      ?? (manager.settings.hostname ? manager.settings.hostname : null)
    if (!target) {
      return textResult({
        checked: false,
        reason: 'No domain given and none configured yet.',
        hint: 'Pass domain, e.g. {"domain": "xinqiaopsy.top"}.',
      })
    }
    // A hostname may be a subdomain; the registrable checks work on either.
    const report = await inspectDomain(target)
    return textResult({ checked: true, ...report })
  }),
)

server.registerTool(
  'cloudflare_verify',
  {
    title: 'Verify the tunnel against Cloudflare',
    description:
      'Use the Cloudflare API to confirm what local config cannot: that the named tunnel exists, that the hostname ' +
      'has a proxied CNAME pointing at it, and which zones the token can see. Needs CLOUDFLARE_API_TOKEN.',
    inputSchema: {
      hostname: z.string().optional().describe('Hostname to check; defaults to the configured one.'),
      tunnelId: z.string().optional().describe('Tunnel UUID to check; defaults to the configured one.'),
      listTunnels: z.boolean().optional().describe('Also list every tunnel in the account.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ hostname, tunnelId, listTunnels: listAll }) => withErrors(async () => {
    const config = resolveTunnelConfig(manager.settings, process.env)
    const credentials = readApiCredentials(process.env)
    if (!credentials) {
      return textResult({
        configured: false,
        reason: 'No Cloudflare API token found.',
        howTo: [
          'Create a token at https://dash.cloudflare.com/profile/api-tokens with permissions: Zone:Read, Cloudflare Tunnel:Read (and Zone:DNS:Read to check the CNAME).',
          'Then set it for the DSH process, e.g. in cordis.patch.yml under this entry:',
          '  config: { env: { CLOUDFLARE_API_TOKEN: !!js process.env.CLOUDFLARE_API_TOKEN } }',
          'Local config checks still work without a token; only Cloudflare-side confirmation requires one.',
        ],
      })
    }

    const payload = {
      credentials: { kind: credentials.kind },
      hostname: hostname ?? config.hostname,
      tunnelId: tunnelId ?? config.tunnelId,
    }
    payload.tunnelVerification = await verifyTunnel({ tunnelId: payload.tunnelId, hostname: payload.hostname }, process.env)
    if (listAll === true) payload.allTunnels = await listTunnels(process.env)
    return textResult(payload)
  }),
)

server.registerTool(
  'gateway_start',
  {
    title: 'Start the mobile gateway',
    description:
      'Start this MCP server\'s own phone gateway: a loopback HTTP server that authenticates paired phones and ' +
      'reverse-proxies them to the running DeepSeek Harness. Replaces the DeepSeek Harness Desktop gateway, so ' +
      'Desktop is no longer required. Optionally points the permanent tunnel at it.',
    inputSchema: {
      tunnel: z.boolean().optional().describe('Also start the permanent tunnel against this gateway (default true).'),
      token: z.string().optional().describe('Explicit harness startup token, when you already have one.'),
      harnessPort: z.number().int().min(1).max(65535).optional().describe('Harness web port, when auto-detection is wrong.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async ({ tunnel, token, harnessPort }) => withErrors(async () => {
    const payload = {}
    payload.attachment = await attachHarness({ token, harnessPort })
    payload.gateway = await gateway.start()

    if (tunnel !== false) {
      const hostname = resolveTunnelConfig(manager.settings, process.env).hostname
      gateway.publicHost = hostname ?? gateway.publicHost
      manager.saveSettings({ origin: gateway.origin, gatewayPort: gateway.port })
      payload.tunnel = await manager.startNamed({ origin: gateway.origin, hostname })
    }

    payload.next = 'Call gateway_pair, then enter that code on the phone at the permanent URL.'
    return textResult({ ...payload, gateway: await gatewayStatusPayload() })
  }),
)

server.registerTool(
  'gateway_detach',
  {
    title: 'Move the gateway to its own process',
    description:
      'Start the mobile gateway as an independent background process with its own tunnel, so the phone keeps working ' +
      'across DeepSeek Harness restarts. The in-process gateway is stopped first to avoid two servers claiming the same hostname.',
    inputSchema: {
      harnessPort: z.number().int().min(1).max(65535).optional().describe('Harness port; auto-detected when omitted.'),
      installAutoStart: z.boolean().optional().describe('Also register the gateway to start at login (default false).'),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  async ({ harnessPort, installAutoStart: installStartup }) => withErrors(async () => {
    const paths = statePaths(process.env)

    // Resolve the harness first so the detached process starts authenticated.
    const attachment = await attachHarness({ harnessPort })
    const harness = gateway.harness
    if (!harness) throw new Error('No harness attached; cannot detach.')

    // The detached process owns the tunnel, so release ours to avoid a conflict.
    await manager.stop().catch(() => {})
    await gateway.stop().catch(() => {})

    const configPath = path.join(paths.root, 'gateway.json')
    const resolved = resolveTunnelConfig(manager.settings, process.env)
    const config = {
      harnessPort: harness.port,
      // The validated cookie lets the detached process start attached. It is
      // equivalent to a session credential, so the file is written under the
      // user's own state directory only.
      harnessCookie: harness.cookie,
      publicHost: resolved.hostname ?? null,
      tunnel: true,
      // The detached process runs with a scrubbed environment, so the tunnel
      // details are passed explicitly instead of relying on state files it
      // would not look in.
      tunnelId: resolved.tunnelId ?? null,
      tunnelName: resolved.tunnelName ?? null,
      tunnelHostname: resolved.hostname ?? null,
      credentialsFile: resolved.credentialsFile ?? null,
      cloudflaredPath: manager.resolveBinary().path,
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

    const gatewayScript = path.join(projectRoot, 'bin', 'gateway.mjs')
    const child = spawn(process.execPath, [gatewayScript, 'start', '--config', configPath], {
      windowsHide: true,
      shell: false,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    })
    child.unref()

    const payload = {
      launched: true,
      pid: child.pid,
      configPath,
      gatewayScript,
      note: 'The detached gateway now owns the tunnel and will recover its own harness cookie after a harness restart.',
    }

    if (installStartup === true) {
      payload.autoStart = installAutoStart({
        nodePath: process.execPath,
        gatewayScript,
        configPath,
      })
    }

    // Give it a moment to bind and publish state.
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    payload.status = await gatewayStatusPayload()
    return textResult(payload)
  }),
)

server.registerTool(
  'gateway_autostart',
  {
    title: 'Gateway auto-start at login',
    description:
      'Install or remove the Startup-folder launcher that brings the detached gateway (and its tunnel) up after a ' +
      'reboot, so nobody has to start it by hand.',
    inputSchema: {
      install: z.boolean().optional().describe('true installs, false removes; omit to only report status.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async ({ install }) => withErrors(async () => {
    const paths = statePaths(process.env)
    const configPath = path.join(paths.root, 'gateway.json')
    const gatewayScript = path.join(projectRoot, 'bin', 'gateway.mjs')

    if (install === true) {
      if (!existsSync(configPath)) {
        return textResult({
          installed: false,
          reason: 'No gateway config yet. Run gateway_detach first, then re-run with install=true.',
        })
      }
      const result = installAutoStart({ nodePath: process.execPath, gatewayScript, configPath })
      return textResult({ ...result, status: autoStartStatus(process.env) })
    }
    if (install === false) {
      return textResult({ ...removeAutoStart(process.env), status: autoStartStatus(process.env) })
    }
    return textResult(autoStartStatus(process.env))
  }),
)

server.registerTool(
  'gateway_pair',
  {
    title: 'Pair a phone',
    description:
      'Create a one-time pairing code. Enter it on the phone to bind that device for long-term access. ' +
      'Start the gateway first.',
    inputSchema: {
      includeQr: z.boolean().optional().describe('Include a QR code for the permanent URL (default true).'),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  async ({ includeQr }) => withErrors(async () => {
    // Pairing codes live in a shared file, so they work whether the gateway runs
    // in this process or in the detached process.
    const inProcess = gateway.getStatus().running
    const detached = (await gatewayStatusPayload()).detached
    if (!inProcess && !detached.running) {
      return textResult({ paired: false, reason: 'No gateway is running. Call gateway_start or gateway_detach first.' })
    }

    const pairing = gateway.createPairing()
    const hostname = resolveTunnelConfig(manager.settings, process.env).hostname
    const origin = gateway.origin ?? detached.state?.origin ?? null
    const url = hostname ? `https://${hostname}` : origin
    const pairUrl = url ? pairingUrl(url, pairing.code) : null
    const payload = {
      code: pairing.code,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
      validForSeconds: Math.round((pairing.expiresAt - Date.now()) / 1000),
      url,
      pairUrl,
      servedBy: inProcess ? 'in-process gateway' : 'detached gateway',
      instructions: pairUrl
        ? `用手机扫下面二维码即可配对（无需手输）。也可以手动打开 ${url} 并输入 ${pairing.code}。`
        : 'Open the gateway URL on the phone and enter the code.',
    }
    if (includeQr !== false && pairUrl) {
      try {
        const QRCode = (await import('qrcode')).default
        // Encode the code into the URL so scanning completes pairing without typing.
        payload.qr = await QRCode.toString(pairUrl, { type: 'terminal', small: true })
      } catch (error) {
        payload.qrError = error instanceof Error ? error.message : String(error)
      }
    }
    return textResult(payload)
  }),
)

server.registerTool(
  'gateway_status',
  {
    title: 'Mobile gateway status',
    description: 'Report the gateway origin, whether the harness is attached and authenticated, and the paired phones.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () => withErrors(async () => textResult(await gatewayStatusPayload())),
)

server.registerTool(
  'gateway_revoke',
  {
    title: 'Revoke a paired phone',
    description: 'Revoke one paired device so its token stops working immediately.',
    inputSchema: {
      deviceId: z.string().describe('Device id from gateway_status.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async ({ deviceId }) => withErrors(async () => {
    // After gateway_detach the live device list belongs to the detached process,
    // so revoke there; fall back to the in-process gateway.
    const payload = await gatewayStatusPayload()
    const state = payload.detached?.state
    if (payload.detached?.running && state?.origin) {
      const { ensureAdminToken } = await import('./pairing.mjs')
      const token = ensureAdminToken(process.env)
      try {
        const response = await fetch(`${state.origin}/_dsh_mobile/v1/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-admin-token': token },
          body: JSON.stringify({ deviceId }),
        })
        const result = await response.json().catch(() => ({}))
        return textResult({ ...result, servedBy: 'detached gateway' })
      } catch (error) {
        return textResult({ revoked: false, deviceId, servedBy: 'detached gateway', error: error.message })
      }
    }

    const revoked = gateway.revokeDevice(deviceId)
    return textResult({ revoked, deviceId, servedBy: 'in-process gateway', devices: gateway.getStatus().devices })
  }),
)

server.registerTool(
  'harness_locate',
  {
    title: 'Locate the running harness',
    description:
      'Find the running DeepSeek Harness web port and recover its startup token from process memory, then verify it ' +
      'by exchanging it for the auth cookie. Read-only with respect to the harness.',
    inputSchema: {
      harnessPort: z.number().int().min(1).max(65535).optional().describe('Explicit harness port.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ harnessPort }) => withErrors(async () => {
    const launcher = resolveHarnessLauncher(process.env)
    const found = await findHarnessTokenAndCache(harnessPort)
    return textResult({
      launcher,
      cached: readCachedHarness(process.env),
      // The token itself is deliberately not returned; it is a credential.
      scan: { ...found, token: found.token ? `${String(found.token).slice(0, 6)}…(redacted)` : undefined },
      note: 'The token is cached under the tunnel state directory and never echoed in full.',
    })
  }),
)

server.registerTool(
  'tunnel_setup',
  {
    title: 'Permanent tunnel setup steps',
    description:
      'Explain the one-time setup that turns the Aliyun-purchased domain plus Cloudflare into a permanent tunnel ' +
      'hostname, and report exactly which steps are already done on this machine.',
    inputSchema: {
      hostname: z.string().optional().describe('The public hostname you intend to use, e.g. dsh.example.com.'),
      tunnelName: z.string().optional().describe('Name for the Cloudflare tunnel (default dsh-desktop).'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ hostname, tunnelName }) => withErrors(async () => {
    const config = resolveTunnelConfig(
      { ...manager.settings, hostname: hostname ?? manager.settings.hostname, tunnelName: tunnelName ?? manager.settings.tunnelName },
      process.env,
    )
    const binary = manager.resolveBinary()
    const name = tunnelName ?? config.tunnelName ?? 'dsh-desktop'
    const host = hostname ?? config.hostname ?? '<dsh.example.com>'

    return textResult({
      binary,
      alreadyDone: {
        cloudflaredLogin: config.loggedIn,
        namedTunnelOnDisk: config.localTunnels.length > 0,
        namedTunnel: config.tunnelName,
        credentialsFile: config.credentialsFile,
        hostnameConfigured: config.hostname,
      },
      steps: [
        {
          step: 1,
          what: 'Buy a cheap domain at Aliyun, then move its DNS to Cloudflare.',
          detail: [
            'Buy the domain in the Aliyun console.',
            'Create a free Cloudflare account and "Add a site" for that domain.',
            'Cloudflare shows two nameservers; set them as the domain DNS servers in the Aliyun domain console (域名 > DNS修改).',
            'Wait for Cloudflare to report the site as Active. This can take minutes to a few hours.',
          ],
        },
        {
          step: 2,
          what: 'Log cloudflared in to Cloudflare (browser once).',
          command: `"${binary.path}" tunnel login`,
        },
        {
          step: 3,
          what: 'Create the named tunnel.',
          command: `"${binary.path}" tunnel create ${name}`,
          detail: 'This writes a <uuid>.json credentials file into ~/.cloudflared.',
        },
        {
          step: 4,
          what: 'Point the hostname at the tunnel (creates the DNS record).',
          command: `"${binary.path}" tunnel route dns ${name} ${host}`,
        },
        {
          step: 5,
          what: 'Hand the details to this MCP server.',
          tool: 'tunnel_configure',
          arguments: { tunnelName: name, hostname: host },
          detail: `Then call tunnel_start. The URL https://${host} is permanent: restarts, sleep and reconnects reuse it.`,
        },
      ],
      notes: [
        'The free Cloudflare plan does not charge for the tunnel or for the DNS record.',
        'A .com is often cheaper on Aliyun first-year promotion, but renewal pricing is higher; check before buying.',
        'If the domain must stay on Aliyun DNS instead of Cloudflare nameservers, this named-tunnel plan will not work; a VPN-style tunnel (Tailscale) is the alternative.',
        'Optional but recommended: set CLOUDFLARE_API_TOKEN (Zone:Read, Cloudflare Tunnel:Read, Zone:DNS:Read) so cloudflare_verify can confirm the tunnel and DNS against Cloudflare itself instead of trusting local config.',
      ],
    })
  }),
)

server.registerTool(
  'tunnel_configure',
  {
    title: 'Configure permanent tunnel',
    description:
      'Save the named-tunnel details (or the cloudflared path) so tunnel_start and tunnel_url keep working without arguments. ' +
      'Blank values are ignored, and the generated cloudflared config never overwrites your ~/.cloudflared/config.yml.',
    inputSchema: {
      tunnelName: z.string().optional().describe('Cloudflare tunnel name, e.g. dsh-desktop.'),
      tunnelId: z.string().optional().describe('Tunnel UUID, used when the credentials file is not discoverable.'),
      hostname: z.string().optional().describe('Permanent public hostname, e.g. dsh.example.com.'),
      credentialsFile: z.string().optional().describe('Path to the <uuid>.json credentials file.'),
      cloudflaredPath: z.string().optional().describe('Path to cloudflared(.exe) if it is not bundled or on PATH.'),
      origin: z.string().optional().describe('Local gateway origin to expose, e.g. http://127.0.0.1:52231.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async (args) => withErrors(async () => {
    const patch = {}
    for (const key of ['tunnelName', 'tunnelId', 'hostname', 'credentialsFile', 'cloudflaredPath', 'origin']) {
      const value = args?.[key]
      if (typeof value === 'string' && value.trim().length > 0) patch[key] = value.trim()
    }
    const saved = manager.saveSettings(patch)
    const config = resolveTunnelConfig(saved, process.env)
    const ready = Boolean(config.tunnelId && config.credentialsFile && config.hostname)
    return textResult({
      saved,
      resolved: {
        tunnelId: config.tunnelId,
        tunnelName: config.tunnelName,
        credentialsFile: config.credentialsFile,
        hostname: config.hostname,
        permanentUrl: config.hostname ? `https://${config.hostname}` : null,
      },
      readyForPermanentTunnel: ready,
      next: ready
        ? 'Call tunnel_start to publish the permanent hostname.'
        : 'Still missing some of tunnelId / credentialsFile / hostname. Run tunnel_setup for the one-time Cloudflare steps.',
    })
  }),
)

server.registerTool(
  'gateway_health',
  {
    title: 'Gateway health',
    description:
      'Check whether the DeepSeek Harness Desktop gateway is reachable on loopback, discover its origin, and confirm ' +
      'whether the tunnel is actually forwarding it.',
    inputSchema: {
      origin: originField,
      checkPublic: z.boolean().optional().describe('Also request the public URL through Cloudflare (default false).'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ origin, checkPublic }) => withErrors(async () => {
    let resolved
    try {
      resolved = await resolveOrigin(origin)
    } catch (error) {
      return textResult({ local: { reachable: false, error: error.message }, hint: 'Start DeepSeek Harness Desktop first.' })
    }

    const payload = {
      local: resolved.probe ?? (await probeGateway(resolved.origin)),
      origin: resolved.origin,
      discoveredBy: resolved.discoveredBy,
      tunnel: manager.status(),
    }

    if (checkPublic === true && payload.tunnel.publicUrl) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      try {
        const response = await fetch(payload.tunnel.publicUrl, { redirect: 'manual', signal: controller.signal })
        payload.public = { url: payload.tunnel.publicUrl, status: response.status, ok: response.status < 500 }
      } catch (error) {
        payload.public = { url: payload.tunnel.publicUrl, ok: false, error: error?.message ?? String(error) }
      } finally {
        clearTimeout(timer)
      }
    }

    return textResult(payload)
  }),
)

server.registerTool(
  'gateway_devices',
  {
    title: 'Paired phones',
    description: 'List the phones paired with DeepSeek Harness Desktop, so you can tell whether re-pairing is needed after a URL change.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () => withErrors(async () => textResult({ ...readPairedDevices(process.env), userDataDir: desktopUserDataDir(process.env) })),
)

server.registerTool(
  'tunnel_diagnostics',
  {
    title: 'Tunnel diagnostics',
    description:
      'Full diagnostic snapshot: why the current address is or is not permanent, which setup steps are missing, ' +
      'the effective cloudflared config, and every file this MCP server owns.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () => withErrors(async () => {
    const status = manager.status({ includeOutput: true })
    const config = resolveTunnelConfig(manager.settings, process.env)
    const paths = statePaths(process.env)
    const devices = readPairedDevices(process.env)

    const blockers = []
    if (!status.binaryPresent && status.binary.source !== 'path') blockers.push(`cloudflared binary missing at ${status.binary.path}`)
    if (!config.loggedIn) blockers.push('cloudflared is not logged in (run: cloudflared tunnel login)')
    if (!config.tunnelId) blockers.push('no named tunnel UUID found; run: cloudflared tunnel create <name>')
    if (!config.credentialsFile) blockers.push('no credentials file found for the named tunnel')
    if (!config.hostname) blockers.push('no public hostname configured; run: cloudflared tunnel route dns <name> <host>')
    if (!manager.settings.origin) blockers.push('local gateway origin unknown; open the Desktop app or pass origin')

    return textResult({
      summary: blockers.length === 0
        ? `Permanent tunnel is fully configured for https://${config.hostname}.`
        : 'The tunnel is not yet permanently configured; see blockers.',
      addressIsPermanent: status.stable === true,
      blockers,
      cloudflareApi: readApiCredentials(process.env)
        ? 'A Cloudflare API token is present; run cloudflare_verify for Cloudflare-side confirmation.'
        : 'No Cloudflare API token set; only local config could be checked. Set CLOUDFLARE_API_TOKEN to verify the tunnel and DNS directly against Cloudflare.',
      status,
      resolved: {
        tunnelId: config.tunnelId,
        tunnelName: config.tunnelName,
        credentialsFile: config.credentialsFile,
        hostnames: config.hostnames,
        hostname: config.hostname,
        localTunnels: config.localTunnels,
        defaultConfigPath: config.defaultConfigPath,
        defaultConfigTunnel: config.defaultConfigTunnel,
      },
      settings: manager.settings,
      files: paths,
      pairedDevices: devices.devices,
      quickTunnelUrlInLogs: extractQuickTunnelUrl(status.recentOutput?.join('\n') ?? ''),
      providerNote: status.stable
        ? 'Named tunnel: one hostname for the lifetime of the domain.'
        : 'A non-permanent address is in play; a quick tunnel hostname is random and disposable, which is the reconnect problem being fixed.',
      boundary: describeBoundary(),
    })
  }),
)

server.registerTool(
  'tunnel_apply_to_desktop',
  {
    title: 'Apply permanent URL to Desktop app',
    description:
      'Write the permanent tunnel settings into the DeepSeek Harness Desktop state folder so the Desktop app reuses ' +
      'the same hostname on its next start instead of requesting a new random quick-tunnel address.',
    inputSchema: {
      write: z.boolean().optional().describe('Set false for a dry run that only reports what would change.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async ({ write }) => withErrors(async () => {
    const config = resolveTunnelConfig(manager.settings, process.env)
    if (!config.hostname) {
      return textResult({
        applied: false,
        reason: 'No permanent hostname is configured yet; call tunnel_setup and tunnel_configure first.',
      })
    }
    const target = desktopRemoteSettingsPath(process.env)
    const patch = buildDesktopRemoteSettingsPatch({
      hostname: config.hostname,
      tunnelName: config.tunnelName,
      tunnelId: config.tunnelId,
      credentialsFile: config.credentialsFile,
    })
    if (write !== true) {
      return textResult({ applied: false, dryRun: true, target, patch })
    }
    const result = writeDesktopRemoteSettings(patch, process.env)
    return textResult({ applied: true, target, patch, result })
  }),
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log(`ready (pid ${process.pid}); state root ${statePaths(process.env).root}`)

  const shutdown = async (reason) => {
    log(`shutting down (${reason}); leaving the tunnel process running so the phone address stays up`)
    try {
      manager.writeStatusFile({ stoppedByHost: false })
    } catch {
      // ignore
    }
    try {
      await server.close()
    } catch {
      // ignore
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.stdin.on('close', () => { void shutdown('stdin closed') })
}

main().catch((error) => {
  log(`fatal: ${error?.stack ?? error}`)
  process.exit(1)
})
