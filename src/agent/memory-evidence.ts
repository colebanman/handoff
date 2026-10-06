/** Normalize saved experience without replaying tools or learning from injected context. */
import type { ChatRecord, TranscriptItem } from '../shared/types'
import { isRuntimeContextText } from '../shared/context-blocks'
import { redactSecrets } from '../shared/redact'
import { memoryHash, type MemoryEvent, type MemorySource } from '../shared/continuity'
import { toolResultError } from '../shared/tool-results'

const SECRET_FIELD = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|access_?token|refresh_?token|id_?token|(?:x-)?api[_-]?key|client_secret)$/i
const MEDIA_FIELD = /^(?:base64|image|image_url|encrypted_content|redactedData|signature)$/i
const CHUNK_CHARS = 12_000

export function memoryEvidenceText(value: unknown): string {
  const seen = new WeakSet<object>()
  const clean = (v: unknown, key = '', depth = 0): unknown => {
    if (SECRET_FIELD.test(key)) return '[credential omitted]'
    if (MEDIA_FIELD.test(key)) return '[media/private state omitted]'
    if (typeof v === 'string') {
      if ((key === 'data' && v.length > 2048 && /^[A-Za-z0-9+/=\s]+$/.test(v)) || v.startsWith('data:image/')) return '[media omitted]'
      return redactSecrets(v)
        .replace(/^(?:Authorization|Cookie|Set-Cookie):.*$/gim, '[credential header omitted]')
        .replace(/((?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s;]+)/gi, '$1"[credential omitted]"')
        .replace(/https?:\/\/[^\s"'<>\\]+/g, (raw) => {
          try {
            const url = new URL(raw); url.username = ''; url.password = ''
            for (const key of [...url.searchParams.keys()]) if (/^(?:token|access_token|refresh_token|key|api_key|signature|sig|session|sid|code|x-amz-.*)$/i.test(key)) url.searchParams.delete(key)
            if (/(?:access_token|id_token|code)=/i.test(url.hash)) url.hash = ''
            return url.href
          } catch { return raw }
        })
    }
    if (!v || typeof v !== 'object') return v
    if (seen.has(v) || depth > 30) return '[nested value omitted]'
    seen.add(v)
    if (Array.isArray(v)) {
      if (v.length === 2 && typeof v[0] === 'string' && SECRET_FIELD.test(v[0])) return [v[0], '[credential omitted]']
      return v.map((item) => clean(item, '', depth + 1))
    }
    return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, clean(item, k, depth + 1)]))
  }
  const result = clean(value)
  return typeof result === 'string' ? result : JSON.stringify(result) ?? ''
}

interface EvidenceUnit { parentId: string; text: string; quote?: string; source: Omit<MemorySource, 'id' | 'excerpt'> }

export function memoryParent(chatId: string, item: TranscriptItem): string {
  if (item.kind === 'user') return `${chatId}:${item.id}`
  if (item.kind === 'tool') return `${chatId}:${item.executionId ?? `${item.agentId}:${item.at}`}:${item.id}`
  return `${chatId}:${'agentId' in item ? item.agentId : 'main'}:${item.id}`
}

