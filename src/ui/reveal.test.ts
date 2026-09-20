import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '../shared/types'
import {
  applyReveal,
  MAX_CPS,
  MIN_CPS,
  RevealBuffer,
  revealCps,
  TARGET_LEAD_MS,
  wordBoundary,
} from './reveal'

function text(id: string, body: string, streaming = true): TranscriptItem {
  return { kind: 'text', id, agentId: 'main', text: body, streaming }
}

function reasoning(id: string, body: string, streaming = true): TranscriptItem {
  return { kind: 'reasoning', id, agentId: 'main', text: body, streaming }
}

function tool(id: string): TranscriptItem {
  return { kind: 'tool', id, agentId: 'main', toolName: 'browser_navigate', inputText: '', status: 'running', at: 0 }
}

/** Advance a buffer by `ms` in ~16ms frames, starting from a resynced clock. */
function run(buffer: RevealBuffer, ms: number, start = 1000): number {
  buffer.resync(start)
  let t = start
  const end = start + ms
  while (t < end) {
    t = Math.min(end, t + 16)
    buffer.tick(t)
  }
  return t
}

describe('revealCps', () => {
  it('drains toward a bounded reserve rather than at a fixed speed', () => {
    const base = { ended: false, pressured: false, tailMs: 260, flushCps: undefined }
    // pending / TARGET_LEAD is the whole rate law: more owed, faster drain.
    expect(revealCps({ ...base, received: 100, revealed: 0 })).toBeCloseTo((100 * 1000) / TARGET_LEAD_MS)
    expect(revealCps({ ...base, received: 300, revealed: 0 })).toBeGreaterThan(
      revealCps({ ...base, received: 100, revealed: 0 }),
    )
  })

  it('clamps both ends so nothing crawls or dumps', () => {
    const base = { ended: false, pressured: false, tailMs: 260, flushCps: undefined }
    expect(revealCps({ ...base, received: 2, revealed: 0 })).toBe(MIN_CPS)
    expect(revealCps({ ...base, received: 100_000, revealed: 0 })).toBe(MAX_CPS)
  })

  it('owes nothing when the display has caught up', () => {
    expect(
      revealCps({ received: 50, revealed: 50, ended: false, pressured: false, tailMs: 260, flushCps: undefined }),
    ).toBe(0)
  })

  it('holds the latched flush rate once a part has closed', () => {
    expect(
      revealCps({ received: 100, revealed: 0, ended: true, pressured: false, tailMs: 260, flushCps: 400 }),
    ).toBe(400)
  })
})

describe('wordBoundary', () => {
  it('never cuts a word in half', () => {
    expect(wordBoundary('hello world again', 8)).toBe(6)
  })

  it('passes the whole string through once the limit reaches the end', () => {
    expect(wordBoundary('hello world', 11)).toBe(11)
    expect(wordBoundary('hello world', 40)).toBe(11)
  })

  it('gives up inside an unbroken run instead of stalling the feed', () => {
    const url = 'https://example.com/a-very-long-path-that-never-breaks-anywhere-at-all'
    expect(wordBoundary(url, 50)).toBe(50)
  })

  it('breaks on newlines and tabs too', () => {
    expect(wordBoundary('a\nbcd', 4)).toBe(2)
    expect(wordBoundary('a\tbcd', 4)).toBe(2)
  })
})

describe('applyReveal', () => {
  it('returns the same array when nothing is buffered', () => {
    const items = [text('t1', 'all of it', false)]
    expect(applyReveal(items, {})).toBe(items)
  })

  it('slices the draining part back to whole words', () => {
    const items = [text('t1', 'one two three')]
    const out = applyReveal(items, { t1: 8 })
    expect(out).toHaveLength(1)
    expect((out[0] as { text: string }).text).toBe('one two ')
  })

  it('withholds everything the model produced after the draining part', () => {
    const items = [reasoning('r1', 'checking the page layout'), tool('c1'), text('t1', 'done')]
    const out = applyReveal(items, { r1: 12 })
    expect(out).toHaveLength(1)
    expect((out[0] as { text: string }).text).toBe('checking ')
  })

  it('keeps the caret alive through the tail after the stream closed', () => {
    const items = [text('t1', 'one two three', false)]
    const out = applyReveal(items, { t1: 4 })
    expect((out[0] as { streaming: boolean }).streaming).toBe(true)
  })

  it('preserves identity for items ahead of the draining one', () => {
    const user: TranscriptItem = { kind: 'user', id: 'u1', text: 'hi', at: 0 }
    const items = [user, text('t1', 'one two three')]
    const out = applyReveal(items, { t1: 4 })
    expect(out[0]).toBe(user)
  })

  it('leaves a part alone once its count covers the whole text', () => {
    const items = [text('t1', 'short'), tool('c1')]
    expect(applyReveal(items, { t1: 5 })).toBe(items)
  })
})

