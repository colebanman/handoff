import React, { Component, StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Feed } from '../../src/ui/components/Feed'
import { Composer } from '../../src/ui/components/Composer'
import { Header } from '../../src/ui/components/Header'
import { Settings } from '../../src/ui/components/Settings'
import { FilePanel } from '../../src/ui/components/FilePanel'
import { Onboarding } from '../../src/ui/components/Onboarding'
import { TaskTray } from '../../src/ui/components/TaskTray'
import { RateLimitBanner } from '../../src/ui/components/RateLimitBanner'
import { DeadTurnChip } from '../../src/ui/components/DeadTurnChip'
import { StepPromptBanner } from '../../src/ui/components/StepPromptBanner'
import { UserPromptCard } from '../../src/ui/components/UserPromptCard'
import { TranscriptList } from '../../src/ui/components/items'
import { DEFAULT_SETTINGS, type TranscriptItem, type AgentEvent } from '../../src/shared/types'
import { applyEvent } from '../../src/ui/reducer'
import { installPhaseLock } from '../../src/ui/phase-lock'
import { getRuntime } from '../../src/runtime'
import { App } from '../../src/ui/App'
import * as store from '../../src/ui/store'
import { settleTranscriptScope } from '../../src/shared/settle-transcript'
import '../../src/ui/theme.css'

type Scenario = {
  items: TranscriptItem[]; streaming?: boolean; pending?: boolean; feed?: boolean;
  shell?: boolean; chatId?: string; composer?: Record<string, unknown>; starters?: string[];
  startersPending?: boolean; configuring?: boolean; name?: string;
  waits?: Record<string, any>; rateLimit?: any; override?: any; dead?: any; step?: any;
  prompt?: any; tasks?: any[]; settings?: string; files?: boolean; onboarding?: boolean;
  origin?: any; contextUsage?: any;
}
const noop = () => {}
const errors: string[] = []
const animations: Array<{ name: string; node: number; cls: string; text: string; at: number }> = []
const nodeIds = new WeakMap<Element, number>()
let nodeId = 0
const identify = (el: Element) => {
  if (!nodeIds.has(el)) nodeIds.set(el, ++nodeId)
  return nodeIds.get(el)!
}
window.addEventListener('error', e => errors.push(e.message))
window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)))
document.addEventListener('animationstart', e => {
  const el = e.target as Element
  animations.push({ name: e.animationName, node: identify(el), cls: el.getAttribute('class') || '', text: el.textContent?.slice(0, 90) || '', at: performance.now() })
}, true)
installPhaseLock()

class Boundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { errors.push(error.message) }
  render() { return this.state.failed ? <div data-crash>Rendering failed</div> : this.props.children }
}

function Fixture({ s }: { s: Scenario }) {
  const [draft, setDraft] = useState('')
  const [settings, showSettings] = useState<string>()
  const [files, showFiles] = useState(false)
  const chatId = s.chatId || 'chat-a'
  return <div className="app">
    {s.shell && <Header chats={[{ id: chatId, title: 'Stress test conversation', createdAt: Date.now(), updatedAt: Date.now(), preview: '', origin: s.origin }]}
      currentId={chatId} runningChatIds={s.streaming ? [chatId] : []} settings={DEFAULT_SETTINGS} isRunning={!!s.streaming}
      contextUsage={s.contextUsage}
      transcriptCount={s.items.length} onNewChat={noop} onSelectChat={noop} onDeleteChat={noop} onOpenFiles={() => showFiles(true)} onOpenSettings={() => showSettings('account')} />}
    {s.feed || s.shell ? <Feed key={chatId} items={s.items} streaming={s.streaming} agentWaits={s.waits} onRevert={noop} onOpenFile={noop}
      starterPrompts={s.starters} starterPromptsPending={s.startersPending} configuring={s.configuring} userName={s.name} />
      : <div className="feed"><div className="feed__inner"><TranscriptList items={s.items} streaming={s.streaming} pending={s.pending} agentWaits={s.waits} onOpenFile={noop} /></div></div>}
    {s.rateLimit && <RateLimitBanner status={s.rateLimit} showGrokSwitch hasXaiKey modelOverride={s.override} onSwitchToGrok={noop} />}
    {s.dead && <DeadTurnChip status={s.dead} onRetry={noop} />}
    {s.step && <StepPromptBanner prompt={s.step} onAnswer={noop} />}
    {s.prompt && <UserPromptCard key={s.prompt.id} prompt={s.prompt} onAnswer={noop} />}
    <TaskTray tasks={s.tasks || []} transcript={s.items} onNudge={noop} onCancel={noop} />
    {s.shell && <Composer value={draft} isRunning={!!s.streaming} disabled={false} queuedCount={0} modelId={DEFAULT_SETTINGS.modelId}
      provider={DEFAULT_SETTINGS.provider} modelProviders={['openai', 'anthropic', 'xai', 'cerebras']} attachments={[]} browserContexts={[]} appshotBusy={false}
      onModelChange={noop} onChange={setDraft} onSend={noop} onSteer={noop} onClearSteering={noop} onClearQueue={noop} onStop={noop}
      onAttachFiles={noop} onRemoveAttachment={noop} onRemoveBrowserContext={noop} onAppshot={noop} onClearNotice={noop}
      onAcceptNextPrompt={noop} onDismissNextPrompt={noop} {...s.composer} />}
    {(s.settings || settings) && <Settings key={s.settings || settings} settings={DEFAULT_SETTINGS} initialSection={(s.settings || settings) as any} onSave={noop} onClose={() => showSettings(undefined)} onChatGPTConnectionChange={noop} onClaudeConnectionChange={noop} />}
    <FilePanel open={!!s.files || files} onClose={() => showFiles(false)} onAttach={noop} />
    {s.onboarding && <Onboarding />}
  </div>
}