function* transcriptUnits(items: TranscriptItem[], chat: ChatRecord, delegated = false, initialAt = chat.createdAt): Generator<EvidenceUnit> {
  let latestAt = initialAt
  for (const item of items) {
    const exact = 'at' in item && typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : undefined
    const common = { chatId: chat.id, itemId: item.id, at: exact ?? latestAt, timeBasis: exact !== undefined ? 'event' as const : latestAt === chat.createdAt ? 'chat' as const : 'turn' as const }
    const parentId = memoryParent(chat.id, item)
    if (exact !== undefined) latestAt = exact
    if (item.kind === 'user' && !item.pending && item.text.trim() && !isRuntimeContextText(item.text)) {
      const origin = item.source?.kind ?? (delegated || chat.origin ? 'unknown' : 'human')
      yield { parentId, source: { ...common, origin, label: chat.title },
        text: memoryEvidenceText({ text: item.text, attachments: item.attachments, contexts: item.contexts }), quote: memoryEvidenceText(item.text).slice(0, 700) }
    } else if (item.kind === 'text' && !item.streaming && item.text.trim()) {
      yield { parentId, source: { ...common, origin: 'assistant', label: `${chat.title} — ${item.agentId}` }, text: memoryEvidenceText(item.text) }
    } else if (item.kind === 'tool') {
      // Running requests aren't outcomes. Explicit memory writes are legacy assertions, not independent confirmation.
      if (item.status !== 'running' && item.output !== undefined && item.toolName !== 'memory_write') {
        const outcome = item.status === 'error' || toolResultError(item.output) ? 'failure' : 'success'
        const spill = typeof item.output === 'string' ? /full \d+-char output saved to (\/workspace\/\.tool-output\/[^\s)]+)/.exec(item.output)?.[1] : undefined
        const savedContext = /\/workspace\/(?:MEMORY\.md|SITES\.md|sites\/)|api\.extensions\.(?:get|list)\s*\(/.test(memoryEvidenceText(item.input ?? item.inputText))
        yield { parentId, source: { ...common, at: item.endedAt ?? common.at, origin: 'tool', outcome, label: item.toolName, harnessVersion: item.harnessVersion, ...(savedContext ? { savedContext: true } : {}) },
          text: memoryEvidenceText({ tool: item.toolName, request: item.input ?? item.inputText, outcome, result: item.output, ...(spill ? { fullOutputPath: spill, note: 'The full spill and this excerpt are one observation, not independent evidence.' } : {}) }) }
      }
      if (item.childItems) yield* transcriptUnits(item.childItems, chat, true, common.at)
      for (const agent of item.workflow?.agents ?? []) if (agent.items) yield* transcriptUnits(agent.items, chat, true, common.at)
    }
  }
}

/** Older harnesses may lack UI items. Model roles alone never establish human authorship. */
function* legacyUnits(chat: ChatRecord): Generator<EvidenceUnit> {
  for (let index = 0; index < chat.messages.length; index++) {
    const message = chat.messages[index] as { role?: string; content?: unknown; providerOptions?: { compaction?: unknown } } | undefined
    if (!message || message.providerOptions?.compaction) continue
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : []
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex] as Record<string, unknown>
      if (!['text', 'tool-result'].includes(String(part.type))) continue
      const text = memoryEvidenceText(part.type === 'text' ? part.text : part.output ?? part.result)
      if (!text.trim() || isRuntimeContextText(text) || text.includes('<context source="harness">')) continue
      const itemId = String(part.toolCallId ?? `legacy-${index}-${partIndex}`)
      yield { parentId: `${chat.id}:${itemId}`, text, source: { chatId: chat.id, itemId, at: chat.createdAt, timeBasis: 'chat',
        origin: message.role === 'tool' ? 'tool' : message.role === 'assistant' ? 'assistant' : 'unknown', label: String(part.toolName ?? chat.title), outcome: 'unknown' } }
    }
  }
}

/** Completed units are immutable. Hashes also handle amended legacy items without duplicate backfill. */
export async function extractMemoryEvents(chat: ChatRecord, known: ReadonlySet<string> = new Set()): Promise<MemoryEvent[]> {
  const result: MemoryEvent[] = []
  const units = chat.transcript.length ? transcriptUnits(chat.transcript, chat) : legacyUnits(chat)
  for (const unit of units) {
    // Content can change after a rewind/edit. Human units are cheap enough to hash again;
    // completed assistant/tool ids are immutable in the harness.
    if (unit.source.origin !== 'human' && known.has(unit.parentId)) continue
    const fingerprint = await memoryHash(unit.text)
    const identity = `${unit.parentId}:${fingerprint}`
    if (known.has(identity)) continue
    for (let offset = 0, chunk = 0; offset < unit.text.length; chunk++) {
      let end = Math.min(offset + CHUNK_CHARS, unit.text.length)
      if (end < unit.text.length && /[\uD800-\uDBFF]/.test(unit.text[end - 1]!)) end--
      const text = unit.text.slice(offset, end)
      result.push({ ...unit.source, id: `${identity}:${chunk}`, parentId: unit.parentId, text,
        label: unit.source.label.slice(0, 180) + (unit.text.length > CHUNK_CHARS ? ` (part ${chunk + 1})` : ''), excerpt: chunk === 0 ? unit.quote ?? text.slice(0, 700) : text.slice(0, 700), pending: 1 })
      offset = end
    }
  }
  return result
}

export function eventSource(event: MemoryEvent): MemorySource {
  const { text: _text, pending: _pending, parentId: _parent, detached: _detached, ...source } = event
  return source
}
