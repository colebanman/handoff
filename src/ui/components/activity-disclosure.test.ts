import { describe, expect, it } from 'vitest'
import type { ActivityItem } from '../activity'
import { activityDisclosure, thoughtDisclosure } from './activity-disclosure'

const reasoning: ActivityItem = {
  kind: 'reasoning', id: 'r', agentId: 'main', text: 'Checking the available evidence before summarizing the page.', streaming: false,
}
const tool: ActivityItem = {
  kind: 'tool', id: 't', agentId: 'main', toolName: 'sandbox_exec', inputText: '', status: 'done', at: 1_000,
}

describe('activity disclosure', () => {
  it('folds completed mixed reasoning/tool runs even with just one tool call', () => {
    expect(activityDisclosure([reasoning, tool], false, null)).toEqual({ hasHeader: true, open: false, capped: false })
  })

  it('keeps automatic live activity visible in a bounded window', () => {
    expect(activityDisclosure([reasoning, tool], true, null)).toEqual({ hasHeader: true, open: true, capped: true })
  })

  it('keeps a reader-opened summary unbounded through completion', () => {
    expect(activityDisclosure([reasoning, tool], true, true)).toEqual({ hasHeader: true, open: true, capped: false })
    expect(activityDisclosure([reasoning, tool], false, true)).toEqual({ hasHeader: true, open: true, capped: false })
  })

  it('preserves a manual close while working and after completion', () => {
    for (const live of [true, false]) {
      expect(activityDisclosure([reasoning, tool], live, false)).toEqual({ hasHeader: true, open: false, capped: false })
    }
  })

  it('does not put a second disclosure around a lone thought or lone tool', () => {
    for (const items of [[reasoning], [tool], [tool, { ...reasoning, text: '   ' }]]) {
      expect(activityDisclosure(items, false, null)).toEqual({ hasHeader: false, open: true, capped: false })
    }
  })

  it('keeps a body opened before grouping expanded when more activity arrives', () => {
    expect(activityDisclosure([reasoning], true, true).open).toBe(true)
    expect(activityDisclosure([reasoning, tool], false, true).open).toBe(true)
  })
})

describe('thought disclosure', () => {
  it('opens verbose prose through live activity and closes it when the answer starts', () => {
    expect(thoughtDisclosure(true, true, null)).toEqual({ open: true, automatic: true })
    expect(thoughtDisclosure(true, false, null)).toEqual({ open: false, automatic: false })
  })

  it('keeps explicit headline summaries collapsed unless opened by the reader', () => {
    expect(thoughtDisclosure(false, true, null)).toEqual({ open: false, automatic: false })
    expect(thoughtDisclosure(false, false, null)).toEqual({ open: false, automatic: false })
  })

  it('respects a manual open during live work and after completion without a preview cap', () => {
    for (const live of [true, false]) {
      expect(thoughtDisclosure(true, live, true)).toEqual({ open: true, automatic: false })
    }
  })

  it('respects a manual close as new reasoning streams and when the answer starts', () => {
    for (const live of [true, false]) {
      expect(thoughtDisclosure(true, live, false)).toEqual({ open: false, automatic: false })
    }
  })
})
