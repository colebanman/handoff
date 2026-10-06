import { describe, expect, it } from 'vitest'
import { clusterDetail, clusterLabel, describeStep, isVerboseReasoning, pastTense, stepState, thoughtLabel, type StepSource } from './tool-labels'

const code = (input: Record<string, unknown>, status: StepSource['status'] = 'running', extra: Partial<StepSource> = {}): StepSource => ({
  toolName: 'sandbox_exec', status, input, ...extra,
})

describe('sandbox_exec steps', () => {
  it('shows the intent the moment it streams in — never a "waiting for model" placeholder', () => {
    const drafting = describeStep(code({ intent: 'Reading cour' }, 'running', { inputStreaming: true }))
    expect(drafting.label).toBe('Reading cour')
    expect(drafting.placeholder).toBeUndefined()
    expect(JSON.stringify(drafting)).not.toMatch(/Preparing|waiting for model/)
  })

  it('reads "Thinking" until the call has anything informative', () => {
    expect(describeStep(code({}, 'running', { inputStreaming: true }))).toMatchObject({ label: 'Thinking', placeholder: true })
    // Code that already says what it does is informative even without an intent.
    const fetching = describeStep(code({ code: "await api.fetch('https://canvas.edu/api')" }, 'running', { inputStreaming: true }))
    expect(fetching).toMatchObject({ label: 'Fetching', detail: 'canvas.edu' })
    expect(fetching.placeholder).toBeUndefined()
  })

  it('flips a finished intent to past tense and lists what the code touched', () => {
    const input = { intent: 'Reading the syllabus', code: "return api.fs.readText('/workspace/imports/course101.pdf')" }
    expect(describeStep(code(input, 'running'))).toMatchObject({ label: 'Reading the syllabus', detail: 'course101.pdf', icon: 'file' })
    expect(describeStep(code(input, 'done'))).toMatchObject({ label: 'Read the syllabus', detail: 'course101.pdf', icon: 'file' })
  })

  it('does not repeat a target the intent already names', () => {
    const input = { intent: 'Reading notes.md', code: "return api.fs.readText('/workspace/notes.md')" }
    expect(describeStep(code(input, 'done')).detail).toBeUndefined()
  })

  it('shows why a failed step failed', () => {
    const failed = code({ intent: 'Locating the apply button', code: 'x' }, 'done', { output: 'Error: SyntaxError: Unexpected token }' })
    expect(stepState(failed)).toBe('error')
    expect(describeStep(failed)).toMatchObject({ label: 'Locating the apply button', detail: 'SyntaxError: Unexpected token }', mono: false })
  })

  it('names intent-less calls by their strongest action', () => {
    expect(describeStep(code({ code: "await api.page.navigate(tab, 'https://united.com/'); await api.page.snapshot(tab)" }, 'done'))).toMatchObject({
      label: 'Opened', detail: 'united.com', icon: 'globe', family: 'code:navigate',
    })
    expect(describeStep(code({ code: 'return state.rows.length' }, 'done'))).toMatchObject({ label: 'Ran code', icon: 'code' })
  })
})

