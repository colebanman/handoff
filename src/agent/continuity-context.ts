/** Pure, in-process recall and delivery. No model, browser, storage, or network calls. */
import type { ModelMessage } from 'ai'
import {
  MEMORY_CONTEXT_MAX_TOKENS, memoryLife, subjectKey, type MemoryEvent, type MemoryRecord, type MemorySnapshot,
} from '../shared/continuity'
import { contextText, isRuntimeContextText, RUNTIME_CONTEXT_START } from '../shared/context-blocks'
import { latestCompactionBoundary } from '../shared/compaction'
import { matchesTask } from '../shared/extension-matching'
import { scopeMatches, scopeSpecificity } from './site-memory'
import { memoryTokens } from './memory-budget'
import { HARNESS_VERSION } from '../shared/harness-version'

export interface MemoryRuntime {
  snapshot(): MemorySnapshot | undefined
  recent(): readonly MemoryEvent[]
  captureSpill?(chatId: string, toolName: string, path: string, text: string): Promise<void>
  captureTool?(chatId: string, value: { id: string; executionId: string; agentId: string; toolName: string; input: unknown; output: unknown; failed: boolean }): Promise<void>
  write(input: { memories?: Array<{ title: string; body: string; scopes?: string[]; triggers?: string[]; guide?: string }>; forget?: string[]; clearAll?: boolean }, chatId?: string): Promise<string>
}
let runtime: MemoryRuntime | undefined
export function installMemoryRuntime(value: MemoryRuntime | undefined): void { runtime = value }
export function memoryRuntime(): MemoryRuntime | undefined { return runtime }

export interface MemoryQuery {
  task: string
  urls: string[]
  chatId?: string
  isSubagent?: boolean
  historical?: boolean
  now?: number
  deadline?: number
  guides?: Map<string, { updatedAt: number; size: number }>
}
const GENERIC = new Set(['email', 'mail', 'project', 'group', 'work', 'school', 'user', 'assignment', 'browser', 'website', 'page', 'tab', 'site', 'context', 'guide', 'file', 'data'])
const NOISE = new Set(['this', 'that', 'with', 'what', 'when', 'where', 'which', 'from', 'have', 'please', 'would', 'could', 'should', 'about', 'your', 'there', 'their', 'them', 'some', 'today', 'tonight', 'text'])
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu)?.filter((w) => !NOISE.has(w) && !GENERIC.has(w)) ?? []
interface RecallIndex { words: Map<string, Set<MemoryRecord>>; hosts: Map<string, Set<MemoryRecord>>; fallback: Set<MemoryRecord>; global: MemoryRecord[] }
const indexes = new WeakMap<readonly MemoryRecord[], RecallIndex>()
export function warmMemoryIndex(records: readonly MemoryRecord[]): RecallIndex {
  const cached = indexes.get(records)
  if (cached) return cached
  const index: RecallIndex = { words: new Map(), hosts: new Map(), fallback: new Set(), global: [] }
  const add = (map: Map<string, Set<MemoryRecord>>, key: string, record: MemoryRecord) => { if (!map.has(key)) map.set(key, new Set()); map.get(key)!.add(record) }
  for (const record of records) {
    if (record.global) index.global.push(record)
    for (const cue of [...record.triggers, ...record.entities, record.subject]) {
      const tokens = words(cue)
      if (!tokens.length && !GENERIC.has(cue.toLowerCase())) index.fallback.add(record)
      for (const token of tokens) add(index.words, token, record)
    }
    for (const scope of record.scopes) {
      const host = scope.split('/')[0]!
      if (host.includes('*')) index.fallback.add(record)
      else add(index.hosts, host, record)
    }
  }
  indexes.set(records, index)
  return index
}
export function selectMemories(records: readonly MemoryRecord[], query: MemoryQuery): MemoryRecord[] {
  const now = query.now ?? Date.now()
  const retrospective = query.historical ?? /\b(previous|previously|last (?:trip|project|semester|assignment)|used to|back in|historical|history of|in the past|compare|compared|than assignment)\b/i.test(query.task)
  const index = warmMemoryIndex(records)
  const candidates = new Set<MemoryRecord>()
  for (const word of words(query.task)) for (const record of index.words.get(word) ?? []) candidates.add(record)
  for (const raw of query.urls) {
    try { for (const record of index.hosts.get(new URL(raw).hostname.toLowerCase().replace(/^www\./, '')) ?? []) candidates.add(record) } catch { /* Invalid URLs grant no scope. */ }
  }
  for (const record of [...index.fallback, ...index.global]) candidates.add(record)
  const scored: Array<{ memory: MemoryRecord; score: number }> = []
  for (const memory of candidates) {
    if (query.deadline !== undefined && performance.now() > query.deadline) break
    const life = memoryLife(memory, records, now)
    if (life === 'historical' && !retrospective) continue
    const site = Math.max(-1, ...memory.scopes.filter((s) => query.urls.some((url) => scopeMatches(s, url))).map(scopeSpecificity))
    if (query.isSubagent && (site < 0 || memory.global)) continue
    const cues = [...memory.triggers, ...memory.entities, memory.subject]
    const named = cues.some((cue) => cue.length >= 3 && !GENERIC.has(cue.toLowerCase()) && matchesTask(cue, query.task))
    if ((life === 'dormant' || life === 'upcoming') && !named && site < 0) continue
    const score = (named ? 200 : 0) + (site >= 0 ? 100 + Math.min(site, 80) : 0) + (memory.global && life === 'active' && !query.isSubagent ? 30 : 0)
    if (score) scored.push({ memory, score })
  }
  // One bounded relationship hop. Relationships are subject-scoped, never global authority.
  const subjects = new Set(scored.filter((s) => s.score >= 100).flatMap((s) => [subjectKey(s.memory.subject), subjectKey(s.memory.id)]))
  if (!query.isSubagent) for (const memory of records) {
    if (query.deadline !== undefined && performance.now() > query.deadline) break
    if (scored.some((s) => s.memory.id === memory.id) || !memory.relatedTo.some((s) => subjects.has(s))) continue
    const life = memoryLife(memory, records, now)
    if (life === 'active' || life === 'review') scored.push({ memory, score: 60 })
  }
  return scored.sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt || a.memory.id.localeCompare(b.memory.id)).map((s) => s.memory)
}

