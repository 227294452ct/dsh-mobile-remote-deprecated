// Read the cloudflared login token from ~/.cloudflared/cert.pem and report the
// Cloudflare-side state of the zone. The token is never printed or written.
//
// This is a diagnostic only: it makes read requests.

import { readFileSync } from 'node:fs'
import path from 'node:path'

const certPath = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.cloudflared', 'cert.pem')

function readArgoToken() {
  const pem = readFileSync(certPath, 'utf8')
  const base64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
  if (!payload.apiToken) throw new Error('cert.pem has no apiToken')
  return payload
}

const { zoneID, accountID, apiToken } = readArgoToken()

async function api(pathname) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, ok: response.ok, body }
}

const report = {
  certPath,
  credentialsPresent: { zoneID: Boolean(zoneID), accountID: Boolean(accountID), apiToken: true },
}

const tokenCheck = await api('/user/tokens/verify')
report.tokenValid = tokenCheck.ok && tokenCheck.body?.result?.status === 'active'
report.tokenStatus = tokenCheck.body?.result?.status ?? null

const zone = await api(`/zones/${zoneID}`)
if (zone.ok) {
  const result = zone.body.result
  report.zone = {
    name: result.name,
    status: result.status,
    paused: result.paused,
    type: result.type,
    nameServers: result.name_servers,
    originalNameServers: result.original_name_servers,
  }
} else {
  report.zoneError = {
    status: zone.status,
    errors: zone.body?.errors?.map((entry) => `${entry.code}: ${entry.message}`) ?? null,
  }
}

// What does Cloudflare think the delegation should be, and what does the
// registry actually publish?
if (report.zone?.nameServers?.length) {
  report.delegationMismatch = {
    assignedByCloudflare: report.zone.nameServers,
    originalNameServers: report.zone.originalNameServers ?? null,
  }
}

const tunnels = await api(`/accounts/${accountID}/cfd_tunnel?per_page=50`)
if (tunnels.ok) {
  report.existingTunnels = (tunnels.body.result ?? []).map((tunnel) => ({
    id: tunnel.id,
    name: tunnel.name,
    status: tunnel.status,
    connections: Array.isArray(tunnel.connections) ? tunnel.connections.length : 0,
  }))
} else {
  report.tunnelListError = tunnels.body?.errors?.map((entry) => entry.message) ?? `HTTP ${tunnels.status}`
}

const dns = await api(`/zones/${zoneID}/dns_records?per_page=100`)
if (dns.ok) {
  report.dnsRecords = (dns.body.result ?? []).map((record) => ({
    type: record.type,
    name: record.name,
    content: record.content,
    proxied: record.proxied,
  }))
} else {
  report.dnsError = dns.body?.errors?.map((entry) => entry.message) ?? `HTTP ${dns.status}`
}

console.log(JSON.stringify(report, null, 2))
