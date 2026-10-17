// Optional Cloudflare API verification.
//
// Static configuration can say a tunnel exists while Cloudflare disagrees — the
// tunnel may have been deleted, the DNS route may be missing, or the credentials
// may belong to a different account. With an API token this module turns "my
// config looks right" into "Cloudflare confirms it", which is what a permanent
// address actually depends on.
//
// The token is read from CLOUDFLARE_API_TOKEN (or CLOUDFLARE_API_KEY plus
// CLOUDFLARE_EMAIL) and is never written to disk or included in any result.

const API = 'https://api.cloudflare.com/client/v4'

export function readApiCredentials(env = process.env) {
  const token = nonEmpty(env.CLOUDFLARE_API_TOKEN)
  if (token) return { kind: 'bearer', token }
  const key = nonEmpty(env.CLOUDFLARE_API_KEY)
  const email = nonEmpty(env.CLOUDFLARE_EMAIL)
  if (key && email) return { kind: 'key', token: key, email }
  return null
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

async function apiRequest(credentials, pathname, options = {}) {
  const headers = { 'content-type': 'application/json' }
  if (credentials.kind === 'bearer') headers.authorization = `Bearer ${credentials.token}`
  else {
    headers['x-auth-key'] = credentials.token
    headers['x-auth-email'] = credentials.email
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  try {
    const response = await fetch(`${API}${pathname}`, { method: options.method ?? 'GET', headers, signal: controller.signal })
    const body = await response.json().catch(() => null)
    return { status: response.status, ok: response.ok, body }
  } catch (error) {
    return { status: null, ok: false, body: null, error: error?.cause?.code ? `${error.cause.code}: ${error.cause.message}` : (error?.message ?? String(error)) }
  } finally {
    clearTimeout(timer)
  }
}

/** Verify a token and report which zones it can see. */
export async function verifyCredentials(env = process.env) {
  const credentials = readApiCredentials(env)
  if (!credentials) {
    return {
      configured: false,
      hint: 'Set CLOUDFLARE_API_TOKEN (Zone:Read + Cloudflare Tunnel:Read) to let the MCP server verify the tunnel against Cloudflare itself.',
    }
  }
  const result = await apiRequest(credentials, '/user/tokens/verify')
  if (!result.ok) {
    const message = result.error ?? result.body?.errors?.map((entry) => entry.message).join('; ') ?? `HTTP ${result.status}`
    return { configured: true, valid: false, error: message }
  }
  const zones = await apiRequest(credentials, '/zones?per_page=50')
  return {
    configured: true,
    valid: true,
    kind: credentials.kind,
    status: result.body?.result?.status ?? null,
    zones: Array.isArray(zones.body?.result)
      ? zones.body.result.map((zone) => ({ id: zone.id, name: zone.name, status: zone.status }))
      : [],
    zonesError: zones.ok ? null : (zones.body?.errors?.map((entry) => entry.message).join('; ') ?? `HTTP ${zones.status}`),
  }
}

async function findZoneId(credentials, hostname) {
  const labels = String(hostname ?? '').split('.').filter(Boolean)
  // Try progressively shorter suffixes so subdomains resolve to their zone.
  for (let index = 0; index <= Math.max(0, labels.length - 2); index += 1) {
    const candidate = labels.slice(index).join('.')
    const result = await apiRequest(credentials, `/zones?name=${encodeURIComponent(candidate)}`)
    const zone = result.body?.result?.[0]
    if (zone?.id) return zone
  }
  return null
}

/**
 * Confirm the tunnel exists and that its hostname has a proxied DNS record.
 * Every check is reported separately so a partial answer stays honest.
 */
export async function verifyTunnel({ tunnelId, hostname, accountId }, env = process.env) {
  const credentials = readApiCredentials(env)
  if (!credentials) {
    return { verified: false, configured: false, reason: 'No Cloudflare API token configured.' }
  }
  if (!tunnelId) return { verified: false, configured: true, reason: 'No tunnel UUID to check.' }

  const report = {
    verified: false,
    configured: true,
    tunnel: { found: false },
    dns: { checked: false },
  }

  const tunnelResult = await apiRequest(
    credentials,
    accountId
      ? `/accounts/${accountId}/cfd_tunnel/${tunnelId}`
      : `/accounts/unknown/cfd_tunnel/${tunnelId}`,
  )

  if (!accountId) {
    // Without an account id, list the accounts the token can see and search each.
    const accounts = await apiRequest(credentials, '/accounts?per_page=50')
    const list = Array.isArray(accounts.body?.result) ? accounts.body.result : []
    report.accountsChecked = list.map((account) => account.name)
    for (const account of list) {
      const single = await apiRequest(credentials, `/accounts/${account.id}/cfd_tunnel/${tunnelId}`)
      if (single.ok && single.body?.result) {
        report.tunnel = summariseTunnel(single.body.result)
        report.accountId = account.id
        report.tunnel.found = true
        break
      }
    }
  } else if (tunnelResult.ok && tunnelResult.body?.result) {
    report.tunnel = { ...summariseTunnel(tunnelResult.body.result), found: true }
  } else {
    report.tunnel.error = tunnelResult.body?.errors?.map((entry) => entry.message).join('; ')
      ?? `HTTP ${tunnelResult.status}`
  }

  if (hostname) {
    const zone = await findZoneId(credentials, hostname)
    report.dns.checked = true
    if (!zone) {
      report.dns.error = `Cloudflare has no zone matching ${hostname}; the domain is not on Cloudflare yet.`
    } else {
      report.dns.zone = { id: zone.id, name: zone.name, status: zone.status }
      const records = await apiRequest(
        credentials,
        `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}&type=CNAME`,
      )
      const list = Array.isArray(records.body?.result) ? records.body.result : []
      const expectedTarget = `${tunnelId}.cfargotunnel.com`
      const matching = list.find((record) => record.content === expectedTarget)
      report.dns.records = list.map((record) => ({ type: record.type, name: record.name, content: record.content, proxied: record.proxied }))
      if (matching) {
        report.dns.pointsAtTunnel = true
        report.dns.proxied = matching.proxied === true
        if (matching.proxied !== true) {
          report.dns.warning = 'The DNS record is not proxied (grey cloud), so Cloudflare will not route it to the tunnel.'
        }
      } else if (list.length > 0) {
        report.dns.pointsAtTunnel = false
        report.dns.error = `A CNAME exists but points at ${list[0].content} instead of ${expectedTarget}.`
      } else {
        report.dns.pointsAtTunnel = false
        report.dns.error = `No CNAME record for ${hostname}. Run: cloudflared tunnel route dns <name> ${hostname}`
      }
    }
  } else {
    report.dns.error = 'No hostname configured to check.'
  }

  report.verified = report.tunnel.found === true && report.dns.pointsAtTunnel === true && report.dns.proxied === true
  return report
}

function summariseTunnel(raw) {
  return {
    id: raw.id,
    name: raw.name,
    status: raw.status,
    createdAt: raw.created_at,
    connections: Array.isArray(raw.connections) ? raw.connections.length : null,
  }
}

/** List every tunnel in the account, to help pick a name. */
export async function listTunnels(env = process.env) {
  const credentials = readApiCredentials(env)
  if (!credentials) return { configured: false, reason: 'No Cloudflare API token configured.' }
  const accounts = await apiRequest(credentials, '/accounts?per_page=50')
  const list = Array.isArray(accounts.body?.result) ? accounts.body.result : []
  const tunnels = []
  for (const account of list) {
    const result = await apiRequest(credentials, `/accounts/${account.id}/cfd_tunnel?per_page=50`)
    if (!Array.isArray(result.body?.result)) continue
    for (const tunnel of result.body.result) {
      tunnels.push({ account: account.name, ...summariseTunnel(tunnel) })
    }
  }
  return { configured: true, tunnels, accounts: list.map((account) => account.name) }
}
