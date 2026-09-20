import { expect, it } from 'vitest'
import { toolLabel } from './tool-labels'
it('describes page reading without character counts or internal tab ids', () => {
  expect(toolLabel('browser_snapshot', 'running', { tabId: 42 }, undefined)).toEqual({ verb: 'Reading page', payload: '' })
  expect(toolLabel('browser_snapshot', 'done', { tabId: 42 }, 'x'.repeat(2500))).toEqual({ verb: 'Read page', payload: '' })
})
it('uses a human fallback instead of exposing element refs', () => {
  expect(toolLabel('browser_click', 'running', { ref: 'e8' }, undefined)).toEqual({ verb: 'Clicking', payload: 'element' })
})
it('uses the cached accessible role and name when available', () => {
  const input = { ref: 'e8', __target: { role: 'button', name: 'Next question' } }
  expect(toolLabel('browser_click', 'running', input, undefined)).toEqual({ verb: 'Clicking', payload: 'button “Next question”' })
  expect(toolLabel('browser_click', 'done', input, undefined)).toEqual({ verb: 'Clicked', payload: 'button “Next question”' })
  expect(toolLabel('browser_click', 'error', input, undefined).verb).toBe('Couldn’t click')
})
it('still identifies an unnamed control by its role', () => {
  expect(toolLabel('browser_click', 'running', { __target: { role: 'checkbox', name: '' } }, undefined).payload).toBe('checkbox')
})

it('names background work by its subagent rather than its task record', () => {
  expect(toolLabel('task_wait', 'running', { taskIds: ['task-t-mfx-1-8emu'] }, undefined)).toEqual({ verb: 'Waiting on', payload: 'subagent 8emu' })
  expect(toolLabel('task_wait', 'running', { taskIds: ['task-a-1-8emu', 'task-a-2-qq31'] }, undefined)).toEqual({ verb: 'Waiting on', payload: '2 subagents' })
  expect(toolLabel('task_status', 'done', { taskId: 'task-a-1-8emu' }, undefined)).toEqual({ verb: 'Checked on', payload: 'subagent 8emu' })
})
