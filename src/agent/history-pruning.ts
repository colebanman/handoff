/**
 * Request-time pruning of replayed conversation history.
 *
 * The harness declares snapshot refs valid only for the MOST RECENT snapshot
 * of a tab (see the browser_snapshot description and withFreshSnapshot in
 * tools.ts), yet every superseded ~15k-char snapshot was being replayed to the
 * provider on every request for the life of the chat. This module rewrites
 * request-time copies of the replayed history:
 *
 *   (a) per tab, every snapshot-bearing tool result EXCEPT the newest is
 *       reduced to a one-line stub (interaction results keep their action
 *       message, e.g. "Clicked e12 in tab 5.", and lose only the appended
 *       snapshot),
 *   (b) any other text tool output over STALE_MAX_CHARS with at least
 *       STALE_AFTER_ASSISTANT_MESSAGES assistant messages after it is trimmed
 *       to head + "[trimmed, was N chars]" + tail.
 *   (c) embedded image/file bytes from the current user turn and its immediate
 *       follow-up stay native. Older media is retained newest-first under a
 *       bounded replay budget, then replaced with small text stubs. The files
 *       remain in the VFS and can be viewed natively again when needed.
 *
 * Default (unbudgeted) cache stability contract (Anthropic breakpoints,
 * OpenAI/xAI automatic prefix caching — rely on it):
 *   - Deterministic: output bytes are a pure function of the input messages.
 *   - Monotone: supersession and staleness only ever switch OFF→ON as history
 *     grows, and the rewritten text depends only on the original persisted
 *     value, so each message's pruned form changes at most once and is then
 *     byte-identical on every later turn.
 *   - Count-preserving: messages are rewritten in place, never inserted or
 *     removed, so breakpoint indexes and responseMessages slice math hold.
 *   - Idempotent: stubs don't parse as snapshots and trimmed values are under
 *     the size threshold, so re-pruning pruned history is a no-op.
 *
 * Called once per runLoop entry on the sanitized replayed history — never in
 * prepareStep (mid-turn pruning would rewrite the current turn's own steps
 * between requests and break incremental caching), and never on the persisted
 * ChatRecord (full fidelity stays in storage).
 */

import type { ModelMessage } from 'ai'
import { isRuntimeContextMessage } from '../shared/context-blocks'
import { sliceWellFormed } from '../shared/text'
import { parseBrowserSnapshot } from '../shared/browser-snapshot'

/** Marker withFreshSnapshot (tools.ts) puts between the action message and the
 * appended snapshot. MUST stay in sync with tools.ts by content. */
const FRESH_SNAPSHOT_MARKER = '\n\nFresh snapshot (replaces all previous refs for this tab):\n'

/** Tools whose text results can carry a snapshot of a tab. */
const SNAPSHOT_TOOLS = new Set([
  'browser_snapshot',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_fill',
  'browser_press_key',
  'browser_scroll',
  'browser_tabs',
])

const STALE_MAX_CHARS = 4_000
const STALE_AFTER_ASSISTANT_MESSAGES = 6
const STALE_HEAD_CHARS = 1_500
const STALE_TAIL_CHARS = 500

/**
 * Base64 chars, not decoded bytes. Current-turn media and its immediate
 * follow-up are exempt; this budget applies only once that native-media window
 * has passed. 1.5M chars is roughly 1.1 MB of binary data.
 */
export const REPLAY_MEDIA_BUDGET_CHARS = 1_500_000
const NATIVE_MEDIA_USER_TURNS = 1

/**
 * Optional ceiling on the combined size of the snapshots rule (a) keeps.
 *
 * Rule (a) preserves one full snapshot per TAB and is otherwise unbounded,
 * which is the right trade against a frontier context window. But the
 * invariant is per tab, so an agent working across many tabs — or fanning out
 * parallel browser_snapshot calls, one per tab, which land in a single step and
 * are each "newest" for their own tab — accumulates full-size snapshots without
 * limit. Against a 32K server that overflows the window and the whole request
 * is rejected, which reads as an opaque 400 rather than as context pressure.
 *
 * When set, kept snapshots are retained newest-first until the budget is spent;
 * the rest are dropped to a stub naming the tab to re-snapshot. Leaving it
 * unset preserves the previous unbounded behaviour byte for byte.
 */
export interface PruneOptions {
  snapshotBudgetChars?: number
}

export interface PrunedHistory {
  messages: ModelMessage[]
  stubbedSnapshots: number
  trimmedOutputs: number
  /** Snapshots dropped by `snapshotBudgetChars` (a subset of stubbedSnapshots). */
  droppedForBudget: number
  prunedMedia: number
  mediaCharsSaved: number
  charsSaved: number
}

