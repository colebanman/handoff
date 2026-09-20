/** Usage: node scripts/backtest-browser-snapshots.mjs /absolute/path/chats.json
 * Offline only. Historical exports lack Chrome node identities, so the adapter
 * retains their recorded eN refs and conservatively identifies unchanged text
 * by exact content/occurrence. This tests representation/reconstruction and
 * reference availability, NOT live identity tracking or model task success. */
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

if (!process.argv[2]) throw new Error('Pass the chat export JSON path')
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'browser-snapshot-backtest-'))
try {
  const bundle = await build({ stdin: { contents: `export * from './src/shared/browser-snapshot'; export * from './src/agent/browser-snapshot-context'`, resolveDir: root },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
  const modulePath = join(temp, 'snapshot.mjs')
  await writeFile(modulePath, bundle.outputFiles[0].text)
  const lib = await import(pathToFileURL(modulePath).href)
  const data = JSON.parse(await readFile(process.argv[2], 'utf8'))
  const chats = data.chats ?? data
  const all = { chats: 0, observations: 0, deltas: 0, originalCharacters: 0, encodedCharacters: 0,
    reconstructionFailures: 0, checkedActionRefs: 0, originallyUnavailableRefs: 0, skippedPartial: 0 }
  const qwen = { chats: 0, observations: 0, deltas: 0, originalCharacters: 0, encodedCharacters: 0 }
  const tools = new Set(['browser_snapshot', 'browser_click', 'browser_navigate', 'browser_type', 'browser_fill', 'browser_press_key', 'browser_scroll', 'browser_tabs'])
  for (const chat of chats) {
    const states = new Map(), legacyNodes = new Map(), originalRefs = new Map(), decodedRefs = new Map()
    const canonical = [], entries = []
    let nodeCounter = 100000, version = 0, currentTab
    const refsIn = (input) => {
      if (!input || typeof input !== 'object') return []
      return Object.entries(input).flatMap(([key, value]) => key === 'ref' && typeof value === 'string' ? [value] : refsIn(value))
    }
    for (const message of chat.messages ?? []) {
      if (!Array.isArray(message.content)) continue
      for (const part of message.content) {
        if (part.type === 'tool-call') {
          const tab = part.input?.tabId ?? currentTab
          for (const ref of refsIn(part.input)) {
            if (!originalRefs.get(tab)?.has(ref)) { all.originallyUnavailableRefs++; continue }
            assert(decodedRefs.get(tab)?.has(ref), `Lost actionable ref in ${chat.id}`)
            all.checkedActionRefs++
          }
          continue
        }
        if (part.type !== 'tool-result' || !tools.has(part.toolName) || part.output?.type !== 'text') continue
        const value = part.output.value
        const header = /^URL (.+?) \| title .*? \| tab (\d+)\n/m.exec(value)
        if (!header) continue
        let start = header.index + header[0].length
        while (start < value.length) {
          const end = value.indexOf('\n', start)
          const line = value.slice(start, end < 0 ? value.length : end)
          if (line !== 'Tabs:' && !/^ +tab \d+/.test(line) && line !== '') break
          start = end < 0 ? value.length : end + 1
        }
        if (/\[(?:Truncated|trimmed)|\[snapshot of tab/.test(value)) { all.skippedPartial++; continue }
        const rawLines = value.slice(start).split('\n')
        if (rawLines.some((line) => line && !/^(?: *\[e\d+\] | *[A-Za-z])/.test(line))) continue
        const tabId = Number(header[2]), document = 'backtest0000'
        const occurrences = new Map()
        const originalById = new Map()
        const lines = rawLines.filter(Boolean).map((line) => {
          const match = /^( *)(?:\[(e\d+)\] )?(.*)$/.exec(line)
          const [, indent, ref, text] = match
          const key = `${tabId}:${line}`
          const occurrence = (occurrences.get(key) ?? 0) + 1
          occurrences.set(key, occurrence)
          const identity = `${key}:${occurrence}`
          if (!legacyNodes.has(identity)) legacyNodes.set(identity, ++nodeCounter)
          const id = ref ? `e${document}-${ref.slice(1)}` : `n${document}-${legacyNodes.get(identity)}`
          originalById.set(id, ref)
          return `${indent}[${id}] ${text}`
        })
        const observation = { tabId, document, revision: ++version, header: value.slice(header.index, start).trimEnd(), lines }
        const text = value.slice(0, header.index) + lib.renderBrowserSnapshot(observation)
        const toolMessage = { role: 'tool', content: [{ ...part, output: { type: 'text', value: text } }] }
        // A URL change is a conservative full reset; historical logs do not
        // identify same-document navigation versus a replacement document.
        const old = states.get(tabId)
        if (old && old.url !== header[1]) canonical.push({ role: 'user', content: '', providerOptions: { compaction: { checkpoint: {} } } })
        canonical.push(toolMessage)
        const sent = lib.compressBrowserSnapshots(canonical).at(-1).content[0].output.value
        const full = lib.parseBrowserSnapshot(sent)
        const delta = lib.parseBrowserSnapshotDelta(sent)
        const reconstructed = full?.snapshot ?? lib.applyBrowserSnapshotDelta(old.snapshot, delta)
        assert.deepEqual(reconstructed, observation, `Reconstruction mismatch in ${chat.id}, observation ${version}`)
        const recorded = new Set(rawLines.flatMap((line) => [...line.matchAll(/^ *\[(e\d+)\]/g)].map((m) => m[1])))
        const restored = new Set(reconstructed.lines.map((line) => originalById.get(lib.snapshotNodeId(line))).filter(Boolean))
        assert.deepEqual(restored, recorded, `Reference availability changed in ${chat.id}`)
        originalRefs.set(tabId, recorded); decodedRefs.set(tabId, restored); currentTab = tabId
        states.set(tabId, { url: header[1], snapshot: reconstructed })
        entries.push({ delta: !!delta, original: value.length, encoded: sent.length })
      }
    }
    if (!entries.length) continue
    for (const tally of chat.modelId === 'qwen-3.8-27b' ? [all, qwen] : [all]) {
      tally.chats++; tally.observations += entries.length
      for (const entry of entries) {
        tally.deltas += Number(entry.delta); tally.originalCharacters += entry.original; tally.encodedCharacters += entry.encoded
      }
    }
  }
  const report = (stats) => ({ ...stats, textReductionPercent: +(100 * (1 - stats.encodedCharacters / stats.originalCharacters)).toFixed(1) })
  console.log(JSON.stringify({ all: report(all), qwen: report(qwen), note: 'Exact reconstruction of complete exported text observations; no model reruns or claims of identical task success. Partial snapshots excluded. Legacy identity adaptation described in script.' }, null, 2))
} finally { await rm(temp, { recursive: true, force: true }) }
