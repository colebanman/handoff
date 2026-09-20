// Inspect files eligible for Git publication without printing matched values.
import { execFileSync } from 'node:child_process'
import { readFileSync, lstatSync } from 'node:fs'

const paths = [...new Set(execFileSync('git', [
  'ls-files', '--cached', '--others', '--exclude-standard', '-z',
], { encoding: 'utf8' }).split('\0').filter(Boolean))]
const findings = []
const report = (path, line, reason) => findings.push(`${path}${line ? `:${line}` : ''}: ${reason}`)
const denied = /(?:^|\/)(?:node_modules|dist(?:-[^/]*)?|raw|staging|processed|runs|\.claude|\.codex|\.cursor|\.vscode|\.handoff-bridge)(?:\/|$)|(?:^|\/)\.env(?:\..*)?$|\.(?:pem|key|p12|pfx|har|log|zip|crx|tgz)$|(?:^|\/)curl\.txt$|(?:^|\/)[^/]*-chats-[^/]*\.json$/i
const secrets = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{30,})\b/g,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/g,
]
const email = /\b[A-Za-z0-9._%+-]{1,100}@([A-Za-z0-9.-]{1,100}\.[A-Za-z]{2,})\b/g
const hostPath = /(?:\/Users\/|\/home\/|[A-Z]:[\\/]+Users[\\/]+)([A-Za-z0-9_.-]+)/g
const machineExtension = /chrome-extension:\/\/[a-p]{32}\b/g
const oldBrand = /ai-extension|AI Extension|\bSam\b|\bsam[-_]|SAM_BRIDGE|AI_EXT_/g

for (const path of paths.sort()) {
  if (denied.test(path) && path !== '.env.example') report(path, 0, 'local/private/generated file is eligible for publication')
  let stat
  try { stat = lstatSync(path) } catch { continue }
  if (stat.isSymbolicLink()) { report(path, 0, 'review symlink before publication'); continue }
  if (!stat.isFile()) continue
  const data = readFileSync(path)
  if (data.subarray(0, 4096).includes(0)) {
    const publicImage = /^public\/icons\/icon-(16|32|48|128)\.png$/.test(path)
      || /^docs\/screenshots\/(conversation|file)\.png$/.test(path)
    if (!publicImage) report(path, 0, 'unexpected binary file')
    continue
  }
  const text = data.toString('utf8')
  const lineAt = (index) => text.slice(0, index).split('\n').length
  for (const pattern of secrets) {
    for (const match of text.matchAll(pattern)) report(path, lineAt(match.index), 'credential-shaped literal')
  }
  for (const match of text.matchAll(email)) {
    if (!/(?:^|\.)example\.(?:com|org|net|test)$|\.test$|\.invalid$/i.test(match[1])) {
      report(path, lineAt(match.index), 'non-example email address')
    }
  }
  for (const match of text.matchAll(hostPath)) {
    if (!['me', 'nobody', 'user', 'example', '...'].includes(match[1])) report(path, lineAt(match.index), 'personal machine path')
  }
  for (const match of text.matchAll(machineExtension)) report(path, lineAt(match.index), 'hard-coded installation ID')
  if (path !== 'scripts/audit-public.mjs') {
    for (const match of text.matchAll(oldBrand)) report(path, lineAt(match.index), 'legacy product branding')
  }
}

if (findings.length) {
  console.error(findings.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Publication check passed: ${paths.length} eligible files; no matched credentials, personal paths, or legacy branding.`)
}
