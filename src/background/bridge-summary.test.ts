import { describe, expect, it } from 'vitest'
import { collectToolCalls, finalText, summarizeChat, toolCallsFor } from './bridge-summary'
import { BRIDGE_TEXT_BUDGET } from '../shared/bridge-protocol'
import type { ChatRecord, TranscriptItem } from '../shared/types'

function chat(transcript: TranscriptItem[], extra: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: 'chat-1',
    title: 'Test',
    createdAt: 1,
    updatedAt: 2,
    modelId: 'grok-4',
    messages: [],
    transcript,
    ...extra,
  }
}

const user = (text: string): TranscriptItem => ({ kind: 'user', id: `u-${text}`, text, at: 1 })
const say = (text: string, agentId = 'main'): TranscriptItem => ({
  kind: 'text',
  id: `t-${text}`,
  agentId,
  text,
  streaming: false,
})
const tool = (toolName: string, extra: Partial<Extract<TranscriptItem, { kind: 'tool' }>> = {}): TranscriptItem => ({
  kind: 'tool',
  id: `call-${toolName}`,
  agentId: 'main',
  toolName,
  inputText: '{}',
  status: 'done',
  at: 1,
  ...extra,
})

describe('finalText', () => {
  it('joins every main text block after the last user message', () => {
    const transcript = [user('one'), say('stale'), user('two'), say('part a'), tool('x'), say('part b')]
    expect(finalText(transcript)).toBe('part a\n\npart b')
  })

  it('ignores subagent output — the main agent speaks for the turn', () => {
    const transcript = [user('go'), say('child chatter', 'sub-1'), say('the answer')]
    expect(finalText(transcript)).toBe('the answer')
  })

  it('falls back to the last main reply when the newest turn has produced nothing yet', () => {
    const transcript = [user('one'), say('earlier answer'), user('two'), tool('browser_snapshot')]
    expect(finalText(transcript)).toBe('earlier answer')
  })

  it('is empty for a chat with no assistant text', () => {
    expect(finalText([user('hi')])).toBe('')
  })
})

describe('collectToolCalls', () => {
  it('flattens subagent children in order and keeps parents', () => {
    const transcript = [
      tool('subagent_spawn', {
        childItems: [tool('sandbox_exec'), tool('browser_navigate')],
      }),
      tool('filesystem_view'),
    ]
    expect(collectToolCalls(transcript).map((call) => call.toolName)).toEqual([
      'subagent_spawn',
      'sandbox_exec',
      'browser_navigate',
      'filesystem_view',
    ])
  })

  it('truncates oversized tool output instead of relaying it whole', () => {
    const [call] = collectToolCalls([tool('sandbox_exec', { output: 'x'.repeat(50_000) })])
    expect(String(call?.output)).toContain('[truncated')
    expect(String(call?.output).length).toBeLessThan(3_000)
  })

  it('falls back to raw streamed args when parsed input is absent', () => {
    const [call] = collectToolCalls([tool('browser_click', { inputText: '{"ref":"e12"}' })])
    expect(call?.input).toBe('{"ref":"e12"}')
  })
})

describe('summarizeChat', () => {
  it('reports status, provenance, counts, and the last error', () => {
    const record = chat(
      [
        user('find my job history'),
        tool('browser_navigate'),
        { kind: 'error', id: 'e1', agentId: 'main', message: 'rate limited', at: 3 },
        say('You worked at Acme.'),
      ],
      {
        origin: { kind: 'external', client: 'claude-code', at: 5 },
        messages: [{}, {}, {}],
        turns: [
          {
            at: 1,
            wallMs: 10,
            modelId: 'grok-4',
            provider: 'xai',
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          },
        ],
      },
    )
    const summary = summarizeChat(record, { running: true })
    expect(summary).toMatchObject({
      chatId: 'chat-1',
      status: 'running',
      text: 'You worked at Acme.',
      toolCallCount: 1,
      turnCount: 1,
      messageCount: 3,
      lastError: 'rate limited',
      usage: { input: 100, output: 20, total: 120 },
    })
    expect(summary.origin?.client).toBe('claude-code')
    // Summary mode stays cheap: no transcript, no tool payloads.
    expect(summary.toolCalls).toBeUndefined()
    expect(summary.transcript).toBeUndefined()
  })

  it('clips a runaway answer to the text budget and says so', () => {
    const summary = summarizeChat(chat([user('go'), say('y'.repeat(BRIDGE_TEXT_BUDGET + 500))]), { running: false })
    expect(summary.textTruncated).toBe(true)
    expect(summary.text).toContain('[truncated')
    expect(summary.status).toBe('idle')
  })

  it('include=full adds the tool trail and a transcript digest', () => {
    const summary = summarizeChat(chat([user('go'), tool('sandbox_exec'), say('done')]), {
      running: false,
      include: 'full',
    })
    expect(summary.toolCalls).toHaveLength(1)
    expect(summary.transcript?.map((row) => row.role)).toEqual(['user', 'tool', 'assistant'])
  })
})

describe('toolCallsFor', () => {
  it('returns the most recent calls up to the limit', () => {
    const record = chat([tool('a'), tool('b'), tool('c')])
    expect(toolCallsFor(record, 2).map((call) => call.toolName)).toEqual(['b', 'c'])
  })
})