describe('RevealBuffer', () => {
  it('paints history instantly — a closed part is never buffered', () => {
    const buffer = new RevealBuffer()
    buffer.observe('chat-1', [text('t1', 'already finished', false)])
    expect(buffer.counts()).toEqual({})
    expect(buffer.draining()).toBe(false)
  })

  it('holds a reserve back while the stream is open', () => {
    const buffer = new RevealBuffer()
    const body = 'x'.repeat(600)
    buffer.observe('chat-1', [text('t1', body)])
    run(buffer, 500)
    const revealed = buffer.counts()['t1']!
    expect(revealed).toBeGreaterThan(0)
    expect(revealed).toBeLessThan(600)
  })

  it('flushes within the tail once the part closes', () => {
    const buffer = new RevealBuffer()
    const body = 'word '.repeat(80)
    buffer.observe('chat-1', [text('t1', body)])
    const t = run(buffer, 300)
    expect(buffer.draining()).toBe(true)
    buffer.observe('chat-1', [text('t1', body, false)])
    buffer.resync(t)
    let now = t
    for (let i = 0; i < 30; i++) buffer.tick((now += 16))
    // Entry retired => the item renders in full again.
    expect(buffer.counts()['t1']).toBeUndefined()
    expect(buffer.draining()).toBe(false)
  })

  it('shortens the tail when something is already queued behind', () => {
    const body = 'word '.repeat(80)
    const patient = new RevealBuffer()
    const pressured = new RevealBuffer()
    patient.observe('chat-1', [reasoning('r1', body)])
    pressured.observe('chat-1', [reasoning('r1', body)])
    run(patient, 200)
    run(pressured, 200)
    // Same elapsed time, but one of them has a tool call waiting on it.
    patient.observe('chat-1', [reasoning('r1', body, false)])
    pressured.observe('chat-1', [reasoning('r1', body, false), tool('c1')])
    run(patient, 200, 2000)
    run(pressured, 200, 2000)
    expect(pressured.counts()['r1'] ?? body.length).toBeGreaterThan(patient.counts()['r1'] ?? body.length)
  })

  it('does not gate on a part that has arrived empty', () => {
    const buffer = new RevealBuffer()
    const items = [text('t1', '')]
    buffer.observe('chat-1', items)
    expect(applyReveal(items, buffer.counts())).toBe(items)
    expect(buffer.draining()).toBe(false)
  })

  it('drops the reserve when the chat on screen changes', () => {
    const buffer = new RevealBuffer()
    buffer.observe('chat-1', [text('t1', 'x'.repeat(400))])
    run(buffer, 100)
    expect(buffer.draining()).toBe(true)
    buffer.observe('chat-2', [text('t2', 'other chat', false)])
    expect(buffer.counts()).toEqual({})
    expect(buffer.draining()).toBe(false)
  })

  it('forgets entries whose item a rewind removed', () => {
    const buffer = new RevealBuffer()
    const streaming = text('t1', 'x'.repeat(400))
    buffer.observe('chat-1', [{ kind: 'user', id: 'u1', text: 'hi', at: 0 }, streaming])
    run(buffer, 100)
    expect(buffer.draining()).toBe(true)
    buffer.observe('chat-1', [{ kind: 'user', id: 'u1', text: 'hi', at: 0 }])
    expect(buffer.counts()).toEqual({})
  })

  it('snapAll gives up the reserve immediately', () => {
    const buffer = new RevealBuffer()
    buffer.observe('chat-1', [text('t1', 'x'.repeat(400))])
    run(buffer, 100)
    expect(buffer.snapAll()).toBe(true)
    expect(buffer.counts()).toEqual({})
    expect(buffer.draining()).toBe(false)
  })

  it('bills at most one clamped frame after a starved tab, not the whole gap', () => {
    const buffer = new RevealBuffer()
    buffer.observe('chat-1', [text('t1', 'x'.repeat(5000))])
    buffer.resync(1000)
    buffer.tick(31_000) // 30s of a hidden panel in one delta
    expect(buffer.counts()['t1']!).toBeLessThanOrEqual(MAX_CPS * 0.1)
  })

  it('reuses the counts object between ticks that changed nothing', () => {
    const buffer = new RevealBuffer()
    buffer.observe('chat-1', [text('t1', 'x'.repeat(400))])
    run(buffer, 50)
    const first = buffer.counts()
    expect(buffer.tick(1_050.0001)).toBe(false)
    expect(buffer.counts()).toBe(first)
  })
})
