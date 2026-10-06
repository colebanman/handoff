/** Versioned, provider-independent memory. Browser attention and delivery are not user facts. */
import { z } from 'zod'

export const MEMORY_DB_NAME = 'handoff-memory'
export const MEMORY_CONTEXT_MAX_TOKENS = 10_000
export const MEMORY_CHANGED_KEY = 'memory-revision'
export const MEMORY_ALARM = 'memory-work'

const short = z.string().trim().min(1).max(120)
const strings = (max = 12) => z.array(short).max(max).default([])
const instant = z.string().refine((v) => {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(v) || !Number.isFinite(Date.parse(v))) return false
  const [y, m, d] = v.slice(0, 10).split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === v.slice(0, 10)
}, 'Use a real date or an ISO timestamp with its offset')
const zone = z.string().max(80).refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true } catch { return false } })

export const memoryContentSchema = z.object({
  subject: short.describe('Stable subject key; reuse existing keys, e.g. course.project.group.'),
  title: short,
  body: z.string().trim().min(1).max(2_400),
  kind: z.enum(['context', 'preference', 'project', 'event', 'procedure']),
  useWhen: z.string().trim().min(8).max(400),
  global: z.boolean().default(false),
  scopes: z.array(z.string().trim().min(1).max(300)).max(12).default([]),
  triggers: strings(),
  entities: strings(),
  relatedTo: strings(8),
  validFrom: instant.optional(),
  validUntil: instant.optional(),
  eventStart: instant.optional(),
  eventEnd: instant.optional(),
  expiresAt: instant.optional(),
  reviewAt: instant.optional(),
  expiresWith: short.optional(),
  timeZone: zone.default('UTC'),
  boundaryBasis: z.enum(['explicit', 'derived', 'review', 'unknown']).default('unknown'),
  state: z.enum(['active', 'dormant', 'historical']).default('active'),
  guide: z.string().max(400).optional(),
}).strict()
export type MemoryContent = z.infer<typeof memoryContentSchema>

export interface MemorySource {
  id: string
  chatId?: string
  itemId?: string
  path?: string
  origin: 'human' | 'assistant' | 'tool' | 'automation' | 'artifact' | 'legacy' | 'unknown'
  at: number
  timeBasis?: 'event' | 'turn' | 'chat'
  timeZone?: string
  label: string
  excerpt: string
  outcome?: 'success' | 'failure' | 'unknown'
  harnessVersion?: string
  savedContext?: boolean
  fingerprint?: string
}
export interface MemoryRecord extends MemoryContent {
  id: string
  revision: number
  createdAt: number
  updatedAt: number
  /** Direct user edits cannot be overwritten by an observer. */
  edited: boolean
  sources: MemorySource[]
  procedureVersion?: string
}
export interface MemoryEvent extends MemorySource {
  text: string
  pending: 0 | 1
  /** Parent transcript item identity, stable across chunks and re-imports. */
  parentId: string
  /** A completed background task can outlive its visible parent transcript. */
  detached?: boolean
}
export interface MemorySuppression { subject: string; sourceIds: string[]; at: number }
export interface MemoryConfig {
  learning: boolean
  recall: boolean
  model: 'gpt-6-luna' | 'gpt-6-sol'
  dailyTokenBudget: number
}
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = { learning: true, recall: true, model: 'gpt-6-luna', dailyTokenBudget: 1_000_000 }
export interface MemoryState {
  key: 'state'
  version: number
  /** Forget/deletion epoch invalidates opaque checkpoints containing removed memory. */
  privacyVersion: number
  config: MemoryConfig
  suppressions: MemorySuppression[]
  deletedChats: string[]
  retractedParents: string[]
  supersededEvents: string[]
  ignoredBefore: number
  pausedAt?: number
  excludedPeriods: Array<{ from: number; until: number }>
  legacyImported: boolean
  reviewedLegacy: string[]
  backfillComplete: boolean
  backfillAfter?: { at: number; id: string }
  lastRunAt?: number
  lastDreamAt?: number
  nextRunAt?: number
  error?: string
  running?: 'observing' | 'consolidating'
  usageDay: string
  usedTokens: number
  batches: number
}
export const newMemoryState = (): MemoryState => ({
  key: 'state', version: 0, privacyVersion: 0, config: { ...DEFAULT_MEMORY_CONFIG }, suppressions: [], deletedChats: [], retractedParents: [], supersededEvents: [],
  ignoredBefore: 0, excludedPeriods: [], legacyImported: false, reviewedLegacy: [], backfillComplete: false, usageDay: '', usedTokens: 0, batches: 0,
})
export interface MemorySnapshot { records: MemoryRecord[]; state: MemoryState; pending: number }

