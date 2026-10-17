// Reachability and stability probes.
//
// The reason this exists: a tunnel can report "connected" while its public data
// path is being reset. The Desktop app only ever proved the cloudflared process
// started, never that the phone could actually reach the address, so a broken
// edge path looked identical to a working one.

import dns from 'node:dns/promises'
import https from 'node:https'
import { URL } from 'node:url'

// Windows has no /etc/resolv.conf, so node:readline cannot help here.
async function systemResolverServers() {
  try {
    return dns.getServers()
  } catch {
    return []
  }
}

/**
 * Resolve records over DNS-over-HTTPS.
 *
 * This is required rather than optional: a VPN or proxy can point the system
 * resolver at `127.0.0.1`, where `dns.resolve*` then fails with ECONNREFUSED
 * because nothing serves plain port-53 on loopback. DoH asks a public resolver
 * directly, so we can still learn the domain's real public DNS state.
 */
async function dohQuery(name, type) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6_000)
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: 'application/dns-json' }, signal: controller.signal },
    )
    if (!response.ok) return []
    const body = await response.json()
    if (!Array.isArray(body?.Answer)) return []
    return body.Answer
      .filter((entry) => entry.type === (type === 'NS' ? 2 : 1))
      .map((entry) => String(entry.data).replace(/\.$/, ''))
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** Resolve with OS resolver first, then DoH, so a local-only resolver still works. */
export async function resolveRecords(name, type) {
  const method = type === 'NS' ? 'resolveNs' : 'resolve4'
  const attempts = []

  if (typeof dns[method] === 'function') {
    try {
      const values = await dns[method](name)
      if (Array.isArray(values) && values.length > 0) {
        return { values: values.map((value) => String(value).replace(/\.$/, '')), source: 'system-resolver' }
      }
    } catch (error) {
      attempts.push({ source: 'system-resolver', error: error.code ?? error.message })
    }
  }

  const doh = await dohQuery(name, type)
  if (doh.length > 0) return { values: doh, source: 'dns-over-https', attempts }

  return { values: [], source: null, attempts }
}

/**
 * Whether a domain's authoritative DNS has moved to Cloudflare.
 *
 * A Cloudflare named tunnel only routes traffic when the hostname is proxied by
 * Cloudflare, which requires the registrable domain to use Cloudflare's
 * nameservers. Checking this is the difference between "I bought a domain" and
 * "the domain can actually serve the tunnel".
 */
const CLOUDFLARE_NS_RE = /\.ns\.cloudflare\.com$/i
const ALIYUN_NS_RE = /\.(hichina|aliyun|alidns)\.com$/i

export async function inspectDomain(domain) {
  const name = String(domain ?? '').trim().toLowerCase()
  if (name.length === 0) return { domain: name, ready: false, reason: 'no domain provided' }

  const report = {
    domain: name,
    nameservers: [],
    onCloudflare: false,
    onAliyunDns: false,
    apex: null,
    warnings: [],
    ready: false,
    nextStep: null,
  }

  try {
    const resolved = await resolveRecords(name, 'NS')
    report.nameservers = resolved.values.map((value) => value.toLowerCase()).sort()
    report.nsSource = resolved.source
    if (resolved.values.length === 0) {
      report.warnings.push(`could not read NS records for ${name} (tried system resolver, then DNS-over-HTTPS)`)
    }
  } catch (error) {
    report.warnings.push(`could not read NS records for ${name}: ${error.code ?? error.message}`)
    report.nextStep = 'Check that the domain is registered and its nameservers are configured.'
    return report
  }

  if (report.nameservers.length === 0) {
    report.warnings.push(
      'No NS answer was available. If this machine uses a VPN that redirects DNS to loopback, DNS-over-HTTPS was used ' +
      'as a fallback; a failure here means outbound HTTPS to the public resolver is also blocked.',
    )
    report.nextStep = 'Verify the domain from a network without DNS interception, or check it in the Cloudflare dashboard.'
    return report
  }

  const cfCount = report.nameservers.filter((ns) => CLOUDFLARE_NS_RE.test(ns)).length
  report.onCloudflare = cfCount > 0
  report.onAliyunDns = report.nameservers.some((ns) => ALIYUN_NS_RE.test(ns))
  if (cfCount > 0 && cfCount < report.nameservers.length) {
    report.warnings.push('only some nameservers point at Cloudflare; DNS propagation may still be in progress')
  }

  const apex = await resolveRecords(name, 'A')
  report.apex = apex.values.map(classifyAddress)
  report.apexSource = apex.source
  report.apexOnThisMachine = apex.values
  if (report.apex.some((record) => record.notes.some((note) => note.includes('proxy/VPN')))) {
    report.warnings.push('this machine resolves the domain to a proxy/VPN synthetic address; DNS here is being intercepted')
  }

  if (report.onCloudflare) {
    report.ready = true
    report.nextStep = 'Domain is on Cloudflare. Continue with: cloudflared tunnel login / create / route dns.'
  } else if (report.onAliyunDns) {
    report.nextStep =
      'Nameservers still belong to Aliyun DNS (hichina.com). Add the site in Cloudflare, then set the two ' +
      'Cloudflare nameservers in the Aliyun domain console (域名 > DNS修改), and wait for Cloudflare to report Active.'
  } else {
    report.nextStep = 'Nameservers are neither Cloudflare nor Aliyun; confirm where DNS is hosted before continuing.'
  }

  return report
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
]
const INTERCEPT_RANGES = [
  { name: 'VPN fake-IP / CGNAT (198.18.0.0/15)', test: (ip) => /^198\.(1[89])\./.test(ip) },
  { name: 'VPN fake-IP (198.18.0.0/15) or benchmark range', test: (ip) => /^198\.1[0-9]\./.test(ip) },
]