const root = createRoot(document.getElementById('root')!)
let epoch = 0
let scenario: Scenario = { items: [], shell: true }
const render = (s: Scenario, reset = false) => {
  scenario = s
  if (reset) epoch++
  flushSync(() => root.render(<StrictMode><Boundary key={epoch}><Fixture s={s} /></Boundary></StrictMode>))
}
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const settle = async () => { await wait(380); await frame() }
const results: Array<{ name: string; ok: boolean; detail?: string }> = []
const check = (name: string, condition: unknown, detail?: unknown) => results.push({ name, ok: !!condition, ...(!condition ? { detail: typeof detail === 'string' ? detail : JSON.stringify(detail) } : {}) })
const overflow = () => Array.from(document.querySelectorAll<HTMLElement>('.app, .header, .feed, .feed__inner, .modal-scrim, [role="dialog"], [role="listbox"], .composer')).flatMap(el => {
  const box = el.getBoundingClientRect()
  if (!box.width || !box.height) return []
  return el.scrollWidth > el.clientWidth + 2 || box.right > innerWidth + 2 || box.left < -2
    ? [{ cls: el.className, width: box.width, scroll: el.scrollWidth, client: el.clientWidth, right: box.right }] : []
})
const health = (name: string) => {
  check(`${name}: renders`, !document.querySelector('[data-crash]'))
  check(`${name}: contained`, !overflow().length, overflow())
  const composer = document.querySelector('.composer')?.getBoundingClientRect()
  if (composer) check(`${name}: composer reachable`, composer.bottom <= innerHeight + 2 && composer.top >= 0, composer.toJSON())
}
const tool = (toolName: string, extra: Record<string, unknown> = {}): TranscriptItem => ({ kind: 'tool', id: 'tool', agentId: 'main', toolName, inputText: '', status: 'running', at: Date.now(), ...extra } as TranscriptItem)
const text = (content: string, streaming = false, id = 'text'): TranscriptItem => ({ kind: 'text', id, agentId: 'main', text: content, streaming, at: Date.now() })
const user = (content = 'Exercise the interface'): TranscriptItem => ({ kind: 'user', id: 'user', text: content, at: Date.now() })
const inputFor = (name: string) => ({
  tabId: 1, url: 'https://example.test/a/very/long/path?query=hello', ref: 'e1', text: 'Hello world',
  key: 'Enter', direction: 'down', pixels: 500, ms: 100, action: 'list', path: '/workspace/report.txt',
  code: 'const result = await api.page.snapshot(1);\nconsole.log(result)', intent: 'Reading the current page',
  task: 'Inspect the documentation', taskId: 'task-1', taskIds: ['task-1', 'task-2'],
  prompt: 'Inspect the documentation', message: 'Check the edge cases', question: 'Which version?',
  __target: { role: 'button', name: 'Save changes' }, fields: [{ ref: 'e1', text: 'Hello' }],
})

