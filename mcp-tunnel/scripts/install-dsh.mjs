// Register this MCP server with the DeepSeek Harness profile.
//
// Writes (or refreshes) the `dsh-tunnel-mcp` entry in the profile's
// cordis.patch.yml, backing the file up first. Idempotent: re-running replaces
// only this entry and leaves every other entry untouched.
//
//   node scripts/install-dsh.mjs                  # patch the active profile
//   node scripts/install-dsh.mjs --print          # show what would change
//   node scripts/install-dsh.mjs --uninstall      # remove the entry
//   node scripts/install-dsh.mjs --file <path>    # patch a specific cordis.patch.yml

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const ENTRY_ID = 'dsh-tunnel-mcp'
const SERVER_NAME = 'dsh_tunnel'

const args = process.argv.slice(2)
const printOnly = args.includes('--print')
const uninstall = args.includes('--uninstall')
const fileIndex = args.indexOf('--file')
const explicitFile = fileIndex >= 0 ? args[fileIndex + 1] : null

function resolveProfilePatch() {
  if (explicitFile) return path.resolve(explicitFile)
  const profileDir = process.env.DSH_PROFILE_DIR
    || (process.env.DSH_HOME
      ? path.join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'desktop')
      : path.join(os.homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE || 'desktop'))
  const candidates = [
    path.join(profileDir, 'cordis.patch.yml'),
    path.join(profileDir, 'cordis.yml'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

const target = resolveProfilePatch()
const entry = [
  `# --- ${ENTRY_ID}: permanent public address for the phone gateway ---`,
  '# Replaces the Desktop app\'s random trycloudflare.com quick tunnel with a',
  '# Cloudflare named tunnel, so the phone URL never changes. Remove this block',
  '# (and nothing else) to uninstall.',
  '- insert:',
  `    - id: ${ENTRY_ID}`,
  '      name: "@deepseek-ai/dsh-mcp-client"',
  '      config:',
  `        serverName: ${SERVER_NAME}`,
  '        transport: stdio',
  `        command: ${process.execPath}`,
  '        args:',
  `          - ${path.join(projectRoot, 'bin', 'dsh-tunnel-mcp.mjs')}`,
  '        failOnStartupError: false',
  '        toolCallTimeoutMs: 120000',
  '        reconnect:',
  '          enabled: true',
  '          maxAttempts: 20',
  '',
].join('\n')

const summary = {
  target,
  entryId: ENTRY_ID,
  serverName: SERVER_NAME,
  command: process.execPath,
  script: path.join(projectRoot, 'bin', 'dsh-tunnel-mcp.mjs'),
}

if (!existsSync(target)) {
  if (uninstall) {
    process.stdout.write(`${JSON.stringify({ ...summary, action: 'noop', reason: 'patch file does not exist' }, null, 2)}\n`)
    process.exit(0)
  }
  summary.created = true
} else {
  summary.created = false
}

const existing = existsSync(target) ? readFileSync(target, 'utf8') : ''
const hasEntry = existing.includes(`id: ${ENTRY_ID}`)

/** Drop a previously written entry block (the comment header through its config). */
function stripEntry(text) {
  const lines = text.split(/\r?\n/)
  const kept = []
  let skipping = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!skipping && line.startsWith('- insert:') && (lines[index + 1] ?? '').trim() === `- id: ${ENTRY_ID}`) {
      skipping = true
      // Also drop an immediately preceding comment header we wrote.
      while (kept.length > 0 && kept[kept.length - 1].trim().startsWith('#')) kept.pop()
      while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
      continue
    }
    if (skipping) {
      // The entry ends at the next top-level list item or at the first dedented
      // line that is not part of the block.
      const isDedented = line.length > 0 && !/^\s/.test(line)
      if (isDedented && !line.startsWith('- insert:') && !line.startsWith('- id:')) {
        skipping = false
        kept.push(line)
        continue
      }
      if (/^\s*$/.test(line)) {
        // Blank lines inside the block are dropped; a blank line ending it is
        // handled by the next non-blank line.
        continue
      }
      continue
    }
    kept.push(line)
  }
  return `${kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

let next
if (uninstall) {
  next = stripEntry(existing)
  summary.action = hasEntry ? 'removed' : 'noop'
  if (!hasEntry) summary.reason = 'entry not present'
} else if (hasEntry) {
  next = `${stripEntry(existing).trimEnd()}\n\n${entry}`
  summary.action = 'refreshed'
} else {
  const base = existing.trimEnd()
  next = base.length > 0 ? `${base}\n\n${entry}` : entry
  summary.action = 'added'
}

summary.before = { lines: existing.split('\n').length }
summary.after = { lines: next.split('\n').length }

if (printOnly) {
  process.stdout.write(`${JSON.stringify({ ...summary, dryRun: true, preview: next }, null, 2)}\n`)
  process.exit(0)
}

if (summary.action === 'noop') {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.exit(0)
}

// Back up once, and write atomically so a failure cannot truncate the profile.
mkdirSync(path.dirname(target), { recursive: true })
const backup = `${target}.bak-tunnel-mcp`
if (existsSync(target) && !existsSync(backup)) {
  copyFileSync(target, backup)
  summary.backup = backup
}
const temp = `${target}.tmp`
writeFileSync(temp, next, 'utf8')
renameSync(temp, target)

summary.written = true
summary.note = 'Restart DeepSeek Harness (or reload this plugin entry) so the new MCP server is spawned.'
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
