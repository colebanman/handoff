import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { ContinuityDelivery, selectMemories, withoutRememberedContext } from './continuity-context'
import { memoryContentSchema, newMemoryState, type MemoryRecord, type MemorySnapshot } from '../shared/continuity'
import { RUNTIME_CONTEXT_START } from '../shared/context-blocks'
import { memoryTokens } from './memory-budget'

const now = Date.parse('2026-10-06T12:00:00Z')
const make = (id: string, patch: Partial<MemoryRecord> = {}): MemoryRecord => ({
  ...memoryContentSchema.parse({ subject: id, title: id, body: `Useful fact about ${id}`, kind: 'project', useWhen: `When working on ${id}`, triggers: [id] }),
  id, revision: 1, edited: false, sources: [], createdAt: now, updatedAt: now, ...patch,
})
const snapshot = (records: MemoryRecord[]): MemorySnapshot => ({ records, state: newMemoryState(), pending: 0 })
const message = (block: string): ModelMessage => ({ role: 'user', content: `${RUNTIME_CONTEXT_START}${block}\n</context>` })
const checkpoint = (): ModelMessage => ({ role: 'user', content: '', providerOptions: { compaction: { checkpoint: { output: [{ type: 'compaction', id: 'window-2', encrypted_content: 'opaque' }] } } } })
const text = (messages: ModelMessage[]) => messages.map((m) => typeof m.content === 'string' ? m.content : '').join('\n')

describe('local associative recall', () => {
  const group = make('project.y.group', { triggers: ['Project Y'], scopes: ['school.example/courses/42/**'], validUntil: '2026-10-10' })
  it('selects a project by words on another site or by its specific page', () => {
    expect(selectMemories([group], { task: 'Who is in Project Y?', urls: ['https://mail.example/'], now })).toEqual([group])
    expect(selectMemories([group], { task: 'What about this?', urls: ['https://school.example/courses/42/work'], now })).toEqual([group])
    expect(selectMemories([group], { task: 'Check this email', urls: ['https://mail.example/'], now })).toEqual([])
  })
  it('rejects expired memories even with an exact URL, but permits explicit history', () => {
    const past = { ...group, expiresAt: '2026-10-01' }
    expect(selectMemories([past], { task: 'Project Y', urls: ['https://school.example/courses/42/work'], now })).toEqual([])
    expect(selectMemories([past], { task: 'Who was in the previous Project Y?', urls: [], now })).toEqual([past])
  })
  it('does not give a subagent personal context or allow keywords to broaden assigned sites', () => {
    const personal = make('writing', { kind: 'preference', global: true })
    expect(selectMemories([group, personal], { task: 'Project Y', urls: ['https://other.example'], now, isSubagent: true })).toEqual([])
    expect(selectMemories([group, personal], { task: 'Project Y', urls: ['https://school.example/courses/42'], now, isSubagent: true })).toEqual([group])
  })
  it('rejects generic cues and expands only one relevant relationship hop', () => {
    const unrelated = make('generic', { triggers: ['email', 'project', 'group'] })
    const linked = make('course.professor', { relatedTo: ['project y group'] })
    const distant = make('other-course', { relatedTo: ['course professor'] })
    expect(selectMemories([group, unrelated, linked, distant], { task: 'Project Y', urls: [], now }).map((r) => r.id)).toEqual([group.id, linked.id])
  })
})

