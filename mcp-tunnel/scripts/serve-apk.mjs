// Serve one APK over the public internet so a phone can download it in a browser.
//
// Deliberately isolated from the phone gateway: it runs its own tiny HTTP server
// and its own throwaway quick tunnel on a random hostname, so publishing a build
// cannot disturb a live pairing session and cannot claim the permanent domain.
//
//   node scripts/serve-apk.mjs <path-to.apk> [--port 0] [--minutes 30]

import crypto from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { resolveCloudflared } from '../src/config.mjs'

const args = process.argv.slice(2)
const apkPath = args.find((value) => !value.startsWith('--'))
if (!apkPath) {
  console.error('usage: node scripts/serve-apk.mjs <path-to.apk> [--minutes 30]')
  process.exit(1)
}
const minutesIndex = args.indexOf('--minutes')
const lifetimeMs = (minutesIndex >= 0 ? Number(args[minutesIndex + 1]) : 30) * 60_000
const portIndex = args.indexOf('--port')
const requestedPort = portIndex >= 0 ? Number(args[portIndex + 1]) : 0

let stat
try {
  stat = statSync(apkPath)
} catch (error) {
  console.error(`Cannot read APK: ${error.message}`)
  process.exit(1)
}
if (!stat.isFile()) {
  console.error(`Not a file: ${apkPath}`)
  process.exit(1)
}

const fileName = path.basename(apkPath)
// A one-time path segment keeps the download from being guessable while the
// tunnel is public. It is not a substitute for the OS keeping the URL private.
const token = crypto.randomBytes(16).toString('hex')
const route = `/download/${token}/${encodeURIComponent(fileName)}`

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/' || url.pathname === `/${token}`) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>下载 DeepSeek Harness Remote</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;font:16px/1.6 system-ui,sans-serif;background:#0b1220;color:#e2e8f0;padding:24px;box-sizing:border-box}
a{display:inline-block;padding:16px 28px;border-radius:14px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600}
p{opacity:.75;font-size:14px}</style></head><body><div style="text-align:center">
<h2>DeepSeek Harness Remote</h2>
<p>${fileName} · ${(stat.size / 1024 / 1024).toFixed(2)} MB</p>
<a href="${route}" download>下载 APK</a>
<p>安装时可能需要临时允许「安装未知应用」。</p>
</div></body></html>`)
    return
  }
  if (url.pathname === route) {
    response.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': String(stat.size),
      'content-disposition': `attachment; filename="${fileName}"`,
      'cache-control': 'no-store',
    })
    createReadStream(apkPath).pipe(response)
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('not found')
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(requestedPort, '127.0.0.1', resolve)
})
const origin = `http://127.0.0.1:${server.address().port}`
console.log(`Serving ${fileName} on ${origin}${route}`)

const cloudflared = resolveCloudflared(null, process.env)
const child = spawn(cloudflared.path, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', origin], {
  windowsHide: true,
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let published = null
const onOutput = (chunk) => {
  const text = chunk.toString('utf8')
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i.exec(text)
  if (match && published === null) {
    published = match[0]
    console.log(`\nPUBLIC_URL=${published}${route}\n`)
    console.log(`EXPIRES_IN_MINUTES=${Math.round(lifetimeMs / 60_000)}`)
    console.log('Serve this on the phone; the tunnel dies when this process stops.')
  }
}
child.stdout.on('data', onOutput)
child.stderr.on('data', onOutput)
child.once('exit', (code) => {
  console.log(`cloudflared exited (code ${code ?? 'unknown'})`)
})
child.once('error', (error) => {
  console.error(`cloudflared failed: ${error.message}`)
})

const stop = (reason) => {
  console.log(`Stopping (${reason})`)
  try { child.kill() } catch {}
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2_000).unref?.()
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
setTimeout(() => stop('lifetime reached'), lifetimeMs).unref?.()

// Keep the process alive until a signal or the deadline.
await new Promise(() => {})
