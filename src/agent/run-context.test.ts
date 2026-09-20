import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { simulateReadableStream, type ModelMessage } from 'ai'
import { DEFAULT_SETTINGS, type Settings, type VirtualFileSystemService, type VfsEntry } from '../shared/types'
import { isRuntimeContextText } from '../shared/context-blocks'
import { formatSiteMemory, SITE_MEMORY_PATH } from './site-memory'
import { resolveModel, resolveModelAccess } from './models'
import { runLoop, type RunLoopOptions } from './run'
import { AgentLoopRestartError } from './model-switch'
import { renderBrowserSnapshot, parseBrowserSnapshotDelta } from '../shared/browser-snapshot'

vi.mock('./models', () => ({ resolveModel: vi.fn(), resolveModelAccess: vi.fn() }))

type StreamPart = Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }
const guidePath = '/workspace/sites/canvas.md'
const oldMemory = { title: 'Canvas course context', scopes: ['school.instructure.com/**'], body: 'Old summary.', guide: guidePath, triggers: ['canvas'], date: '2026-09-11' }

function setup() {
  let clock = 1
  const records = new Map<string, { text: string; entry: VfsEntry }>()
  const write = async (path: string, text: string) => {
    const entry: VfsEntry = { path, root: 'workspace', name: path.split('/').at(-1)!, mediaType: 'text/markdown', size: text.length, createdAt: 1, updatedAt: clock++ }
    records.set(path, { text, entry })
    return entry
  }
  const vfs = {
    summary: async () => ({ entries: [...records.values()].map((r) => r.entry), skills: [] }),
    getEntry: async (path: string) => records.get(path)?.entry,
    readText: async (path: string) => ({ path, text: records.get(path)?.text ?? '', truncated: false, totalChars: records.get(path)?.text.length ?? 0 }),
    writeText: write,
  } as unknown as VirtualFileSystemService
  const settings: Settings = { ...DEFAULT_SETTINGS, provider: 'openai', modelId: 'context-test' }
  vi.mocked(resolveModelAccess).mockResolvedValue({ settings })
  vi.stubGlobal('chrome', { tabs: { query: async () => [{ id: 1, active: true, url: 'https://school.instructure.com/courses/123' }] } })
  const options: RunLoopOptions = {
    ctx: { agentId: 'main', currentTabId: 1 }, settings, modelId: settings.modelId,
    messages: [{ role: 'user', content: 'Check Canvas and remember the useful procedure.' }],
    signal: new AbortController().signal, emit: vi.fn(),
    deps: { vfs, cdp: {} as RunLoopOptions['deps']['cdp'], sandbox: {} as RunLoopOptions['deps']['sandbox'] },
    spawnSubagent: async () => '', tasks: {} as RunLoopOptions['tasks'], sandboxSessionId: 'test-context', isSubagent: false,
  }
  return { write, options }
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('runtime context through the real SDK tool loop', () => {
  it('sends snapshot changes on the third model call but persists full snapshots for resume', async () => {
    const { options } = setup()
    let revision = 0
    options.deps.cdp.snapshot = async () => ({ tabId: 1, title: 'Form', url: 'https://example.test', text: renderBrowserSnapshot({
      tabId: 1, document: 'live', revision: ++revision, header: 'URL https://example.test | title Form | tab 1',
      lines: Array.from({ length: 40 }, (_, i) => `[elive-${i + 1}] textbox "Field ${i}" value="${i === 0 ? revision : ''}"`),
    }) })
    let calls = 0
    const model = new MockLanguageModelV3({ doStream: async () => ({
      stream: simulateReadableStream<StreamPart>({ initialDelayInMs: null, chunkDelayInMs: null, chunks: ++calls <= 2 ? [
        { type: 'tool-call', toolCallId: `snapshot-${calls}`, toolName: 'browser_snapshot', input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
      ] : [
        { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'Field updated.' },
        { type: 'text-end', id: 'answer' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ] }),
    }) })
    vi.mocked(resolveModel).mockReturnValue(model)
    const result = await runLoop(options)
    expect(result.errorText).toBeUndefined()
    expect(result.stepCount).toBe(3)
    const sent = model.doStreamCalls[2]!.prompt.filter((m) => m.role === 'tool')
    const latest = (sent.at(-1)!.content[0] as { output: { type: string; value: string } }).output
    expect(latest.type).toBe('text')
    expect(parseBrowserSnapshotDelta((latest as { value: string }).value)?.revision).toBe(2)
    const saved = JSON.stringify(result.responseMessages)
    expect(saved).not.toContain('Browser changes v1')
    expect(saved).toContain('revision=1')
    expect(saved).toContain('revision=2')
    let checkpointed: ModelMessage[] = []
    await runLoop({ ...options, messages: [...options.messages, ...result.responseMessages as ModelMessage[], { role: 'user', content: 'Continue' }],
      onStepMessages: (messages) => { checkpointed = messages },
    })
    const persistedTools = checkpointed.filter((message) => message.role === 'tool')
    expect(JSON.stringify(persistedTools)).toContain('revision=1')
    expect(JSON.stringify(persistedTools)).not.toContain('superseded')
  })

  it('refreshes memory after an actual tool write and persists the exact append-only context for resume', async () => {
    const { write, options } = setup()
    await write(guidePath, '# Verified procedure\nUse the supported API and save attachments into VFS.')
    await write(SITE_MEMORY_PATH, formatSiteMemory([oldMemory]))
    const snapshots: ModelMessage[][] = []
    options.onStepMessages = (messages) => snapshots.push(messages)
    let calls = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        calls += 1
        return {
          stream: simulateReadableStream<StreamPart>({ initialDelayInMs: null, chunkDelayInMs: null, chunks: calls === 1 ? [
            { type: 'tool-call' as const, toolCallId: 'save-method', toolName: 'memory_write', input: JSON.stringify({ memories: [{ ...oldMemory, body: 'Corrected summary: combine course records, import attachments, then view saved files.' }] }) },
            { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage },
          ] : [
            { type: 'text-start' as const, id: 'answer' },
            { type: 'text-delta' as const, id: 'answer', delta: 'Saved the reusable method.' },
            { type: 'text-end' as const, id: 'answer' },
            { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
          ] }),
        }
      },
    })
    vi.mocked(resolveModel).mockReturnValue(model)
    const original = JSON.stringify(options.messages)
    const result = await runLoop(options)
    expect(result.errorText).toBeUndefined()
    expect(result.stepCount).toBe(2)
    expect(model.doStreamCalls).toHaveLength(2)
    const first = model.doStreamCalls[0]!.prompt
    const second = model.doStreamCalls[1]!.prompt
    expect(JSON.stringify(first)).toContain('Old summary.')
    expect(JSON.stringify(second)).toContain('Corrected summary:')
    expect(second.slice(0, first.length)).toEqual(first)
    expect(second.filter((m) => m.role === 'system')).toEqual(first.filter((m) => m.role === 'system'))
    expect(JSON.stringify(first.filter((m) => m.role === 'system'))).not.toContain('Old summary.')
    expect(JSON.stringify(options.messages)).toBe(original)
    const updates = (result.responseMessages as ModelMessage[]).filter((m) => typeof m.content === 'string' && isRuntimeContextText(m.content))
    expect(updates).toHaveLength(2)
    expect(snapshots.at(-1)).toEqual([...options.messages, ...result.responseMessages])

    const resumed = await runLoop({ ...options, messages: [...options.messages, ...result.responseMessages as ModelMessage[], { role: 'user', content: 'Continue on Canvas.' }] })
    expect((resumed.responseMessages as ModelMessage[]).filter((m) => typeof m.content === 'string' && isRuntimeContextText(m.content))).toHaveLength(0)
    expect(model.doStreamCalls[2]!.prompt.filter((m) => m.role === 'system')).toEqual(first.filter((m) => m.role === 'system'))
  })

  it('re-delivers context when a model restart abandons a prepared request before any step completes', async () => {
    const { write, options } = setup()
    await write(guidePath, '# Working procedure')
    await write(SITE_MEMORY_PATH, formatSiteMemory([oldMemory]))
    let calls = 0
    const model = new MockLanguageModelV3({ doStream: async () => {
      if (++calls === 1) throw new AgentLoopRestartError()
      return { stream: simulateReadableStream<StreamPart>({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
        { type: 'text-start', id: 'answer' },
        { type: 'text-delta', id: 'answer', delta: 'Continued with the site guide.' },
        { type: 'text-end', id: 'answer' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ] }) }
    } })
    vi.mocked(resolveModel).mockReturnValue(model)
    const result = await runLoop(options)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain('Old summary.')
    expect((result.responseMessages as ModelMessage[]).filter((m) => typeof m.content === 'string' && isRuntimeContextText(m.content))).toHaveLength(1)
  })

  it('returns a recoverable tool error without indexing a nonexistent guide', async () => {
    const { options } = setup()
    let calls = 0
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream<StreamPart>({
      initialDelayInMs: null, chunkDelayInMs: null,
      chunks: ++calls === 1 ? [
        { type: 'tool-call' as const, toolCallId: 'bad-guide', toolName: 'memory_write', input: JSON.stringify({ memories: [oldMemory] }) },
        { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage },
      ] : [
        { type: 'text-start' as const, id: 'answer' },
        { type: 'text-delta' as const, id: 'answer', delta: 'The guide must be written first.' },
        { type: 'text-end' as const, id: 'answer' },
        { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
      ],
    }) }) })
    vi.mocked(resolveModel).mockReturnValue(model)
    const result = await runLoop(options)
    expect(JSON.stringify(result.responseMessages)).toContain('does not exist')
    expect(await options.deps.vfs.getEntry(SITE_MEMORY_PATH)).toBeUndefined()
  })
})
