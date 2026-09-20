import { describe, expect, it } from 'vitest'
import type { ModelMessage, ToolResultPart, UserModelMessage } from 'ai'
import { REPLAY_MEDIA_BUDGET_CHARS, pruneReplayedHistory } from './history-pruning'
import { RUNTIME_CONTEXT_START } from '../shared/context-blocks'

function attachedFile(chars: number, filename = 'image.png', mediaType = 'image/png') {
  return { type: 'file' as const, data: 'x'.repeat(chars), filename, mediaType }
}

function toolMediaResult(callId: string, chars: number, mediaType = 'image/png'): ToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: callId,
    toolName: 'filesystem_view',
    output: {
      type: 'content',
      value: [
        { type: 'text', text: `Loaded /workspace/${callId}.png natively.` },
        { type: 'media', data: 'x'.repeat(chars), mediaType },
      ],
    },
  }
}

function user(content: UserModelMessage['content']): ModelMessage {
  return { role: 'user', content }
}

function assistant(text = 'Done.'): ModelMessage {
  return { role: 'assistant', content: text }
}

describe('replayed native media pruning', () => {
  it('does not age an attachment when the harness appends context between tool steps', () => {
    const file = attachedFile(REPLAY_MEDIA_BUDGET_CHARS + 500_000)
    const messages: ModelMessage[] = [
      user([{ type: 'text', text: 'Read this image.' }, file]),
      user(`${RUNTIME_CONTEXT_START}<workspace>New file</workspace>\n</context>`),
      assistant('Reading it.'),
      user(`${RUNTIME_CONTEXT_START}<site-memory>Updated guide</site-memory>\n</context>`),
    ]
    expect(pruneReplayedHistory(messages).prunedMedia).toBe(0)
  })
  it('always preserves a newly attached file natively, even above the stale-media budget', () => {
    const file = attachedFile(REPLAY_MEDIA_BUDGET_CHARS + 500_000)
    const messages: ModelMessage[] = [user([{ type: 'text', text: 'Read this image.' }, file])]

    const result = pruneReplayedHistory(messages)

    expect(result.messages).toBe(messages)
    expect(result.prunedMedia).toBe(0)
    expect((result.messages[0] as { content: unknown[] }).content[1]).toBe(file)
  })

  it('preserves the original native bytes for the first follow-up', () => {
    const file = attachedFile(REPLAY_MEDIA_BUDGET_CHARS + 500_000)
    const messages: ModelMessage[] = [
      user([{ type: 'text', text: 'Read this image.' }, file]),
      assistant('I can see it.'),
      user('Zoom in on the top-right corner.'),
    ]

    const result = pruneReplayedHistory(messages)

    expect(result.prunedMedia).toBe(0)
    expect((result.messages[0] as { content: unknown[] }).content[1]).toBe(file)
  })

  it('preserves a native PDF tool result for the first user follow-up', () => {
    const resultPart = toolMediaResult('pdf-page-1', REPLAY_MEDIA_BUDGET_CHARS + 500_000, 'application/pdf')
    const messages: ModelMessage[] = [
      user('Open the PDF.'),
      { role: 'tool', content: [resultPart] },
      assistant('I read the page.'),
      user('What does the chart on that page mean?'),
    ]

    const result = pruneReplayedHistory(messages)
    const tool = result.messages[1] as { content: ToolResultPart[] }

    expect(result.prunedMedia).toBe(0)
    expect(tool.content[0]).toBe(resultPart)
  })

  it('replaces an oversized old attachment with a text stub without changing the original', () => {
    const file = attachedFile(REPLAY_MEDIA_BUDGET_CHARS + 500_000)
    const messages: ModelMessage[] = [
      user([{ type: 'text', text: 'Read this image.' }, file]),
      assistant(),
      user('First follow-up.'),
      assistant(),
      user('Second follow-up.'),
    ]

    const result = pruneReplayedHistory(messages)
    const first = result.messages[0] as { content: Array<{ type: string; text?: string }> }

    expect(result.prunedMedia).toBe(1)
    expect(first.content[0]).toEqual({ type: 'text', text: 'Read this image.' })
    expect(first.content[1]?.type).toBe('text')
    expect(first.content[1]?.text).toContain('use filesystem_view to load it natively again')
    expect(file.data).toHaveLength(REPLAY_MEDIA_BUDGET_CHARS + 500_000)
  })

  it('shrinks the captured failure shape while retaining the newest old image', () => {
    const toolResults = [2_072_186, 1_342_930, 1_499_930, 1_824_222, 704_106].map((chars, i) =>
      toolMediaResult(`page-${i + 1}`, chars),
    )
    const messages: ModelMessage[] = [
      user([{ type: 'text', text: 'Initial appshot.' }, attachedFile(599_478, 'appshot-1.png')]),
      assistant(),
      user([
        { type: 'text', text: 'Two more images.' },
        attachedFile(450_122, 'appshot-2.png'),
        attachedFile(453_746, 'appshot-3.png'),
      ]),
      { role: 'tool', content: toolResults },
      assistant(),
      user('Follow-up one.'),
      assistant(),
      user('Follow-up two.'),
      assistant(),
      user('Follow-up three.'),
      assistant(),
      user('The message that previously hung.'),
    ]
    const before = JSON.stringify(messages).length

    const result = pruneReplayedHistory(messages)
    const after = JSON.stringify(result.messages).length

    expect(before).toBeGreaterThan(8_900_000)
    expect(after).toBeLessThan(1_000_000)
    expect(result.prunedMedia).toBe(7)
    expect(result.mediaCharsSaved).toBeGreaterThan(8_000_000)

    const second = pruneReplayedHistory(result.messages)
    expect(second.messages).toBe(result.messages)
    expect(second.prunedMedia).toBe(0)
  })
})

