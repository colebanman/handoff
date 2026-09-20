import type { ModelMessage } from 'ai'
import { isCompactionCheckpoint } from '../shared/compaction'
import {
  applyBrowserSnapshotDelta, diffBrowserSnapshot, parseBrowserSnapshot, parseBrowserSnapshotDelta,
  renderBrowserSnapshot, renderBrowserSnapshotDelta, type BrowserSnapshot,
} from '../shared/browser-snapshot'

const SNAPSHOT_TOOLS = new Set(['browser_snapshot', 'browser_click', 'browser_navigate', 'browser_type',
  'browser_fill', 'browser_press_key', 'browser_scroll', 'browser_tabs'])

/** Derive baselines from THIS request after pruning/compaction. Other agents,
 * discarded results, retries and rewinds cannot advance them. Stored messages
 * stay full fidelity; earlier patches stay byte-stable as history grows. */
export function compressBrowserSnapshots(messages: ModelMessage[]): ModelMessage[] {
  const baselines = new Map<number, { snapshot: BrowserSnapshot; chain: number }>()
  const forced = new Set<string>()
  let changed = false
  const result = messages.map((message) => {
    if (isCompactionCheckpoint(message)) baselines.clear()
    if (message.role === 'user') {
      // TabShot/context-menu attachments can already contain the initial full
      // observation. It is just as usable as a delivered tool baseline.
      const texts = typeof message.content === 'string' ? [message.content] :
        message.content.flatMap((part) => part.type === 'text' ? [part.text] : [])
      for (let text of texts) {
        let parsed
        while ((parsed = parseBrowserSnapshot(text))) {
          baselines.set(parsed.snapshot.tabId, { snapshot: parsed.snapshot, chain: 0 })
          text = parsed.after
        }
      }
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'tool-call' && part.toolName === 'browser_snapshot' &&
          (part.input as { full?: boolean } | undefined)?.full === true) forced.add(part.toolCallId)
      }
    }
    if (message.role !== 'tool') return message
    let edited = false
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result' || !SNAPSHOT_TOOLS.has(part.toolName) || part.output.type !== 'text') return part
      const text = part.output.value
      const parsed = parseBrowserSnapshot(text)
      if (!parsed) {
        const delta = parseBrowserSnapshotDelta(text)
        const base = delta && baselines.get(delta.tabId)
        if (delta && base) {
          try { baselines.set(delta.tabId, { snapshot: applyBrowserSnapshotDelta(base.snapshot, delta), chain: base.chain + 1 }) }
          catch { baselines.delete(delta.tabId) }
        } else {
          const tab = /Browser (?:snapshot|changes) v1 tab=(\d+)/.exec(text)
          if (tab) baselines.delete(Number(tab[1]))
        }
        return part
      }
      const { snapshot } = parsed
      const previous = baselines.get(snapshot.tabId)
      baselines.set(snapshot.tabId, { snapshot, chain: 0 })
      if (!previous || previous.snapshot.document !== snapshot.document || previous.snapshot.revision >= snapshot.revision ||
        previous.chain >= 12 || forced.has(part.toolCallId)) return part
      try {
        const encoded = renderBrowserSnapshotDelta(diffBrowserSnapshot(previous.snapshot, snapshot))
        const full = renderBrowserSnapshot(snapshot)
        if (encoded.length > full.length * 0.8 || full.length - encoded.length < 80) return part
        // Verify the actual serialized model-facing patch before using it.
        const decoded = parseBrowserSnapshotDelta(encoded)
        if (!decoded || renderBrowserSnapshot(applyBrowserSnapshotDelta(previous.snapshot, decoded)) !== full) return part
        baselines.set(snapshot.tabId, { snapshot, chain: previous.chain + 1 })
        edited = changed = true
        return { ...part, output: { ...part.output, value: parsed.before + encoded + parsed.after } }
      } catch {
        return part // An unusable patch must never prevent a complete observation.
      }
    })
    return edited ? { ...message, content } : message
  })
  return changed ? result : messages
}

/** Exact page state to retain across provider-owned compaction. */
export function latestBrowserSnapshotContext(messages: ModelMessage[]): string | undefined {
  const latest = new Map<number, string>()
  for (const message of messages) {
    if (message.role === 'user') {
      const texts = typeof message.content === 'string' ? [message.content] :
        message.content.flatMap((part) => part.type === 'text' ? [part.text] : [])
      for (let text of texts) {
        let parsed
        while ((parsed = parseBrowserSnapshot(text))) {
          latest.set(parsed.snapshot.tabId, renderBrowserSnapshot(parsed.snapshot))
          text = parsed.after
        }
      }
    }
    if (message.role !== 'tool') continue
    for (const part of message.content) {
      if (part.type !== 'tool-result' || !SNAPSHOT_TOOLS.has(part.toolName) || part.output.type !== 'text') continue
      const parsed = parseBrowserSnapshot(part.output.value)
      if (parsed) latest.set(parsed.snapshot.tabId, renderBrowserSnapshot(parsed.snapshot))
      else {
        const tab = /Browser snapshot v1 tab=(\d+)/.exec(part.output.value)
        if (tab) latest.delete(Number(tab[1]))
      }
    }
  }
  return latest.size ? `<browser-observations>\nLatest observed page states restored after compaction; not a fresh observation.\n${[...latest.values()].join('\n\n')}\n</browser-observations>` : undefined
}