describe('browser and workspace steps', () => {
  it('describes page reading without character counts or internal tab ids', () => {
    expect(describeStep({ toolName: 'browser_snapshot', status: 'running', input: { tabId: 42 } })).toMatchObject({ label: 'Reading the page', detail: undefined })
    expect(describeStep({ toolName: 'browser_snapshot', status: 'done', input: { tabId: 42 }, output: 'x'.repeat(2500) })).toMatchObject({ label: 'Read the page', detail: undefined })
    expect(describeStep({ toolName: 'browser_screenshot', status: 'done', input: { tabId: 42 } }).detail).toBeUndefined()
  })

  it('uses a human fallback instead of exposing element refs', () => {
    expect(describeStep({ toolName: 'browser_click', status: 'running', input: { ref: 'e8' } })).toMatchObject({ label: 'Clicking', detail: 'element' })
  })

  it('uses the cached accessible role and name when available', () => {
    const input = { ref: 'e8', __target: { role: 'button', name: 'Next question' } }
    expect(describeStep({ toolName: 'browser_click', status: 'running', input })).toMatchObject({ label: 'Clicking', detail: 'button “Next question”' })
    expect(describeStep({ toolName: 'browser_click', status: 'done', input })).toMatchObject({ label: 'Clicked', detail: 'button “Next question”' })
    expect(describeStep({ toolName: 'browser_click', status: 'error', input }).label).toBe('Couldn’t click')
  })

  it('still identifies an unnamed control by its role', () => {
    expect(describeStep({ toolName: 'browser_click', status: 'running', input: { __target: { role: 'checkbox', name: '' } } }).detail).toBe('checkbox')
  })

  it('names background work by its subagent rather than its task record', () => {
    expect(describeStep({ toolName: 'task_wait', status: 'running', input: { taskIds: ['task-t-mfx-1-8emu'] } })).toMatchObject({ label: 'Waiting on', detail: 'subagent 8emu' })
    expect(describeStep({ toolName: 'task_wait', status: 'running', input: { taskIds: ['task-a-1-8emu', 'task-a-2-qq31'] } })).toMatchObject({ label: 'Waiting on', detail: '2 subagents' })
    expect(describeStep({ toolName: 'task_status', status: 'done', input: { taskId: 'task-a-1-8emu' } })).toMatchObject({ label: 'Checked on', detail: 'subagent 8emu' })
  })

  it('shows a viewed file by name, not by mode and full path', () => {
    const view = describeStep({ toolName: 'filesystem_view', status: 'done', input: { path: '/workspace/artifacts/capital-one-draft.html', mode: 'auto' } })
    expect(view).toMatchObject({ label: 'Viewed', detail: 'capital-one-draft.html', title: '/workspace/artifacts/capital-one-draft.html' })
  })

  it('never shows a raw snake_case tool name', () => {
    expect(describeStep({ toolName: 'coding_agent', status: 'done', input: { task: 'x' } }).label).toBe('Coding Agent')
  })
})

describe('clusters', () => {
  it('folds similar finished steps into one sentence with their targets', () => {
    const clicks: StepSource[] = ['Courses', 'COURSE101', 'Syllabus'].map((name) => ({
      toolName: 'browser_click', status: 'done', input: { __target: { role: 'link', name } },
    }))
    expect(clusterLabel('click', clicks)).toBe('Clicked 3 elements')
    expect(clusterDetail(clicks.map((c) => describeStep(c)))).toBe('“Courses”, “COURSE101”, “Syllabus”')
    expect(clusterLabel('visit', clicks.slice(0, 2))).toBe('Opened 2 pages')
    expect(clusterLabel('tasks', [{ toolName: 'task_wait', status: 'done' }, { toolName: 'task_wait', status: 'done' }])).toBe('Waited on subagents 2 times')
  })

  it('lists at most three targets', () => {
    const views = ['a.com', 'b.com', 'c.com', 'd.com'].map((host) => describeStep({ toolName: 'browser_navigate', status: 'done', input: { url: `https://${host}/` } }))
    expect(clusterDetail(views)).toBe('a.com, b.com, c.com +1')
  })
})

describe('past tense', () => {
  it.each([
    ['Reading the syllabus', 'Read the syllabus'],
    ['Checking due dates', 'Checked due dates'],
    ['Verifying textbook content endpoint', 'Verified textbook content endpoint'],
    ['Locating the apply control', 'Located the apply control'],
    ['Mapping future semesters', 'Mapped future semesters'],
    ['Adding the reading list', 'Added the reading list'],
    ['Finding the endpoint', 'Found the endpoint'],
    ['Setting Example City store location', 'Set Example City store location'],
    ['Querying COURSE 101 equivalency', 'Queried COURSE 101 equivalency'],
    ['Replaying the request', 'Replayed the request'],
    ['Queuing the export', 'Queued the export'],
    ['Cross-checking live results', 'Cross-checked live results'],
    ['Building the final process doc', 'Built the final process doc'],
    ['Looking up the course code', 'Looked up the course code'],
  ])('%s → %s', (running, done) => {
    expect(pastTense(running)).toBe(done)
  })

  it.each([
    'Reading tracker file and listing tabs',
    'Fixing and verifying paragraph formatting',
    'Pending grades review',
    'Morning schedule check',
    'String escaping audit',
    'Fetch ChatGPT conversation JSON',
  ])('leaves %s alone rather than guess', (phrase) => {
    expect(pastTense(phrase)).toBe(phrase)
  })
})