const FRESH_SNAPSHOT_MARKER = '\n\nFresh snapshot (replaces all previous refs for this tab):\n'

/** A browser_snapshot result: the whole value is the snapshot. */
function snapshot(callId: string, tabId: number, chars: number): ToolResultPart {
  const head = `Tab ${tabId}: snapshot\n`
  return {
    type: 'tool-result',
    toolCallId: callId,
    toolName: 'browser_snapshot',
    output: { type: 'text', value: head + 'x'.repeat(Math.max(0, chars - head.length)) },
  }
}

/** A browser_click result: an action message with a snapshot appended. */
function clickWithSnapshot(callId: string, tabId: number, chars: number): ToolResultPart {
  const head = `Clicked e12 in tab ${tabId}.${FRESH_SNAPSHOT_MARKER}Tab ${tabId}: snapshot\n`
  return {
    type: 'tool-result',
    toolCallId: callId,
    toolName: 'browser_click',
    output: { type: 'text', value: head + 'x'.repeat(Math.max(0, chars - head.length)) },
  }
}

function toolMessage(...parts: ToolResultPart[]): ModelMessage {
  return { role: 'tool', content: parts }
}

function valueOf(message: ModelMessage): string {
  const part = (message as { content: ToolResultPart[] }).content[0]!
  return (part.output as { value: string }).value
}