async function matrix(names: string[]) {
  const long = 'long_unbroken_value_'.repeat(100)
  for (const name of [...names, 'unknown_future_tool']) {
    const valid = inputFor(name)
    const cases: Array<{ label: string } & Record<string, unknown>> = [
      { label: 'empty-draft', inputStreaming: true },
      { label: 'partial-draft', inputStreaming: true, inputText: '{"intent":"Reading', input: { intent: 'Reading' } },
      { label: 'running', input: valid },
      ...[undefined, null, '', 0, false, 'plain', [], { unexpected: true }].map((input, i) => ({ label: `input-${i}`, input })),
      ...[undefined, null, '', false, 0, 'Done', { ok: true }, [], { nested: { rows: [1, 'value', null] } }, long,
        { error: 'Failed', isError: true }, { content: [{ type: 'text', text: 'A content block' }] },
        { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', mimeType: 'image/png' },
        { base64: 'not-a-valid-image', mimeType: 'image/jpeg' },
      ].map((output, i) => ({ label: `output-${i}`, input: valid, status: 'done', output, durationMs: i === 0 ? 0 : 215 })),
      { label: 'error-string', input: valid, status: 'error', output: long },
      { label: 'error-object', input: valid, status: 'error', output: { error: { message: 'Permission denied' } } },
      { label: 'long-input', input: { ...valid, intent: long, code: long, path: `/workspace/${long}.txt`, prompt: long } },
    ]
    for (const { label, ...data } of cases) {
      render({ items: [tool(name, data)], streaming: data.status !== 'done' && data.status !== 'error' }, true)
      await frame()
      // Open every supported renderer, including delegation and workflow dialogs.
      const button = document.querySelector<HTMLButtonElement>('.step__head:not(:disabled), button.subagent-card, button.workflow-card')
      if (button) flushSync(() => button.click())
      await frame()
      health(`${name}/${label}`)
    }
  }
}

async function transitions(names: string[]) {
  for (const name of names.filter(n => !['subagent_spawn', 'workflow_run'].includes(n))) {
    render({ items: [user()], streaming: true, pending: true }, true)
    await settle()
    const block = document.querySelector('.activity')
    const id = `call-${name}`
    let items = applyEvent([user()], { type: 'tool-input-start', agentId: 'main', toolName: name, toolCallId: id })
    render({ items, streaming: true })
    await frame()
    const row = document.querySelector('.step:not(.step--pending)')
    const pulse = row?.querySelector('.step__pulse')
    check(`${name}: pending block preserved`, block === document.querySelector('.activity'))
    const json = JSON.stringify(inputFor(name))
    for (let offset = 0; offset < json.length; offset += 17) {
      items = applyEvent(items, { type: 'tool-input-delta', agentId: 'main', toolCallId: id, delta: json.slice(offset, offset + 17) })
      render({ items, streaming: true })
      await frame()
      check(`${name}: streamed row preserved ${offset}`, row === document.querySelector('.step:not(.step--pending)'))
      check(`${name}: busy indicator preserved ${offset}`, pulse === row?.querySelector('.step__pulse'))
    }
    items = applyEvent(items, { type: 'tool-call', agentId: 'main', toolName: name, toolCallId: id, input: inputFor(name) })
    render({ items, streaming: true })
    await frame()
    check(`${name}: execute preserves busy indicator`, pulse === row?.querySelector('.step__pulse'))
    items = applyEvent(items, { type: 'tool-result', agentId: 'main', toolName: name, toolCallId: id, output: { ok: true }, durationMs: 12 })
    render({ items, streaming: true })
    await settle()
    check(`${name}: result preserves row`, row === document.querySelector('.step:not(.step--pending)'))
    check(`${name}: busy indicator removed`, !row?.querySelector('.step__pulse'))
    check(`${name}: old labels removed`, row?.querySelectorAll('.swap__item').length === 1)
    health(`${name}/lifecycle`)
  }
}

async function markdown() {
  const cases = [
    'Hello world. This is a streamed paragraph with multiple words.',
    '**Checking the result**\n\nThe answer has *emphasis*, `code`, and a [link](https://example.test).',
    '# Heading\n\n- First item\n- Second item\n\n> Quoted text\n\n---\n\nFinal paragraph.',
    '| Name | Value |\n| --- | --- |\n| First | 12 |\n| Second | **24** |',
    '```typescript\nconst value = { hello: "world" }\nconsole.log(value)\n```\n\nAll done.',
    'Inline $E=mc^2$ and display math:\n\n$$\n\\frac{1}{2} + \\sqrt{4}\n$$\n',
    'Unicode 👨‍👩‍👧‍👦 你好 café مرحبا é text.\n\n' + 'https://example.test/'.repeat(35),
    '[incomplete link](https://example.test/unfinished',
  ]
  for (const [index, content] of cases.entries()) {
    render({ items: [text('', true)] }, true)
    for (let n = 1; n <= content.length; n += 3) {
      render({ items: [text(content.slice(0, n), true)] })
      await frame()
      check(`markdown-${index}/${n}: caret unique`, document.querySelectorAll('.assistant__caret').length <= 1)
    }
    render({ items: [text(content, false)] })
    await settle()
    check(`markdown-${index}: settled caret removed`, !document.querySelector('.assistant__caret'))
    check(`markdown-${index}: reveal wrappers removed`, !document.querySelector('.md-word'))
    health(`markdown-${index}`)
  }
  // Existing words must keep their DOM node and must not run a second fade.
  render({ items: [text('First', true)] }, true)
  await settle()
  const first = document.querySelector('.md-word')
  const start = animations.length
  for (const content of ['First second', 'First second third', 'First second third\n\nNew paragraph', 'First second third\n\nNew paragraph grows']) {
    render({ items: [text(content, true)] })
    await frame()
    check('markdown: earlier word identity', document.querySelector('.md-word') === first)
  }
  check('markdown: earlier word never fades twice', !animations.slice(start).some(a => a.node === identify(first!)), animations.slice(start))
}

async function surfaces() {
  const at = Date.now()
  const shell = { items: [user(), text('Ready to help.')], shell: true }
  const cases: Array<[string, Partial<Scenario>]> = [
    ['empty', { items: [] }], ['suggestions-loading', { items: [], startersPending: true }],
    ['suggestions-partial', { items: [], startersPending: true, starters: ['Find information'] }],
    ['suggestions', { items: [], starters: ['Read the page', 'Write a report', 'Compare the options', 'Summarize these tabs'] }],
    ['long-greeting', { items: [], name: 'Alexandria'.repeat(18) }],
    ['configuring', { items: [], configuring: true, composer: { disabled: true } }],
    ['running', { streaming: true, composer: { runStartedAt: at - 7200000 } }],
    ['external-origin', { origin: { kind: 'external', client: 'Long external agent name'.repeat(8), at }, contextUsage: { modelId: DEFAULT_SETTINGS.modelId, usage: { inputTokens: 499999, outputTokens: 123456 } } }],
    ['legacy-origin-date', { origin: { kind: 'external', client: 'Earlier client' } }],
    ['queued', { streaming: true, composer: { queuedCount: 100, pendingSteering: 'x'.repeat(1000), value: 'Follow-up' } }],
    ['composer-long', { composer: { value: 'unbroken'.repeat(1000) } }],
    ['next-prompt', { composer: { nextPrompt: 'Tell me more about the result and explain the next steps.' } }],
    ['attachment-notice', { composer: { attachmentNotice: 'Unable to read this file: ' + 'long'.repeat(100) } }],
    ['capture-busy', { composer: { appshotBusy: true } }],
    ...['connection', 'interrupted', 'review', undefined].map(kind => [`recovery-${kind}`, { dead: { at, kind } }] as [string, Partial<Scenario>]),
    ...[0, 500, 9999, 59999, 60000, 119999, 3600000].map(delay => [`rate-${delay}`, { rateLimit: { retryAt: at + delay, attempt: 100 } }] as [string, Partial<Scenario>]),
    ['offline', { rateLimit: { kind: 'connection', offline: true, retryAt: at, attempt: 1 } }],
    ['reconnect', { rateLimit: { kind: 'connection', retryAt: at, attempt: 1 } }],
    ...['all', 'subagents'].map(scope => [`override-${scope}`, { rateLimit: { retryAt: at, attempt: 2 }, override: { modelId: 'grok-4.6', scope } }] as [string, Partial<Scenario>]),
    ['checkpoint', { step: { steps: 99999, at } }],
    ['prompt', { prompt: { id: 'prompt', kind: 'question', title: 'Select an option', detail: 'Description '.repeat(100), allowNotes: true, allowAlways: true,
      fields: [{ id: 'choice', kind: 'choice', label: 'Choice', required: true, options: [{ id: 'one', label: 'First choice' }, { id: 'two', label: 'Long'.repeat(80) }] }, { id: 'text', kind: 'text', label: 'Details', required: true }],
      actions: [{ id: 'submit', label: 'Submit', requiresFields: true, tone: 'primary' }, { id: 'skip', label: 'Skip' }] } }],
    ...['running', 'cancelling', 'done', 'error', 'cancelled', 'orphaned'].map(status => [`task-${status}`, { tasks: [{ id: 't', kind: 'subagent', agentId: 'sub-1', description: 'Task'.repeat(100), status, startedAt: at - 6000, endedAt: at }] }] as [string, Partial<Scenario>]),
    ...['account', 'behavior', 'instructions', 'automations', 'appearance'].map(settings => [`settings-${settings}`, { settings }] as [string, Partial<Scenario>]),
    ['files', { files: true }], ['onboarding', { onboarding: true }],
    ...['running', 'done', 'error', 'cancelled'].map(status => [`compaction-${status}`, { items: [{ kind: 'compaction', id: 'compact', agentId: 'main', status }] }] as [string, Partial<Scenario>]),
    ['error', { items: [{ kind: 'error', id: 'error', agentId: 'main', message: 'Failure'.repeat(500), at }] }],
    ['memory', { items: [{ kind: 'memory', id: 'memory', agentId: 'main', titles: ['A preference'.repeat(100)], forgotten: ['Another fact'], at }] }],
    ['user-long', { items: [user('LongText'.repeat(1000))] }],
    ['user-attachments', { items: [{ ...user(), attachments: [{ id: 'file', kind: 'file', path: '/workspace/report.pdf', name: 'report'.repeat(80) + '.pdf', mediaType: 'application/pdf' }], source: { kind: 'artifact', path: '/workspace/test.html' } }] as TranscriptItem[] }],
  ]
  for (const [name, extra] of cases) {
    render({ ...shell, ...extra }, true)
    await settle()
    health(name)
  }
}

async function delegation() {
  for (const status of ['running', 'done', 'error'] as const) {
    for (const children of [[], [text('Streaming child reply', true)], [tool('browser_click', { status: 'running', input: inputFor('browser_click') })]]) {
      const item = tool('subagent_spawn', { input: { task: 'Inspect documentation' }, status: 'done', childStatus: status, childAgentId: 'sub-1', childItems: children })
      render({ items: [item], streaming: status === 'running' }, true)
      await settle()
      const trigger = document.querySelector<HTMLButtonElement>('button.subagent-card')!
      flushSync(() => trigger.click())
      await settle()
      check(`subagent-${status}: modal visible`, !!document.querySelector('[role="dialog"]'))
      health(`subagent-${status}`)
      if (status !== 'running') check(`subagent-${status}: no stale busy UI`, !document.querySelector('[role="dialog"] .step__pulse, [role="dialog"] .assistant__caret'))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await frame()
      check(`subagent-${status}: escape closes`, !document.querySelector('[role="dialog"]'))
    }
  }
  for (const status of ['running', 'done', 'error', 'cancelled', 'orphaned']) {
    const workflow = { runId: 'wf', meta: { title: 'Review the project', description: 'Work in stages', phases: [{ id: 'review', title: 'Review' }, { id: 'finish', title: 'Finish' }] },
      sourcePath: '/workspace/workflow.js', status, startedAt: Date.now() - 5000, endedAt: status === 'running' ? undefined : Date.now(), currentPhaseId: 'review',
      logs: [{ at: Date.now(), message: 'Checking details '.repeat(70) }], agents: [{ callId: 'agent', agentId: 'sub', label: 'Reviewer', prompt: 'Review the code', phaseId: 'review', status: status === 'running' ? 'running' : 'done', startedAt: Date.now() - 3000, items: [text('Review findings')], result: 'Complete' }], usage: { totalTokens: 10000 }, result: 'Complete' }
    render({ items: [tool('workflow_run', { workflow, status: status === 'running' ? 'running' : 'done' })] }, true)
    await settle()
    const trigger = document.querySelector<HTMLButtonElement>('button.workflow-card')
    if (trigger) flushSync(() => trigger.click())
    await settle()
    check(`workflow-${status}: modal visible`, !!document.querySelector('[role="dialog"]'))
    health(`workflow-${status}`)
  }
}

async function continuity() {
  // Folding a finished step into a cluster preserves the first row and disclosure.
  let items = [tool('browser_click', { id: 'first', input: inputFor('browser_click'), status: 'done' })]
  render({ items, streaming: true }, true)
  await settle()
  const first = document.querySelector('.step')
  flushSync(() => document.querySelector<HTMLButtonElement>('.step__head')!.click())
  items = [...items, tool('browser_click', { id: 'second', input: inputFor('browser_click'), status: 'done' })]
  render({ items, streaming: true, pending: true })
  await settle()
  check('cluster preserves first row', first === document.querySelector('.step'))
  check('cluster preserves open disclosure', first?.classList.contains('step--open'))
  for (let n = 0; n < 12; n++) {
    flushSync(() => document.querySelector<HTMLButtonElement>('.activity__header')!.click())
    await wait(25)
  }
  await settle()
  check('rapid disclosure leaves one body', document.querySelectorAll('.activity__body').length === 1)
  check('rapid disclosure clears outgoing labels', Array.from(document.querySelectorAll('.step__line')).every(line => line.querySelectorAll(':scope > .swap__item').length === 1))

  // Removing an empty/restarted model part must not remount later activity.
  const before = [text('Uncommitted'), tool('browser_click', { id: 'retained', input: inputFor('browser_click') })]
  render({ items: before, streaming: true }, true)
  await settle()
  const retained = document.querySelector('.step')
  render({ items: before.slice(1), streaming: true })
  await frame()
  check('connection restart preserves retained activity', retained === document.querySelector('.step'))

  // Different history in the same positional slot must not inherit a disclosure.
  render({ items: [tool('browser_click', { id: 'old', status: 'done', input: inputFor('browser_click') })] }, true)
  await settle()
  flushSync(() => document.querySelector<HTMLButtonElement>('.step__head')!.click())
  render({ items: [tool('browser_navigate', { id: 'new', status: 'done', input: inputFor('browser_navigate') })] })
  await settle()
  check('replacement history closes old disclosure', !document.querySelector('.step--open'))

  // Autoscroll stays attached through height animation; reading history stays detached.
  const history = Array.from({ length: 30 }, (_, i) => text(`Message ${i}\n\n` + 'A paragraph of content. '.repeat(12), false, `t${i}`))
  render({ items: history, feed: true }, true)
  await settle()
  const feed = document.querySelector<HTMLElement>('.feed')!
  check('feed initially pinned', feed.scrollHeight - feed.scrollTop - feed.clientHeight < 3)
  feed.scrollTop = 10
  feed.dispatchEvent(new Event('scroll', { bubbles: true }))
  await frame()
  render({ items: [...history, tool('browser_click', { input: inputFor('browser_click') })], streaming: true, feed: true })
  await settle()
  check('feed preserves reader position', Math.abs(feed.scrollTop - 10) < 3, feed.scrollTop)
  check('feed offers jump to latest', !!document.querySelector('.jump-latest'))
  flushSync(() => document.querySelector<HTMLButtonElement>('.jump-latest')!.click())
  await settle()
  check('jump repins', feed.scrollHeight - feed.scrollTop - feed.clientHeight < 3)
}

async function app() {
  const setState = (store as any).__uiStressSetState
  const previous = store.readState()
  const record = (id: string) => ({ id, title: id, modelId: DEFAULT_SETTINGS.modelId, messages: [], createdAt: Date.now(), updatedAt: Date.now(),
    transcript: Array.from({ length: 20 }, (_, n) => text(`Chat ${id}, message ${n}. ` + 'Paragraph '.repeat(60), false, `${id}-${n}`)) })
  setState({ loaded: true, current: record('a'), settings: { ...DEFAULT_SETTINGS, theme: document.documentElement.dataset.theme }, runningChatIds: [], showOnboarding: false })
  flushSync(() => root.render(<StrictMode><App /></StrictMode>))
  await settle()
  let feed = document.querySelector<HTMLElement>('.feed')!
  feed.scrollTop = 10
  feed.dispatchEvent(new Event('scroll', { bubbles: true }))
  flushSync(() => setState({ current: record('b') }))
  await settle()
  feed = document.querySelector<HTMLElement>('.feed')!
  check('App: switching chats starts at latest', feed.scrollHeight - feed.scrollTop - feed.clientHeight < 3, { top: feed.scrollTop, height: feed.scrollHeight, client: feed.clientHeight })
  const picker = document.querySelector<HTMLButtonElement>('.model-picker__trigger')
  check('App: model picker available', !!picker)
  if (picker) {
    flushSync(() => picker.click())
    await frame()
    check('App: model menu opened', !!document.querySelector('[role="listbox"]'))
    flushSync(() => setState({ current: record('c') }))
    await settle()
    check('App: chat switch dismisses previous menu', !document.querySelector('[role="listbox"]'))
  }
  health('App')
  render({ items: [] }, true)
  setState(previous)
}

async function reasoning() {
  const thought = (content: string, streaming = true): TranscriptItem => ({ kind: 'reasoning', id: 'reasoning', agentId: 'main', text: content, streaming, at: Date.now() })
  render({ items: [thought('# Checking')], streaming: true }, true)
  await settle()
  const label = document.querySelector('.step__line > .swap__item')
  for (const content of ['# Checking the', '# Checking the layout', '# Checking the layout\n\nBody text.']) {
    render({ items: [thought(content)], streaming: true })
    await frame()
    check('reasoning: growing heading does not crossfade', document.querySelectorAll('.step__line > .swap__item').length === 1)
    check('reasoning: growing heading preserves label', document.querySelector('.step__line > .swap__item') === label)
  }
  for (const content of ['', ' ', '**Checking the page**', 'A short sentence.', 'A very long unfinished summary '.repeat(30), '# Heading\n\nDetails\n\n# Another heading']) {
    render({ items: [thought(content)], streaming: true }, true)
    await settle()
    health('reasoning/live')
    render({ items: [thought(content, false)], streaming: false })
    await settle()
    check('reasoning: settles without busy indicator', !document.querySelector('.step__pulse'))
    health('reasoning/settled')
  }
  // The real feed suppresses brief thinking rows after a tool and after prose.
  render({ items: [user()], streaming: true, feed: true }, true)
  await frame()
  check('pending: immediate after send', !!document.querySelector('.step--pending'))
  render({ items: [user(), tool('browser_click', { input: inputFor('browser_click') })], streaming: true, feed: true })
  await settle()
  check('pending: removed during execution', !document.querySelector('.step--pending'))
  render({ items: [user(), tool('browser_click', { status: 'done', input: inputFor('browser_click') })], streaming: true, feed: true })
  await wait(80)
  check('pending: brief gaps stay quiet', !document.querySelector('.step--pending'))
  await wait(400)
  check('pending: long gap appears', !!document.querySelector('.step--pending'))
  render({ items: [user(), text('Finished.')], streaming: true, feed: true })
  await wait(400)
  check('pending: finished prose gets a longer pause', !document.querySelector('.step--pending'))
  render({ items: [user(), text('Finished.')], streaming: false, feed: true })
  await wait(750)
  check('pending: completion cancels delayed indicator', !document.querySelector('.step--pending'))
}

async function actions(paths: string[]) {
  const snippets = paths.map(path => path.startsWith('api.')
    ? `${path}(1, "e1", "value", {url:"https://example.test", path:"/workspace/report.md"})`
    : `api.cdp(1, ${JSON.stringify(path)}, {type:"mousePressed", text:"hello", key:"Enter", url:"https://example.test", expression:"document.body.textContent"})`)
  snippets.push(...[
    'api.fs.readText("/workspace/a.txt")', 'api.fs.writeText("/workspace/a.txt", "hello")', 'api.fs.list("workspace")',
    'api.artifacts.validate("/workspace/a.html")', 'api.automations.list()', 'api.stickies.list()', 'api.extensions.list()',
    'api.pdf.create()', 'api.zip.create()', 'apps.docs.update("hello")', 'await new Promise(r => setTimeout(r, 100))',
    'api.page.eval(1, "document.querySelector(\"button\").click()")',
    'api.page.eval(1, "document.querySelector(\"input\").value = \'hello\'")',
    'api.fetch("https://example.test", {method:"POST"})',
    '/* api.page.click(1, "e1") */ const str="api.tabs.close()";',
    'const text = "'.padEnd(90000, 'x') + '"; api.page.snapshot(1)',
  ])
  for (const [index, code] of snippets.entries()) {
    for (const state of ['drafting', 'running', 'done', 'error']) {
      render({ items: [tool('sandbox_exec', { input: { code }, inputText: JSON.stringify({ code }), inputStreaming: state === 'drafting', status: state === 'drafting' ? 'running' : state,
        output: state === 'error' ? { error: { code: 'TIMEOUT', message: 'The operation timed out' } } : undefined })], streaming: state === 'running' || state === 'drafting' }, true)
      await frame()
      health(`action-${index}/${state}`)
    }
  }
  for (const action of ['list', 'create', 'close', 'activate', 'future']) {
    for (const status of ['running', 'done', 'error']) {
      render({ items: [tool('browser_tabs', { input: { action, url: 'https://example.test' }, status })] }, true)
      await frame()
      health(`tabs-${action}/${status}`)
    }
  }
}

async function interactions() {
  render({ items: [user(), text('Ready.')], shell: true }, true)
  const click = async (selector: string) => {
    const el = document.querySelector<HTMLElement>(selector)
    check(`interaction: ${selector} exists`, !!el)
    if (el) flushSync(() => el.click())
    await settle()
  }
  await click('.model-picker__trigger')
  check('model picker: menu visible', !!document.querySelector('[role="listbox"]'))
  health('model-menu')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  check('model picker: escape closes', !document.querySelector('[role="listbox"]'))
  await click('button[title="Settings"]')
  health('settings-opened')
  for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'))) {
    flushSync(() => tab.click())
    await settle()
    health(`settings-tab/${tab.textContent}`)
  }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  const vfs = getRuntime().vfs
  await vfs.writeText('/workspace/stress-report.md', '# Fixture\n\n| Name | Result |\n| --- | --- |\n| Test | Passed |')
  await vfs.writeText('/workspace/stress-code.js', 'const message = "Hello world";\n'.repeat(100))
  await vfs.writeText('/workspace/stress.json', JSON.stringify({ result: 'value'.repeat(300) }))
  await click('button[title="Files"]')
  health('file-panel')
  check('file panel: renders saved files', document.body.textContent?.includes('stress-report.md'))
  // A question must retain a manual field choice through unrelated streaming updates.
  const prompt = { id: 'q', kind: 'question', title: 'Select', fields: [{ id: 'choice', kind: 'choice', label: 'Choice', required: true, options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }], actions: [{ id: 'send', label: 'Send', requiresFields: true }] }
  render({ items: [user()], shell: true, prompt }, true)
  await settle()
  check('question: submit disabled before selection', document.querySelector<HTMLButtonElement>('.user-prompt__btn')?.disabled)
  await click('.user-prompt__pill')
  render({ items: [user(), text('Working', true)], shell: true, prompt, streaming: true })
  await settle()
  check('question: selection survives stream', document.querySelector('.user-prompt__pill')?.getAttribute('aria-pressed') === 'true')
  check('question: submit enabled after selection', !document.querySelector<HTMLButtonElement>('.user-prompt__btn')?.disabled)
  render({ items: [user()], shell: true, prompt: { ...prompt, id: 'new-question' } })
  await settle()
  check('question: new id resets selection', document.querySelector<HTMLButtonElement>('.user-prompt__btn')?.disabled)
}