describe('thought labels', () => {
  it('keeps decimals, versions, and domains inside complete streamed sentences', () => {
    expect(thoughtLabel('I checked the assignment. It takes about 1.5–2x as long.', true).label)
      .toBe('It takes about 1.5–2x as long')
    expect(thoughtLabel('I checked the docs. Version 5.5 uses api.anthropic.com.', true).label)
      .toBe('Version 5.5 uses api.anthropic.com')
    expect(thoughtLabel('Reading the file. I found notes.md and report.v1.5.json.', true).label)
      .toBe('I found notes.md and report.v1.5.json')
  })

  it('gives verbose untitled Claude prose a compact disclosure title', () => {
    const text = "Since I don't know how long Assignment 1 actually took, I should suggest they verify the due date themselves and give a rough estimate that Assignment 2 will likely take about 1.5–2x as long."
    expect(thoughtLabel(text, true)).toEqual({ label: 'Thinking', placeholder: true, more: true })
    expect(thoughtLabel(text, false, 8800)).toEqual({ label: 'Reasoning summary', placeholder: false, more: true })
    expect(thoughtLabel(text.slice(0, -1), true).more).toBe(true)
    expect(isVerboseReasoning(text)).toBe(true)
    expect(isVerboseReasoning(`## Comparing the assignments\n\n${text}`)).toBe(false)
    expect(isVerboseReasoning('Checking the due dates.')).toBe(false)
  })

  it('recognizes Markdown headings without treating inline emphasis or code as titles', () => {
    expect(thoughtLabel('## Comparing assignments\n\nThe work should take **1.5–2x** as long.', false).label)
      .toBe('Comparing assignments')
    expect(thoughtLabel('**Reading the assignment**\n\n```md\n**Not a title**\n```', false).label)
      .toBe('Reading the assignment')
    expect(thoughtLabel('__Checking dates__\n\nRead the calendar.', false).label).toBe('Checking dates')
  })

  it('shows the latest bold headline, streaming or done', () => {
    const text = '**Planning the approach**\n\nI should start with the syllabus.\n\n**Checking due dates**\n\nThe calendar lists'
    expect(thoughtLabel(text, true)).toEqual({ label: 'Checking due dates', placeholder: false, more: true })
    expect(thoughtLabel(text, false).label).toBe('Checking due dates')
  })

  it('ticks through plain prose one complete sentence at a time', () => {
    expect(thoughtLabel('The course is on Example College Canvas. Let me check the mod', true).label).toBe('The course is on Example College Canvas')
    expect(thoughtLabel('The course is on Example College Canvas. Let me check the modules.', true).label).toBe('Let me check the modules')
  })

  it('says Thinking until a sentence is complete, and summarizes an empty thought by time', () => {
    expect(thoughtLabel('', true)).toMatchObject({ label: 'Thinking', placeholder: true })
    expect(thoughtLabel('Let me look at', true)).toMatchObject({ label: 'Thinking', placeholder: true })
    expect(thoughtLabel('', false, 3200)).toMatchObject({ label: 'Thought for 3.2s', placeholder: false })
  })

  it('shows a short finished thought whole, without markdown markers', () => {
    expect(thoughtLabel('Good, closed the `sandbox_exec` tab.', false)).toEqual({ label: 'Good, closed the sandbox_exec tab', placeholder: false, more: false })
  })
})
