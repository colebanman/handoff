import { describe, expect, it } from 'vitest'
import { extractMemoryEvents, memoryEvidenceText } from './memory-evidence'
import type { ChatRecord, TranscriptItem } from '../shared/types'

const chat = (transcript: TranscriptItem[]): ChatRecord => ({ id: 'chat', title: 'Project discussion', createdAt: 10, updatedAt: 20, modelId: 'old-harness', transcript, messages: [] })
describe('experience normalization', () => {
  it('preserves actual source roles and excludes reasoning and running output', async () => {
    const events = await extractMemoryEvents(chat([
      { kind: 'user', id: 'u', text: 'The project is finished.', at: 10 },
      { kind: 'user', id: 'a', text: 'The user always prefers this.', at: 11, source: { kind: 'automation', id: 'auto', title: 'Daily task' } },
      { kind: 'reasoning', id: 'r', agentId: 'main', text: 'Maybe the user likes this?', streaming: false },
      { kind: 'text', id: 't', agentId: 'main', text: 'Incomplete output', streaming: true },
      { kind: 'tool', id: 'tool', agentId: 'main', at: 12, toolName: 'sandbox_exec', inputText: '{}', output: { group: 5 }, status: 'done' },
    ]))
    expect(events.map((e) => e.origin)).toEqual(['human', 'automation', 'tool'])
    expect(events[2]?.outcome).toBe('success')
    expect(JSON.stringify(events)).not.toContain('Maybe the user')
  })
  it('redacts credentials and binary/private transport payloads without dropping useful result fields', () => {
    const text = memoryEvidenceText({ Authorization: 'Bearer super-secret-value', cookie: 'sid=private', access_token: 'sensitive', password: 'pass', group: 5, nested: { encrypted_content: 'private-state', base64: 'image-bytes' } })
    expect(text).toContain('"group":5')
    for (const value of ['super-secret', 'sid=private', 'sensitive', 'private-state', 'image-bytes']) expect(text).not.toContain(value)
  })
  it('chunks large text without silently losing its middle or splitting Unicode', async () => {
    const text = '😀'.repeat(7_000) + 'Important group assignment here' + '尾'.repeat(10_000)
    const events = await extractMemoryEvents(chat([{ kind: 'user', id: 'u', text, at: 10 }]))
    expect(events.length).toBeGreaterThan(1)
    expect(events.map((e) => e.text).join('')).toBe(JSON.stringify({ text }))
    expect(events.every((e) => !/[\uD800-\uDBFF]$/.test(e.text))).toBe(true)
  })
  it('uses conservative authorship for legacy model-only records and skips injected context', async () => {
    const old = chat([])
    old.messages = [{ role: 'user', content: 'Maybe human, maybe generated' }, { role: 'user', content: '<context source="harness">\n<user-memory>old</user-memory>\n</context>' }, { role: 'assistant', content: [{ type: 'reasoning', text: 'private speculation' }] }]
    const events = await extractMemoryEvents(old)
    expect(events).toHaveLength(1)
    expect(events[0]?.origin).toBe('unknown')
  })
  it('does not re-ingest immutable completed units, while detecting changed human text', async () => {
    const first = chat([{ kind: 'user', id: 'u', text: 'Group 5', at: 10 }, { kind: 'text', id: 't', agentId: 'main', text: 'Noted', streaming: false }])
    const events = await extractMemoryEvents(first)
    const known = new Set(events.flatMap((e) => [e.parentId, e.id.slice(0, e.id.lastIndexOf(':'))]))
    expect(await extractMemoryEvents(first, known)).toEqual([])
    const changed = chat([{ kind: 'user', id: 'u', text: 'Group 6', at: 10 }])
    expect(await extractMemoryEvents(changed, known)).toHaveLength(1)
  })
})