describe('memory delivery and request projection', () => {
  it('supplies a memory once across repeated steps, tab returns, and a resumed delivery instance', () => {
    const record = make('Project Y')
    const delivery = new ContinuityDelivery()
    delivery.prepare(snapshot([record]), { task: 'Project Y', urls: [], now }, [], '')
    const first = delivery.next([])!
    expect(first).toContain('Useful fact')
    const history = [message(first)]
    expect(delivery.next(history)).toBeUndefined()
    delivery.prepare(snapshot([record]), { task: 'Something else', urls: [], now }, [], '')
    expect(delivery.next(history)).toBeUndefined()
    delivery.prepare(snapshot([record]), { task: 'Project Y again', urls: [], now }, [], '')
    expect(delivery.next(history)).toBeUndefined()
    const resumed = new ContinuityDelivery()
    resumed.prepare(snapshot([record]), { task: 'Project Y', urls: [], now }, [], '')
    expect(resumed.next(history)).toBeUndefined()
  })
  it('sends only a changed assertion, retires the old version, and preserves non-memory context', () => {
    const a = make('Project Y'), b = make('Project Z')
    const d = new ContinuityDelivery()
    d.prepare(snapshot([a, b]), { task: 'Project Y and Project Z', urls: [], now }, [], '')
    const history = [message(`<workspace>keep this</workspace>\n${d.next([])!}`)]
    d.prepare(snapshot([{ ...a, body: 'Group 6 now', revision: 2 }, b]), { task: 'Project Y', urls: [], now }, [], '')
    const change = d.next(history)!
    expect(change).toContain('Group 6 now')
    expect(change).not.toContain('Project Z')
    const view = d.project([...history, message(change)])
    expect(text(view)).toContain('keep this')
    expect(text(view)).not.toContain('Useful fact about Project Y')
    expect(text(view).match(/Useful fact about Project Z/g)).toHaveLength(1)
    expect(text(view).match(/Group 6 now/g)).toHaveLength(1)
    expect(text(history)).toContain('Useful fact about Project Y')
  })
  it('emits one expiration update without starting a new model call', () => {
    const record = make('Project Y', { validUntil: '2026-10-06' })
    const d = new ContinuityDelivery()
    d.prepare(snapshot([record]), { task: 'Project Y', urls: [], now }, [], '')
    const history = [message(d.next([])!)]
    d.prepare(snapshot([record]), { task: 'Project Y', urls: [], now: Date.parse('2026-10-07T00:00:00Z') }, [], '')
    const expired = d.next(history)!
    expect(expired).toContain('no longer current')
    expect(d.next([...history, message(expired)])).toBeUndefined()
    expect(text(d.project([...history, message(expired)]))).not.toContain('Useful fact')
  })
  it('restores after compaction and removes forgotten/disabled memory from request copies', () => {
    const record = make('Project Y')
    const d = new ContinuityDelivery()
    d.prepare(snapshot([record]), { task: 'Project Y', urls: [], now }, [], '')
    const history = [message(d.next([])!), checkpoint()]
    expect(d.next(history)).toContain('Useful fact')
    d.prepare(snapshot([]), { task: 'Project Y', urls: [], now }, [], '')
    expect(text(d.project(history))).not.toContain('Useful fact')
    expect(text(history)).toContain('Useful fact')
  })
  it('keeps one aggregate cap across repeated updates, legacy blocks, and arbitrary Unicode', () => {
    const records = Array.from({ length: 30 }, (_, i) => make(`project-${i}`, { triggers: ['coursework'], body: '日本語 😀 & <context> '.repeat(70) }))
    const d = new ContinuityDelivery()
    const history: ModelMessage[] = [message('<user-memory>legacy '.repeat(100) + '</user-memory>')]
    for (let step = 0; step < 8; step++) {
      d.prepare(snapshot(records.map((r, i) => ({ ...r, revision: step + 1, body: `${i}: ${r.body}` }))), { task: 'coursework', urls: [], now }, [], '')
      const next = d.next(d.project(history))
      if (next) history.push(message(next))
      const view = d.project(history)
      expect(memoryTokens(text(view))).toBeLessThanOrEqual(10_000)
      expect(text(view)).not.toContain('<user-memory>')
    }
  })
  it('does not rewrite a human message that merely quotes a memory tag', () => {
    const history: ModelMessage[] = [{ role: 'user', content: 'Explain this <continuity>something</continuity>' }]
    expect(withoutRememberedContext(history)).toEqual(history)
    expect(withoutRememberedContext([message('<workspace>keep</workspace>\n<continuity>{}</continuity>')])).toEqual([message('<workspace>keep</workspace>')])
  })
})