interface Entry { id: string; revision: number; life: string; data: Record<string, unknown> }
interface Packet { version: 1; entries: Entry[]; retired: Array<{ id: string; reason: string }> }
const BLOCK = /<continuity>[\s\S]*?<\/continuity>/g
const LEGACY = /<(user-memory|site-memory)>[\s\S]*?<\/\1>/g
const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
// JSON sits in element text, not an attribute. Escape delimiters without expanding every quote.
const render = (packet: Packet) => `<continuity>\n${contextText(JSON.stringify(packet)).replace(/&quot;/g, '"')}\n</continuity>`
function textOf(message: { role?: unknown; content?: unknown }): string {
  if (message.role !== 'user') return ''
  const content = message.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : ''
  return isRuntimeContextText(text) ? text : ''
}
function packets(text: string): Packet[] {
  return [...text.matchAll(BLOCK)].flatMap(([block]) => {
    try {
      const p = JSON.parse(decode(block.replace(/^<continuity>\s*|\s*<\/continuity>$/g, ''))) as Packet
      return p.version === 1 && Array.isArray(p.entries) && Array.isArray(p.retired) ? [p] : []
    } catch { return [] }
  })
}

/** Exclude derived memory from standalone conversation compaction; restore it explicitly afterward. */
export function withoutRememberedContext<T extends { role?: unknown; content?: unknown }>(history: T[]): T[] {
  return history.flatMap((message) => {
    const text = textOf(message)
    if (!text || (!text.match(BLOCK) && !text.match(LEGACY))) return [message]
    const next = text.replace(BLOCK, '').replace(LEGACY, '').replace(/\n{3,}/g, '\n\n').replace(/\n+<\/context>$/, '\n</context>')
    if (!next.replace(RUNTIME_CONTEXT_START, '').replace(/\s*<\/context>$/, '').trim()) return []
    return [{ ...message, content: typeof message.content === 'string' ? next : [{ ...(message.content as Record<string, unknown>[])[0], text: next }] }]
  })
}
function entryFor(record: MemoryRecord, records: readonly MemoryRecord[], now: number, guides?: MemoryQuery['guides']): Entry {
  const dates = Object.fromEntries(['validFrom', 'validUntil', 'eventStart', 'eventEnd', 'expiresAt', 'reviewAt', 'timeZone'].flatMap((key) => record[key as keyof MemoryRecord] ? [[key, record[key as keyof MemoryRecord]]] : []))
  return { id: record.id, revision: record.revision, life: memoryLife(record, records, now), data: {
    title: record.title, body: record.body, useWhen: record.useWhen, subject: record.subject,
    ...(record.scopes.length ? { scopes: record.scopes } : {}), ...dates,
    ...(record.guide ? { guide: record.guide } : {}),
    ...(record.guide && guides ? { guideState: guides.has(record.guide) ? 'available' : 'missing', guideUpdatedAt: guides.get(record.guide)?.updatedAt } : {}),
    ...(record.kind === 'procedure' ? { procedureStatus: record.procedureVersion && record.procedureVersion === HARNESS_VERSION ? 'observed with current tool contracts' : 'historical method; verify against current tool contracts before reuse' } : {}),
    sources: record.sources.slice(0, 2).map((s) => ({ origin: s.origin, outcome: s.outcome, at: new Date(s.at).toISOString(), label: s.label, chatId: s.chatId, itemId: s.itemId })),
  } }
}