async function stress(names: string[]) {
  let seed = 0x5eed1234
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32 }
  const plain = names.filter(n => !['subagent_spawn', 'workflow_run'].includes(n))
  for (let run = 0; run < 30; run++) {
    let items: TranscriptItem[] = [user(`Stress run ${run}`)]
    render({ items, streaming: true, feed: true }, true)
    for (let step = 0; step < 12; step++) {
      const name = plain[Math.floor(random() * plain.length)]!
      const id = `run-${run}-tool-${step}`
      const events: AgentEvent[] = [
        { type: 'tool-input-start', agentId: 'main', toolName: name, toolCallId: id },
        { type: 'tool-input-delta', agentId: 'main', toolCallId: id, delta: '{"intent":"Checking' },
        { type: 'tool-call', agentId: 'main', toolName: name, toolCallId: id, input: inputFor(name) },
        { type: 'tool-result', agentId: 'main', toolName: name, toolCallId: id, output: random() < .3 ? { error: 'Timed out' } : { ok: true }, durationMs: 1 },
      ]
      // Abort at every phase, batch bursts, and interleave prose/compaction.
      const stopAt = run % 4 === 0 && step === 11 ? run % 3 + 1 : events.length
      for (const event of events.slice(0, stopAt)) {
        items = applyEvent(items, event)
        render({ items, streaming: true, feed: true })
        if (random() > .45) await frame()
        health(`seed-${run}/${step}/${event.type}`)
      }
      if (step % 4 === 0) {
        items = [...items, text(`Progress ${step}: **checking** the next result.`, false, `progress-${step}`)]
        render({ items, streaming: true, feed: true })
      }
      if (step === 6) {
        items = applyEvent(items, { type: 'compaction', agentId: 'main', id: 'compaction', status: 'running' })
        render({ items, streaming: true, feed: true })
        await frame()
        items = applyEvent(items, { type: 'compaction', agentId: 'main', id: 'compaction', status: run % 2 ? 'done' : 'cancelled' })
      }
    }
    items = settleTranscriptScope(items)
    render({ items, streaming: false, feed: true })
    await settle()
    check(`seed-${run}: stop leaves no busy UI`, !document.querySelector('.step__pulse, .assistant__caret, .step--pending'))
    // Snapshot rehydration changes object identities, but must not replay entrances.
    const start = animations.length
    render({ items: structuredClone(items), streaming: false, feed: true })
    await frame(); await frame()
    check(`seed-${run}: replayed snapshot does not reanimate`, animations.length === start, animations.slice(start))
    check(`seed-${run}: no duplicate labels after settling`, Array.from(document.querySelectorAll('.step__line')).every(line => line.querySelectorAll(':scope > .swap__item').length === 1))
  }
}

