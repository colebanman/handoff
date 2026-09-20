import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { TaskInfo, TranscriptItem } from '../../shared/types'
import { settleTranscriptScope } from '../../shared/settle-transcript'
import { SubagentCard, TranscriptList } from './items'
import { TaskTray } from './TaskTray'

vi.mock('../store', () => ({ openMemoryFile: vi.fn() }))

const stale: TranscriptItem[] = [{
  kind: 'reasoning', id: 'thought', agentId: 'sub-1', text: 'Inspecting syllabus files', streaming: true,
}]

it('renders a terminal child transcript without Thinking or running indicators', () => {
  const html = renderToStaticMarkup(createElement(TranscriptList, {
    items: settleTranscriptScope(stale), streaming: false,
  }))
  expect(html).toContain('Inspecting syllabus files')
  expect(html).not.toContain('Thinking')
  expect(html).not.toContain('shine')
  expect(html).not.toContain('class="dots"')
  expect(stale[0]).toMatchObject({ streaming: true })
})

it('does not show Thinking on a failed card restored from an old snapshot', () => {
  const html = renderToStaticMarkup(createElement(SubagentCard, { item: {
    kind: 'tool', id: 'spawn', agentId: 'main', toolName: 'subagent_spawn', inputText: '',
    status: 'done', at: 1, childAgentId: 'sub-1', childStatus: 'error',
    childItems: [{ ...stale[0]!, text: '' } as TranscriptItem],
  } }))
  expect(html).toContain('Failed')
  expect(html).not.toContain('Thinking')
  expect(html).not.toContain('aria-label="running"')
})

it('shows failed tasks in the tray summary instead of All done', () => {
  const task: TaskInfo = {
    id: 'task-1', agentId: 'sub-1', chatId: 'chat-1', kind: 'subagent',
    description: 'Inspect syllabus', status: 'error', result: 'Failed to fetch',
    startedAt: Date.now() - 1000, endedAt: Date.now(),
  }
  const html = renderToStaticMarkup(createElement(TaskTray, {
    tasks: [task], transcript: [], onCancel: vi.fn(), onNudge: vi.fn(),
  }))
  expect(html).toContain('1 failed')
  expect(html).toContain('Failed to fetch')
  expect(html).not.toContain('All done')
})