describe('snapshot replay budget', () => {
  // The 2026-08-27 failure: one step fans out browser_snapshot across seven
  // tabs. Each result is the newest for its own tab, so rule (a) keeps all
  // seven and the 32K server rejects the request.
  function sevenTabFanout(): ModelMessage[] {
    return [
      user('Summarize what is open.'),
      assistant('Looking.'),
      toolMessage(...[1, 2, 3, 4, 5, 6, 7].map((tab) => snapshot(`call_${tab}`, tab, 15_000))),
    ]
  }

  it('replays every tab unbudgeted, preserving frontier-model behaviour', () => {
    const messages = sevenTabFanout()

    const result = pruneReplayedHistory(messages)

    expect(result.messages).toBe(messages)
    expect(result.stubbedSnapshots).toBe(0)
    expect(result.droppedForBudget).toBe(0)
  })

  it('keeps snapshots newest-first until the budget is spent', () => {
    const result = pruneReplayedHistory(sevenTabFanout(), { snapshotBudgetChars: 36_000 })

    // 36,000 / 15,000 => two survive; the other five are dropped.
    expect(result.droppedForBudget).toBe(5)
    expect(result.stubbedSnapshots).toBe(5)

    const parts = (result.messages[2] as { content: ToolResultPart[] }).content
    const kept = parts.filter((p) => (p.output as { value: string }).value.length > 1_000)
    expect(kept).toHaveLength(2)
    // Scanning back to front makes the LAST two calls in the step the newest.
    expect(kept.map((p) => p.toolCallId)).toEqual(['call_6', 'call_7'])
  })

  it('tells the model how to recover a snapshot dropped for budget', () => {
    const result = pruneReplayedHistory(sevenTabFanout(), { snapshotBudgetChars: 36_000 })
    const parts = (result.messages[2] as { content: ToolResultPart[] }).content
    const dropped = (parts[0]!.output as { value: string }).value

    // A superseded stub can point at a later copy; this one cannot, so it has
    // to name the tab to re-snapshot.
    expect(dropped).toContain('omitted from replay to fit the context window')
    expect(dropped).toContain('call browser_snapshot on tab 1')
  })

  it('keeps the action message when trimming an appended snapshot', () => {
    const messages: ModelMessage[] = [
      user('Click through these.'),
      assistant('Clicking.'),
      toolMessage(clickWithSnapshot('call_a', 1, 15_000), clickWithSnapshot('call_b', 2, 15_000)),
    ]

    const result = pruneReplayedHistory(messages, { snapshotBudgetChars: 15_000 })

    const parts = (result.messages[2] as { content: ToolResultPart[] }).content
    const dropped = (parts[0]!.output as { value: string }).value
    expect(dropped).toContain('Clicked e12 in tab 1.')
    expect(dropped).not.toContain(FRESH_SNAPSHOT_MARKER)
    expect(result.droppedForBudget).toBe(1)
  })

  it('is idempotent — re-pruning pruned history changes nothing', () => {
    const first = pruneReplayedHistory(sevenTabFanout(), { snapshotBudgetChars: 36_000 })
    const second = pruneReplayedHistory(first.messages, { snapshotBudgetChars: 36_000 })

    expect(second.messages).toBe(first.messages)
    expect(second.stubbedSnapshots).toBe(0)
    expect(second.droppedForBudget).toBe(0)
  })

  it('evicts older snapshots when new tabs consume the budget', () => {
    const base = sevenTabFanout()
    const kept = (messages: ModelMessage[]): string[] => {
      const result = pruneReplayedHistory(messages, { snapshotBudgetChars: 36_000 })
      const parts = (result.messages[2] as { content: ToolResultPart[] }).content
      return parts
        .filter((p) => (p.output as { value: string }).value.length > 1_000)
        .map((p) => p.toolCallId)
    }

    const before = kept(base)
    // A later turn snapshots two more tabs, consuming the whole budget ahead of
    // the earlier step.
    const grown: ModelMessage[] = [
      ...base,
      assistant('More.'),
      toolMessage(snapshot('call_8', 8, 15_000), snapshot('call_9', 9, 15_000)),
    ]
    const after = kept(grown)

    // These appended snapshots consume the remaining budget ahead of the old
    // step. Replacing a snapshot with a smaller one can free budget later.
    expect(after.every((id) => before.includes(id))).toBe(true)
    expect(after).toHaveLength(0)
  })

  it('still prefers the newest snapshot per tab before spending budget', () => {
    const messages: ModelMessage[] = [
      user('Watch this tab.'),
      assistant('Looking.'),
      toolMessage(snapshot('call_old', 1, 15_000)),
      assistant('Again.'),
      toolMessage(snapshot('call_new', 1, 15_000)),
    ]

    const result = pruneReplayedHistory(messages, { snapshotBudgetChars: 36_000 })

    // Same tab: the older one is superseded, not budget-dropped, and the
    // survivor still fits.
    expect(result.stubbedSnapshots).toBe(1)
    expect(result.droppedForBudget).toBe(0)
    expect(valueOf(result.messages[2]!)).toContain('superseded')
    expect(valueOf(result.messages[4]!).length).toBe(15_000)
  })

  it('drops everything when the budget cannot fit a single snapshot', () => {
    const result = pruneReplayedHistory(sevenTabFanout(), { snapshotBudgetChars: 0 })

    expect(result.droppedForBudget).toBe(7)
    expect(result.charsSaved).toBeGreaterThan(100_000)
  })
})