interface SnapshotInfo {
  tabId: number
  /** Offset where the appended snapshot begins; 0 = the whole value is a snapshot. */
  markerIndex: number
}

/** Parse "which tab does this tool result carry a snapshot of", or undefined. */
function snapshotInfo(toolName: string, value: string): SnapshotInfo | undefined {
  if (!SNAPSHOT_TOOLS.has(toolName)) return undefined
  const structured = parseBrowserSnapshot(value)
  if (structured) return { tabId: structured.snapshot.tabId, markerIndex: structured.before.length }
  if (toolName === 'browser_snapshot') {
    const m = /^(?:<navigation_context>[\s\S]*?<\/navigation_context>\s*)?Tab (\d+):/.exec(value)
    return m ? { tabId: Number(m[1]), markerIndex: 0 } : undefined
  }
  const marker = value.includes('\n\nFresh browser observation:\n') ? '\n\nFresh browser observation:\n' : FRESH_SNAPSHOT_MARKER
  const at = value.indexOf(marker)
  if (at < 0) return undefined
  const m = /^Tab (\d+):/.exec(value.slice(at + marker.length))
  return m ? { tabId: Number(m[1]), markerIndex: at } : undefined
}

function snapshotStub(tabId: number): string {
  return `[snapshot of tab ${tabId} superseded — see later snapshot]`
}

/**
 * Stub for a snapshot that is still current for its tab but did not fit the
 * replay budget. Unlike a superseded snapshot there IS no later copy to read,
 * so this one has to say how to get the content back.
 */
function budgetStub(tabId: number): string {
  return (
    `[snapshot of tab ${tabId} omitted from replay to fit the context window — ` +
    `call browser_snapshot on tab ${tabId} if you still need it]`
  )
}

/** Last `length` chars of `text`, never starting on the low half of a surrogate pair. */
function tailWellFormed(text: string, length: number): string {
  const out = text.slice(Math.max(0, text.length - length))
  const first = out.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? out.slice(1) : out
}

/** A tool-result part with a plain-string output we can rewrite. */
interface TextToolResultPart {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: { type: string; value: unknown }
}

function isTextToolResult(part: unknown): part is TextToolResultPart & { output: { value: string } } {
  if (typeof part !== 'object' || part === null) return false
  const p = part as TextToolResultPart
  return (
    p.type === 'tool-result' &&
    typeof p.toolName === 'string' &&
    typeof p.output === 'object' &&
    p.output !== null &&
    (p.output.type === 'text' || p.output.type === 'error-text') &&
    typeof p.output.value === 'string'
  )
}

interface ContentToolResultPart {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: {
    type: 'content'
    value: Array<{ type: 'text'; text: string } | { type: 'media'; data: string; mediaType: string }>
  }
}

type ToolMediaItem = Extract<ContentToolResultPart['output']['value'][number], { type: 'media' }>

function isToolMediaItem(item: ContentToolResultPart['output']['value'][number]): item is ToolMediaItem {
  return item.type === 'media'
}

function isContentToolResult(part: unknown): part is ContentToolResultPart {
  if (typeof part !== 'object' || part === null) return false
  const p = part as ContentToolResultPart
  return (
    p.type === 'tool-result' &&
    typeof p.toolName === 'string' &&
    typeof p.output === 'object' &&
    p.output !== null &&
    p.output.type === 'content' &&
    Array.isArray(p.output.value)
  )
}

interface UserMediaPart {
  type: 'image' | 'file'
  image?: unknown
  data?: unknown
  mediaType?: string
  filename?: string
}

function isUserMediaPart(part: unknown): part is UserMediaPart {
  if (typeof part !== 'object' || part === null) return false
  const p = part as UserMediaPart
  return (p.type === 'image' && p.image !== undefined) || (p.type === 'file' && p.data !== undefined)
}

function embeddedDataChars(data: unknown): number {
  if (typeof data === 'string') {
    // Remote URLs add only a few request bytes and remain useful on old turns;
    // the pathological case is inline base64/data URLs.
    if (/^(?:https?|blob):/i.test(data)) return 0
    return data.length
  }
  if (data instanceof URL) return 0
  if (data instanceof ArrayBuffer) return Math.ceil(data.byteLength / 3) * 4
  if (ArrayBuffer.isView(data)) return Math.ceil(data.byteLength / 3) * 4
  return 0
}