async function motion() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  render({ items: [user()], streaming: true, pending: true }, true)
  await settle()
  const phase = () => {
    const animation = document.querySelector('.step__pulse')?.getAnimations()[0]
    if (!animation?.effect) return null
    const timing = animation.effect.getTiming()
    return { phase: ((Number(animation.currentTime) - (timing.delay ?? 0)) % Number(timing.duration)), at: performance.now(), period: Number(timing.duration) }
  }
  const before = phase()
  render({ items: [user(), tool('browser_click', { input: inputFor('browser_click') })], streaming: true })
  await frame(); await frame(); await frame()
  const after = phase()
  if (!reduced) {
    check('motion: ambient animation available', !!before && !!after)
    if (before && after) {
      const expected = (before.phase + after.at - before.at) % after.period
      const diff = Math.abs(expected - after.phase)
      check('motion: breathing phase survives thinking handoff', Math.min(diff, after.period - diff) < 65, { before, after, diff })
    }
  } else {
    check('motion: no perpetual animations when reduced', !document.getAnimations().some(a => a.effect?.getTiming().iterations === Infinity))
  }
  // A fresh running/done/running handoff must not leave permanent outgoing labels.
  for (let n = 0; n < 12; n++) {
    render({ items: [user(), tool('browser_click', { input: inputFor('browser_click'), status: n % 2 ? 'running' : 'done' })], streaming: true })
    await wait(25)
  }
  await settle()
  check('motion: interrupted phase swaps settle to one label', document.querySelectorAll('.step__line > .swap__item').length === 1)
  health('motion')
}

