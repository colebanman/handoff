import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { compressBrowserSnapshots, latestBrowserSnapshotContext } from './browser-snapshot-context'
import { pruneReplayedHistory } from './history-pruning'
import { applyBrowserSnapshotDelta, parseBrowserSnapshot, parseBrowserSnapshotDelta, renderBrowserSnapshot, type BrowserSnapshot } from '../shared/browser-snapshot'

const snapshot = (revision: number, tabId = 7, document = 'abc'): BrowserSnapshot => ({
  tabId, document, revision, header: `URL https://example.test | title Page | tab ${tabId}`,
  lines: Array.from({ length: 60 }, (_, i) => `[e${document}-${i + 1}] textbox "Field ${i}" value="${i === 2 ? revision : ''}"`),
})
const tool = (s: BrowserSnapshot, value = renderBrowserSnapshot(s)): ModelMessage => ({ role: 'tool', content: [
  { type: 'tool-result', toolName: 'browser_snapshot', toolCallId: `call-${s.revision}`, output: { type: 'text', value } },
] })
const text = (m: ModelMessage) => (m as { content: Array<{ output: { value: string } }> }).content[0]!.output.value

describe('browser observations in provider requests', () => {
  it('sends a full baseline plus exact deltas while preserving canonical messages and cached prefixes', () => {
    const history = [tool(snapshot(1)), tool(snapshot(2))]
    const saved = JSON.stringify(history)
    const first = compressBrowserSnapshots(history)
    expect(parseBrowserSnapshot(text(first[0]!))).toBeDefined()
    const delta = parseBrowserSnapshotDelta(text(first[1]!))!
    expect(applyBrowserSnapshotDelta(snapshot(1), delta)).toEqual(snapshot(2))
    expect(JSON.stringify(history)).toBe(saved)
    const grown = compressBrowserSnapshots([...history, tool(snapshot(3))])
    expect(grown.slice(0, 2)).toEqual(first)
    expect(compressBrowserSnapshots(grown)).toEqual(grown)
  })

  it('has independent tab/agent baselines and restores a full tree after pruning or missing history', () => {
    const a = tool(snapshot(1)), b = tool(snapshot(2))
    expect(compressBrowserSnapshots([b])[0]).toBe(b)
    const interleaved = compressBrowserSnapshots([a, tool(snapshot(1, 8)), b])
    expect(parseBrowserSnapshot(text(interleaved[1]!))).toBeDefined()
    expect(parseBrowserSnapshotDelta(text(interleaved[2]!))).toBeDefined()
    const pruned = pruneReplayedHistory([a, b]).messages
    expect(parseBrowserSnapshot(text(compressBrowserSnapshots(pruned)[1]!))).toBeDefined()
  })

  it('uses a complete attached TabShot as a baseline', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: `Fill this form.\n${renderBrowserSnapshot(snapshot(1))}` }, tool(snapshot(2))]
    expect(parseBrowserSnapshotDelta(text(compressBrowserSnapshots(messages)[1]!))?.from).toBe(1)
    expect(latestBrowserSnapshotContext(messages.slice(0, 1))).toContain('revision=1')
  })

  it('falls back for navigation, partial capture, broad changes, and explicit full requests', () => {
    const a = tool(snapshot(1))
    const partial = tool(snapshot(2), renderBrowserSnapshot(snapshot(2)).slice(0, -20))
    for (const history of [
      [a, tool(snapshot(2, 7, 'newdoc'))],
      [a, partial, tool(snapshot(3))],
      [a, tool({ ...snapshot(2), lines: snapshot(2).lines.map((line) => line + ' changed') })],
      [a, { role: 'assistant', content: [{ type: 'tool-call', toolName: 'browser_snapshot', toolCallId: 'call-2', input: { full: true } }] } as ModelMessage, tool(snapshot(2))],
      [a, { role: 'user', content: '', providerOptions: { compaction: { checkpoint: {} } } } as ModelMessage, tool(snapshot(2))],
    ]) expect(parseBrowserSnapshot(text(compressBrowserSnapshots(history).at(-1)!))).toBeDefined()
  })

  it('periodically supplies a full tree without making earlier deltas orphaned', () => {
    const transformed = compressBrowserSnapshots(Array.from({ length: 20 }, (_, i) => tool(snapshot(i + 1))))
    let current: BrowserSnapshot | undefined
    for (const m of transformed) {
      const full = parseBrowserSnapshot(text(m))
      current = full?.snapshot ?? applyBrowserSnapshotDelta(current!, parseBrowserSnapshotDelta(text(m))!)
    }
    expect(current).toEqual(snapshot(20))
    expect(parseBrowserSnapshot(text(transformed[13]!))).toBeDefined()
  })

  it('preserves action receipts and navigation metadata, and fixes legacy prefixed-snapshot pruning', () => {
    const navigation = '<navigation_context>Recent login redirect</navigation_context>\n\n'
    const history = [tool(snapshot(1), navigation + renderBrowserSnapshot(snapshot(1))), tool(snapshot(2), 'Clicked button.\n\n' + renderBrowserSnapshot(snapshot(2)))]
    const compressed = compressBrowserSnapshots(history)
    expect(text(compressed[0]!)).toContain(navigation)
    expect(text(compressed[1]!)).toContain('Clicked button.')
    const legacy = [tool(snapshot(1), navigation + 'Tab 7: Page\n' + 'old content '.repeat(100)), tool(snapshot(2), 'Tab 7: Page\n' + 'new content '.repeat(100))]
    expect(pruneReplayedHistory(legacy).stubbedSnapshots).toBe(1)
    expect(latestBrowserSnapshotContext(history)).toContain('revision=2')
    expect(latestBrowserSnapshotContext(history)).not.toContain('revision=1')
  })
})