/** Each instance owns a chat/agent delivery view; presence is reconstructed after rewind/restart. */
export class ContinuityDelivery {
  private preferred: Entry[] = []
  private records: readonly MemoryRecord[] = []
  private available = false
  private modelId = ''
  private now = Date.now()

  prepare(snapshot: MemorySnapshot | undefined, query: MemoryQuery, recent: readonly MemoryEvent[], modelId: string): void {
    this.modelId = modelId; this.now = query.now ?? Date.now()
    this.available = !!snapshot?.state.config.recall
    this.records = snapshot?.records ?? []
    this.preferred = this.available ? selectMemories(this.records, { ...query, deadline: performance.now() + 20 }).slice(0, 64).map((r) => entryFor(r, this.records, this.now, query.guides)) : []
    // A small immediate bridge while observation catches up, never a historical-chat search.
    if (this.available && !query.isSubagent) {
      const words = new Set(`${query.task} ${this.preferred.map((e) => JSON.stringify(e.data)).join(' ')}`.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu)?.filter((w) => !NOISE.has(w)) ?? [])
      const relevant = (e: MemoryEvent) => [...words].some((w) => matchesTask(w, `${e.label} ${e.text}`)) ||
        (/\b(today|tonight|to.?do|pending|left to|plan)\b/i.test(query.task) && /\b(done|finished|completed|submitted|applied)\b/i.test(e.text))
      const tail = recent.filter((e) => e.origin === 'human' && e.chatId !== query.chatId && e.at > this.now - 30 * 60_000 && e.text.length < 1_200 && relevant(e)).slice(-2)
      this.preferred.unshift(...tail.map((e) => ({ id: `recent:${e.id}`, revision: 1, life: 'unconsolidated', data: { origin: e.origin, at: new Date(e.at).toISOString(), text: e.text, chatId: e.chatId } })))
    }
  }

  next(history: ModelMessage[]): string | undefined {
    const boundary = latestCompactionBoundary(history).index
    const present = new Map<string, Entry>()
    const retired = new Map<string, string>()
    for (const message of history.slice(boundary + 1)) for (const packet of packets(textOf(message))) {
      for (const entry of packet.entries) { present.set(entry.id, entry); retired.delete(entry.id) }
      for (const item of packet.retired) { present.delete(item.id); retired.set(item.id, item.reason) }
    }
    const entries = this.preferred.filter((entry) => {
      const previous = present.get(entry.id)
      return !previous || previous.revision !== entry.revision || previous.life !== entry.life ||
        previous.data?.procedureStatus !== entry.data.procedureStatus || previous.data?.guideState !== entry.data.guideState || previous.data?.guideUpdatedAt !== entry.data.guideUpdatedAt
    })
    const removals: Packet['retired'] = []
    for (const [id, entry] of present) {
      if (id.startsWith('recent:')) continue
      const record = this.records.find((r) => r.id === id)
      const life = record ? memoryLife(record, this.records, this.now) : 'forgotten'
      if (!this.available || !record || (life === 'historical' && entry.life !== life)) {
        const reason = !this.available ? 'memory unavailable' : life === 'forgotten' ? 'forgotten' : 'no longer current'
        if (retired.get(id) !== reason) removals.push({ id, reason })
      }
    }
    if (!entries.length && !removals.length) return undefined
    // A large backlog never creates an over-budget injection while waiting for projection.
    const packet: Packet = { version: 1, entries: [], retired: removals.slice(0, 100) }
    for (const entry of entries) {
      const candidate = { ...packet, entries: [...packet.entries, entry] }
      if (memoryTokens(render(candidate), this.modelId) <= MEMORY_CONTEXT_MAX_TOKENS - 100) packet.entries.push(entry)
    }
    return packet.entries.length || packet.retired.length ? render(packet) : undefined
  }

  /** Request-only projection: one retained semantic version per id, shared budget across all blocks. */
  project<T extends { role?: unknown; content?: unknown }>(history: T[]): T[] {
    const latest = new Map<string, { entry: Entry; index: number }>()
    const retired = new Map<string, { reason: string; index: number }>()
    history.forEach((message, index) => {
      for (const packet of packets(textOf(message))) {
        for (const entry of packet.entries) { latest.set(entry.id, { entry, index }); retired.delete(entry.id) }
        for (const item of packet.retired) { latest.delete(item.id); retired.set(item.id, { reason: item.reason, index }) }
      }
    })
    const preferredIds = this.preferred.map((e) => e.id)
    const validIds = new Set(this.records.map((r) => r.id))
    const ordered = [...latest].filter(([id]) => this.available && (validIds.has(id) || preferredIds.includes(id)))
      .sort(([a, av], [b, bv]) => (preferredIds.includes(a) ? preferredIds.indexOf(a) : 10_000) - (preferredIds.includes(b) ? preferredIds.indexOf(b) : 10_000) || bv.index - av.index).slice(0, 128)
    const keep = new Set<string>()
    let used = 0
    // Count each complete envelope conservatively; combining entries only saves wrapper space.
    for (const [id, { entry }] of ordered) {
      const cost = memoryTokens(render({ version: 1, entries: [entry], retired: [] }), this.modelId) + 30
      if (used + cost <= MEMORY_CONTEXT_MAX_TOKENS - 1_000) { used += cost; keep.add(id) }
    }
    let retirementBudget = 900
    const keepRetired = new Set<string>()
    for (const [id, item] of [...retired].reverse()) {
      const cost = memoryTokens(JSON.stringify({ id, reason: item.reason }), this.modelId) + 100
      if (cost <= retirementBudget) { retirementBudget -= cost; keepRetired.add(id) }
    }
    return history.flatMap((message, index) => {
      const text = textOf(message)
      if (!text || (!text.match(BLOCK) && !text.match(LEGACY))) return [message]
      const updated = text.replace(LEGACY, '').replace(BLOCK, (block) => {
        const p = packets(block.startsWith('<context') ? block : `${RUNTIME_CONTEXT_START}${block}\n</context>`)[0]
        if (!p) return ''
        const entries = p.entries.filter((e) => keep.has(e.id) && latest.get(e.id)?.index === index)
        const removals = p.retired.filter((e) => keepRetired.has(e.id) && retired.get(e.id)?.index === index)
        return entries.length || removals.length ? render({ version: 1, entries, retired: removals }) : ''
      }).replace(/\n{3,}/g, '\n\n')
      if (!updated.replace(RUNTIME_CONTEXT_START, '').replace(/\s*<\/context>$/, '').trim()) return []
      if (updated === text) return [message]
      return [{ ...message, content: typeof message.content === 'string' ? updated : [{ ...(message.content as Record<string, unknown>[])[0], text: updated }] }]
    })
  }
}