export const memoryPatchSchema = z.object({
  upserts: z.array(memoryContentSchema.extend({
    id: z.string().max(160).optional(),
    evidenceIds: z.array(z.string().min(1).max(300)).min(1).max(12),
    quotes: z.record(z.string().max(300), z.string().min(1).max(700)).optional(),
    replaces: z.array(z.string().max(160)).max(8).default([]),
  })).max(20).default([]),
  forget: z.array(z.object({ id: z.string().max(160), evidenceId: z.string().max(300) }).strict()).max(20).default([]),
}).strict()
export type MemoryPatch = z.infer<typeof memoryPatchSchema>

export const memoryCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('list') }),
  z.object({ command: z.literal('run') }),
  z.object({ command: z.literal('export') }),
  z.object({ command: z.literal('clear') }),
  z.object({ command: z.literal('forget'), id: z.string().min(1) }),
  z.object({ command: z.literal('unlock'), id: z.string().min(1), revision: z.number().int() }),
  z.object({ command: z.literal('delete-chat'), chatId: z.string().min(1) }),
  z.object({ command: z.literal('edit'), id: z.string().min(1), revision: z.number().int(), content: memoryContentSchema }),
  z.object({ command: z.literal('configure'), config: z.object({
    learning: z.boolean(), recall: z.boolean(), model: z.enum(['gpt-6-luna', 'gpt-6-sol']),
    dailyTokenBudget: z.number().int().min(10_000).max(2_000_000),
  }).strict() }),
])
export type MemoryCommand = z.infer<typeof memoryCommandSchema>

export function subjectKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/^\s*\[(?:stable|current)\]\s*/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}
/** Stable content identifier; collision-safe SHA-256 is used for journal events. */
export async function memoryHash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Date-only bounds retain their local calendar meaning, including DST. Upper bounds are inclusive days. */
const calendarBounds = new Map<string, number>()
export function memoryTime(value: string | undefined, timeZone = 'UTC', upper = false): number | undefined {
  if (!value) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) { const n = Date.parse(value); return Number.isFinite(n) ? n : undefined }
  const key = `${value}:${timeZone}:${upper}`
  const cached = calendarBounds.get(key)
  if (cached !== undefined) return cached
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  if (new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) !== value) return undefined
  const wall = Date.UTC(y, m - 1, d + (upper ? 1 : 0))
  if (!upper && new Date(wall).toISOString().slice(0, 10) !== value) return undefined
  try {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    let result = wall
    for (let i = 0; i < 4; i++) {
      const p = Object.fromEntries(format.formatToParts(result).map(({ type, value: v }) => [type, Number(v)]))
      const delta = wall - Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!)
      result += delta
      if (!delta) break
    }
    if (calendarBounds.size >= 2048) calendarBounds.delete(calendarBounds.keys().next().value!)
    calendarBounds.set(key, result)
    return result
  } catch { return undefined }
}

export type MemoryLife = 'active' | 'upcoming' | 'review' | 'dormant' | 'historical'
const lifeIndexes = new WeakMap<readonly MemoryRecord[], Map<string, MemoryRecord>>()
function relatedRecord(records: readonly MemoryRecord[], key: string): MemoryRecord | undefined {
  let index = lifeIndexes.get(records)
  if (!index) {
    index = new Map(records.flatMap((r) => [[r.id, r], [subjectKey(r.subject), r]] as Array<[string, MemoryRecord]>))
    lifeIndexes.set(records, index)
  }
  return index.get(key) ?? index.get(subjectKey(key))
}
export function memoryLife(memory: MemoryRecord, records: readonly MemoryRecord[], now = Date.now(), seen = new Set<string>()): MemoryLife {
  if (memory.state === 'historical') return memory.state
  if (seen.has(memory.id)) return 'review'
  seen.add(memory.id)
  const cutoffs = [memory.expiresAt, memory.validUntil, memory.kind === 'event' ? memory.eventEnd : undefined].flatMap((s) => {
    const n = memoryTime(s, memory.timeZone, true); return n === undefined ? [] : [n]
  })
  if (cutoffs.some((cutoff) => now >= cutoff)) return 'historical'
  if (memory.expiresWith) {
    const parent = relatedRecord(records, memory.expiresWith)
    if (!parent) return 'review'
    if (parent) {
      const state = memoryLife(parent, records, now, seen)
      if (state === 'historical' || state === 'dormant') return 'historical'
      if (state === 'review') return 'review'
    }
  }
  if (memory.state === 'dormant') return memory.state
  const from = memoryTime(memory.validFrom, memory.timeZone)
  if (from !== undefined && now < from) return 'upcoming'
  const review = memoryTime(memory.reviewAt, memory.timeZone, true)
  return review !== undefined && now >= review ? 'review' : 'active'
}