function mediaPayloadChars(part: unknown): number {
  if (isUserMediaPart(part)) return embeddedDataChars(part.type === 'image' ? part.image : part.data)
  if (typeof part === 'object' && part !== null) {
    const media = part as { type?: unknown; data?: unknown }
    if (media.type === 'media') return embeddedDataChars(media.data)
  }
  return 0
}

function mediaCandidates(message: ModelMessage): unknown[] {
  if ((message.role === 'user' || message.role === 'assistant') && Array.isArray(message.content)) {
    return message.content.filter(isUserMediaPart)
  }
  if (message.role !== 'tool' || !Array.isArray(message.content)) return []
  return message.content.flatMap((part) =>
    isContentToolResult(part) ? part.output.value.filter(isToolMediaItem) : [],
  )
}

function userMediaStub(part: UserMediaPart): { type: 'text'; text: string } {
  const label = part.mediaType?.startsWith('image/') || part.type === 'image' ? 'image' : 'file'
  const named = part.filename ? ` ${JSON.stringify(part.filename)}` : ''
  return {
    type: 'text',
    text:
      `[Earlier attached ${label}${named} omitted from replay to keep this long chat responsive. ` +
      'The original workspace file is unchanged; use filesystem_view to load it natively again if needed.]',
  }
}

function toolMediaStub(mediaTypes: string[]): { type: 'text'; text: string } {
  const labels = [...new Set(mediaTypes.map((type) => (type.startsWith('image/') ? 'image' : type)))]
  return {
    type: 'text',
    text:
      `[Earlier native ${labels.join('/')} output omitted from replay to keep this long chat responsive. ` +
      'Call the tool again to load the original media natively if it is needed.]',
  }
}

/**
 * Rewrite superseded snapshots and stale oversized outputs in a replayed
 * history. Returns the same array reference when nothing changed.
 */
