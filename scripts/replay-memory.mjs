// Read-only normalization audit. Never executes historical tools or calls a model.
// node scripts/replay-memory.mjs /path/to/chat-export.json [/tmp/memory-report.json]
import { build } from 'esbuild'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const input = process.argv[2]
if (!input) throw new Error('Supply the path to a chat export. The export stays outside the repository.')
const dir = await mkdtemp(join(tmpdir(), 'memory-replay-'))
try {
  const modulePath = join(dir, 'evidence.mjs')
  await build({ entryPoints: ['src/agent/memory-evidence.ts'], outfile: modulePath, bundle: true, platform: 'node', format: 'esm', define: { __DEV_BUILD__: 'false' } })
  const { extractMemoryEvents } = await import(pathToFileURL(modulePath).href)
  const data = JSON.parse(await readFile(input, 'utf8'))
  if (!Array.isArray(data.chats)) throw new Error('Expected a chats array.')
  const report = { chats: data.chats.length, events: 0, units: 0, characters: 0, origins: {}, outcomes: {}, failed: [], probes: { completionCorrection: false, automationNotHuman: false }, elapsedMs: 0 }
  const started = performance.now()
  let count = 0
  for (const chat of [...data.chats].sort((a, b) => a.createdAt - b.createdAt)) {
    try {
      const events = await extractMemoryEvents(chat)
      report.events += events.length
      report.units += new Set(events.map(e => e.parentId)).size
      for (const event of events) {
        report.characters += event.text.length
        report.origins[event.origin] = (report.origins[event.origin] ?? 0) + 1
        if (event.outcome) report.outcomes[event.outcome] = (report.outcomes[event.outcome] ?? 0) + 1
        if (event.origin === 'human' && /\b(?:completed|finished|done)\b/i.test(event.text)) report.probes.completionCorrection = true
        if (event.origin === 'automation') report.probes.automationNotHuman = true
      }
    } catch (error) { report.failed.push({ chatId: chat.id, error: String(error) }) }
    if (++count % 50 === 0) console.log(`Normalized ${count}/${data.chats.length} chats`)
  }
  report.elapsedMs = Math.round(performance.now() - started)
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (report.failed.length) process.exitCode = 1
} finally { await rm(dir, { recursive: true, force: true }) }