async function motionPreferencePrepare() {
  render({ items: [tool('browser_click', { input: inputFor('browser_click') })], streaming: true }, true)
  await settle()
}
async function motionPreferenceFinish() {
  const start = results.length
  await wait(80)
  render({ items: [tool('browser_click', { input: inputFor('browser_click'), status: 'done' })] })
  await frame(); await frame()
  check('live preference: reduced motion is active', matchMedia('(prefers-reduced-motion: reduce)').matches)
  const running = document.getAnimations().filter(animation => animation.playState === 'running' && Number(animation.effect?.getTiming().duration) > 1)
  check('live preference: existing rows switch to instant transitions', running.length === 0, running.map(animation => ({ duration: animation.effect?.getTiming().duration, target: (animation.effect as KeyframeEffect).target?.getAttribute('class') })))
  return { suite: 'motion-change', checks: results.length - start, failures: results.slice(start).filter(result => !result.ok), errors: [...new Set(errors)] }
}

Object.assign(window, { uiStress: {
  render, tool, text, user, inputFor, results, errors, animations, health, overflow, motionPreferencePrepare, motionPreferenceFinish,
  get scenario() { return scenario },
  async run(suite: string, names: string[] = []) {
    const start = results.length
    if (suite === 'matrix') await matrix(names)
    if (suite === 'transitions') await transitions(names)
    if (suite === 'markdown') await markdown()
    if (suite === 'surfaces') await surfaces()
    if (suite === 'delegation') await delegation()
    if (suite === 'continuity') await continuity()
    if (suite === 'app') await app()
    if (suite === 'reasoning') await reasoning()
    if (suite === 'actions') await actions(names)
    if (suite === 'interactions') await interactions()
    if (suite === 'stress') await stress(names)
    if (suite === 'motion') await motion()
    return { suite, checks: results.length - start, failures: results.slice(start).filter(r => !r.ok), errors: [...new Set(errors)] }
  },
} })
render(scenario)