export function classifyAddress(address) {
  const notes = []
  if (address.includes(':')) {
    if (/^2001:2::/i.test(address)) notes.push('NAT64 well-known prefix (2001:2::/48): IPv6 was synthesised by a translator')
    else if (/^(f[cd]|fe80)/i.test(address)) notes.push('private or link-local IPv6')
    return { address, family: 6, notes }
  }
  if (PRIVATE_V4.some((re) => re.test(address))) notes.push('private or non-routable IPv4')
  for (const range of INTERCEPT_RANGES) {
    if (range.test(address)) notes.push(`address is inside ${range.name}: a proxy/VPN is answering DNS locally`)
  }
  return { address, family: 4, notes }
}

export async function inspectDns(hostname) {
  const result = { hostname, v4: [], v6: [], errors: [], flags: [], source: null, localAnswers: [] }

  // OS resolver first (that is what a browser on this machine uses), then DoH.
  for (const type of ['A', 'AAAA']) {
    let values = []
    let source = null
    try {
      values = type === 'A' ? await dns.resolve4(hostname) : await dns.resolve6(hostname)
      source = 'system-resolver'
    } catch (error) {
      result.errors.push(`${type} via system resolver: ${error.code ?? error.message}`)
    }

    // Also ask a public resolver. When the OS answer is a proxy/VPN synthetic
    // address, the DoH answer is the address a phone on another network sees,
    // and the difference is exactly what explains "works here, not there".
    const doh = await dohQuery(hostname, type)
    const classified = values.map(classifyAddress)
    const dohClassified = doh.map(classifyAddress)
    const intercepted = classified.some((record) => record.notes.some((note) => note.includes('proxy/VPN') || note.includes('NAT64')))

    if (values.length === 0 && doh.length > 0) {
      source = 'dns-over-https'
    }
    if (type === 'A') {
      result.v4 = classified.length > 0 ? classified : dohClassified
      result.v4Public = dohClassified
    } else {
      result.v6 = classified.length > 0 ? classified : dohClassified
      result.v6Public = dohClassified
    }
    if (source && result.source === null) result.source = source
    if (intercepted) {
      result.warnings = result.warnings ?? []
      const publicText = doh.length > 0 ? doh.join(', ') : 'no public answer'
      result.warnings.push(
        `this machine got an intercepted ${type} answer for ${hostname}; the public DNS answer is ${publicText}`,
      )
    }
    result.localAnswers.push({ type, source, values, publicValues: doh })
  }
  for (const record of [...result.v4, ...result.v6]) {
    for (const note of record.notes) if (!result.flags.includes(note)) result.flags.push(note)
  }
  if (result.v4.length === 0 && result.v6.length === 0) {
    result.flags.push('hostname does not resolve at all; DNS is not set up yet or is being blocked')
  }
  return result
}

/** One HTTPS GET, reporting the network-level error instead of "fetch failed". */
export function httpsProbe(url, { timeoutMs = 20_000, family } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      resolve({ ok: false, url, error: 'invalid URL' })
      return
    }
    const request = https.get(
      { hostname: parsed.hostname, port: parsed.port || 443, path: `${parsed.pathname}${parsed.search}`, method: 'GET', timeout: timeoutMs, ...(family ? { family } : {}) },
      (response) => {
        let bytes = 0
        response.on('data', (chunk) => { bytes += chunk.length })
        response.on('end', () => resolve({
          ok: response.statusCode >= 200 && response.statusCode < 400,
          status: response.statusCode,
          elapsedMs: Date.now() - started,
          serverHeader: response.headers.server ?? null,
          cfRay: response.headers['cf-ray'] ?? null,
          bytes,
          family: family ?? 'auto',
        }))
        response.resume()
      },
    )
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', (error) => resolve({
      ok: false,
      elapsedMs: Date.now() - started,
      error: `${error.code ?? ''} ${error.message}`.trim(),
      family: family ?? 'auto',
    }))
  })
}

/**
 * Repeated probes, so an intermittent edge path is visible instead of being
 * hidden behind one lucky success. This is the number that predicts whether the
 * phone will stay connected.
 */
export async function measureStability(url, { attempts = 5, intervalMs = 1_500, timeoutMs = 15_000 } = {}) {
  const samples = []
  for (let index = 0; index < attempts; index += 1) {
    samples.push(await httpsProbe(url, { timeoutMs }))
    if (index < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  const succeeded = samples.filter((sample) => sample.ok).length
  const latencies = samples.filter((sample) => typeof sample.elapsedMs === 'number').map((sample) => sample.elapsedMs)
  const errors = {}
  for (const sample of samples) {
    if (sample.ok) continue
    const key = sample.status ? `HTTP ${sample.status}` : (sample.error ?? 'unknown')
    errors[key] = (errors[key] ?? 0) + 1
  }
  return {
    url,
    attempts: samples.length,
    succeeded,
    successRate: samples.length === 0 ? 0 : succeeded / samples.length,
    medianLatencyMs: latencies.length === 0 ? null : latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)],
    errors,
    samples,
    verdict: succeeded === samples.length
      ? 'stable: every probe succeeded'
      : succeeded === 0
        ? 'unreachable: no probe succeeded, so the phone will not connect either'
        : 'flaky: some probes failed, which matches the reconnect problem',
  }
}