export function pruneReplayedHistory(
  messages: ModelMessage[],
  options: PruneOptions = {},
): PrunedHistory {
  // Pass 1 (back to front): the first snapshot seen per tab is the newest —
  // keep it; remember parse results for every snapshot-bearing part.
  const snapInfo = new Map<unknown, SnapshotInfo>()
  const keepParts = new Set<unknown>()
  const seenTabs = new Set<number>()
  // Newest-first, so the budget pass below can spend in the same order.
  const keptOrder: unknown[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== 'tool' || !Array.isArray(message.content)) continue
    for (let p = message.content.length - 1; p >= 0; p--) {
      const part = message.content[p]
      if (!isTextToolResult(part) || part.output.type !== 'text') continue
      const info = snapshotInfo(part.toolName, part.output.value)
      if (!info) continue
      snapInfo.set(part, info)
      if (!seenTabs.has(info.tabId)) {
        seenTabs.add(info.tabId)
        keepParts.add(part)
        keptOrder.push(part)
      }
    }
  }

  // Pass 1b: spend the snapshot budget newest-first over the kept set. Evicted
  // parts leave `keepParts` and take the budget stub in the rewrite below.
  //
  // Budgeted replay can change earlier decisions when a newer snapshot for a
  // tab is smaller than its predecessor. Local servers validate exact token
  // prefixes before cache reuse; hosted paths leave this budget unset.
  const budgetEvicted = new Set<unknown>()
  const budget = options.snapshotBudgetChars
  if (budget !== undefined && budget >= 0) {
    let spent = 0
    for (const part of keptOrder) {
      const info = snapInfo.get(part)!
      const p = part as TextToolResultPart & { output: { value: string } }
      // Only the appended snapshot counts; a leading action message ("Clicked
      // e12 in tab 5.") is tiny and is preserved either way.
      const snapshotChars = p.output.value.length - info.markerIndex
      if (spent + snapshotChars > budget) {
        keepParts.delete(part)
        budgetEvicted.add(part)
        continue
      }
      spent += snapshotChars
    }
  }

  // Age = number of assistant messages strictly after each index (≈ completed
  // steps since the result). Monotone: only grows as history grows.
  const assistantAfter = new Array<number>(messages.length)
  let assistants = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    assistantAfter[i] = assistants
    if (messages[i]?.role === 'assistant') assistants += 1
  }

  // Media relevance follows USER turns rather than assistant messages. One
  // agent turn can contain many assistant tool-call steps; counting those would
  // incorrectly discard an image before the user's very first follow-up.
  const userAfter = new Array<number>(messages.length)
  let users = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    userAfter[i] = users
    const message = messages[i]
    if (message?.role === 'user' && !isRuntimeContextMessage(message)) users += 1
  }

  // Decide from newest to oldest so the replayed-media prefix is contiguous.
  // Protected recent media always stays native but still consumes the budget
  // for anything older; this keeps decisions monotone as a chat grows.
  const pruneMediaParts = new Set<unknown>()
  let replayMediaChars = 0
  let mediaCutoff = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const recent = (userAfter[i] ?? 0) <= NATIVE_MEDIA_USER_TURNS
    const candidates = mediaCandidates(messages[i]!)
    for (let p = candidates.length - 1; p >= 0; p--) {
      const candidate = candidates[p]!
      const chars = mediaPayloadChars(candidate)
      if (chars <= 0) continue
      if (recent) {
        replayMediaChars += chars
        if (replayMediaChars >= REPLAY_MEDIA_BUDGET_CHARS) mediaCutoff = true
        continue
      }
      if (mediaCutoff || replayMediaChars + chars > REPLAY_MEDIA_BUDGET_CHARS) {
        pruneMediaParts.add(candidate)
        mediaCutoff = true
      } else {
        replayMediaChars += chars
      }
    }
  }

  let stubbedSnapshots = 0
  let trimmedOutputs = 0
  let droppedForBudget = 0
  let prunedMedia = 0
  let mediaCharsSaved = 0
  let charsSaved = 0
  let anyChanged = false

  const out = messages.map((message, i) => {
    if ((message.role === 'user' || message.role === 'assistant') && Array.isArray(message.content)) {
      let messageChanged = false
      const content = message.content.map((part) => {
        if (!isUserMediaPart(part) || !pruneMediaParts.has(part)) return part
        const stub = userMediaStub(part)
        const saved = Math.max(0, mediaPayloadChars(part) - stub.text.length)
        prunedMedia += 1
        mediaCharsSaved += saved
        charsSaved += saved
        messageChanged = true
        return stub
      })
      if (!messageChanged) return message
      anyChanged = true
      return { ...message, content } as ModelMessage
    }
    if (message.role !== 'tool' || !Array.isArray(message.content)) return message
    let messageChanged = false
    const content = message.content.map((part) => {
      if (isContentToolResult(part)) {
        const removed = part.output.value.filter((item): item is ToolMediaItem =>
          isToolMediaItem(item) && pruneMediaParts.has(item),
        )
        if (removed.length === 0) return part
        const mediaTypes = removed.map((item) => item.mediaType)
        const removedSet = new Set<unknown>(removed)
        const stub = toolMediaStub(mediaTypes)
        const saved = Math.max(
          0,
          removed.reduce((sum, item) => sum + mediaPayloadChars(item), 0) - stub.text.length,
        )
        prunedMedia += removed.length
        mediaCharsSaved += saved
        charsSaved += saved
        messageChanged = true
        return {
          ...part,
          output: {
            ...part.output,
            value: [...part.output.value.filter((item) => !removedSet.has(item)), stub],
          },
        } as typeof part
      }
      if (!isTextToolResult(part)) return part
      const value = part.output.value

      // (a) superseded snapshot → stub; the newest per tab stays fully intact
      // unless it was evicted by the snapshot budget, which gets its own stub
      // because no later copy of that tab exists to fall back on.
      const info = snapInfo.get(part)
      if (info) {
        const evicted = budgetEvicted.has(part)
        if (!evicted && keepParts.has(part)) return part
        const actionHead = info.markerIndex > 0 ? `${value.slice(0, info.markerIndex)}\n\n` : ''
        const next = actionHead + (evicted ? budgetStub(info.tabId) : snapshotStub(info.tabId))
        if (next.length >= value.length) return part
        stubbedSnapshots += 1
        if (evicted) droppedForBudget += 1
        charsSaved += value.length - next.length
        messageChanged = true
        return { ...part, output: { ...part.output, value: next } } as typeof part
      }

      // (b) oversized output, old enough that the model has moved on → trim.
      if (value.length > STALE_MAX_CHARS && (assistantAfter[i] ?? 0) >= STALE_AFTER_ASSISTANT_MESSAGES) {
        const next =
          sliceWellFormed(value, STALE_HEAD_CHARS) +
          `\n[trimmed, was ${value.length} chars]\n` +
          tailWellFormed(value, STALE_TAIL_CHARS)
        if (next.length >= value.length) return part
        trimmedOutputs += 1
        charsSaved += value.length - next.length
        messageChanged = true
        return { ...part, output: { ...part.output, value: next } } as typeof part
      }

      return part
    })
    if (!messageChanged) return message
    anyChanged = true
    return { ...message, content } as ModelMessage
  })

  return {
    messages: anyChanged ? out : messages,
    stubbedSnapshots,
    trimmedOutputs,
    droppedForBudget,
    prunedMedia,
    mediaCharsSaved,
    charsSaved,
  }
}
