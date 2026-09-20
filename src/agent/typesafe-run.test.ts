import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { DEFAULT_SETTINGS, type VirtualFileSystemService } from '../shared/types'
import { extensionManifest, type ExtensionSummary } from '../shared/extensions'
import { resolveModel, resolveModelAccess } from './models'
import { runLoop, type RunLoopOptions } from './run'

vi.mock('./models', () => ({ resolveModel: vi.fn(), resolveModelAccess: vi.fn() }))
type StreamPart = Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }
const final: StreamPart[] = [
  { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'Here are your assignments.' },
  { type: 'text-end', id: 'answer' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
]

function setup(enabled = true) {
  const manifest = extensionManifest.parse({ version: 1, id: 'school', description: 'Retrieve course assignments', sites: ['school.example/**'],
    actions: { list: { description: 'Read my assignments', effects: 'read', input: { type: 'object' } } } })
  const saved: ExtensionSummary = { id: 'school', description: manifest.description, enabled: true, revision: 1, revisions: [1],
    manifest, path: '/skills/school', results: [{ name: 'read', action: 'list', mode: 'live', ok: true }] }
  const sandbox = { exec: vi.fn(async () => ({ ok: true, value: JSON.stringify([{ assignment: 'Biology essay', due: 'Friday' }]), logs: [], durationMs: 1 })) }
  const extensions = vi.fn(async (op: string) => op === 'list' ? [saved] : { learningEnabled: true })
  const vfs = { summary: async () => ({ entries: [], skills: [] }), getEntry: async () => undefined,
    readText: async () => ({ path: '', text: '', truncated: false, totalChars: 0 }), extensions } as unknown as VirtualFileSystemService
  const settings = { ...DEFAULT_SETTINGS, provider: 'openai' as const, modelId: 'typesafe-test', typeSafeEnabled: enabled, typeSafeApiKey: 'private-decision-key' }
  const controller = new AbortController()
  const opts: RunLoopOptions = {
    ctx: { agentId: 'main', currentTabId: 7 }, settings, modelId: settings.modelId,
    messages: [{ role: 'user', content: 'Get my assignments.' }], signal: controller.signal, emit: vi.fn(),
    deps: { vfs, cdp: {} as RunLoopOptions['deps']['cdp'], sandbox },
    spawnSubagent: async () => '', tasks: {} as RunLoopOptions['tasks'], sandboxSessionId: 'typesafe-test', isSubagent: false,
    onStepMessages: vi.fn(),
  }
  vi.mocked(resolveModelAccess).mockResolvedValue({ settings })
  vi.stubGlobal('chrome', { tabs: { query: async () => [{ id: 7, active: true, url: 'https://school.example/course' }] } })
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    const { questions } = JSON.parse(String(init.body))
    const answers = Object.fromEntries(Object.entries(questions as Record<string, { type: string; criteria?: Record<string, string> }>).map(([id, q]) => [id,
      q.type === 'noul' ? { type: 'noul', noul: id.startsWith('support') ? 0.1 : 0.99 } : {
        type: 'choice', choice: 'c0', confidence: 0.99,
        probabilities: Object.fromEntries(Object.keys(q.criteria!).map((key) => [key, key === 'c0' ? 1 : 0])),
      },
    ]))
    return new Response(JSON.stringify({ answers }))
  })
  vi.stubGlobal('fetch', fetcher)
  const model = new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks: final, initialDelayInMs: null, chunkDelayInMs: null }) }) })
  vi.mocked(resolveModel).mockReturnValue(model)
  return { opts, model, sandbox, fetcher, saved, extensions, controller }
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('TypeSafe through the real agent loop', () => {
  it('executes a shortcut before the first model call, displays it, and checkpoints its results', async () => {
    const { opts, model, sandbox } = setup()
    const result = await runLoop(opts)
    expect(sandbox.exec).toHaveBeenCalledTimes(1)
    expect(sandbox.exec.mock.calls[0]).toBeDefined()
    expect(model.doStreamCalls).toHaveLength(1)
    const request = JSON.stringify(model.doStreamCalls[0])
    expect(request).toContain('Biology essay')
    expect(request).toContain('sandbox_exec')
    expect(request).toContain('verify_extraction')
    expect(request).not.toContain('private-decision-key')
    expect(JSON.stringify(result.responseMessages)).toContain('Biology essay')
    expect(opts.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-call', toolName: 'sandbox_exec' }))
    expect(opts.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-result', toolName: 'sandbox_exec', isError: false }))
    expect(opts.onStepMessages).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ role: 'tool' })]))
    expect(result.text).toBe('Here are your assignments.')
  })

  it('makes no TypeSafe requests or shortcuts with the experiment disabled', async () => {
    const { opts, model, sandbox, fetcher } = setup(false)
    await runLoop(opts)
    expect(fetcher).not.toHaveBeenCalled()
    expect(sandbox.exec).not.toHaveBeenCalled()
    expect(JSON.stringify(model.doStreamCalls[0])).not.toContain('verify_extraction')
  })

  it('falls back if a selected function is disabled before execution', async () => {
    const { opts, sandbox, saved, extensions } = setup()
    let lists = 0
    extensions.mockImplementation(async (op) => op === 'list' ? [{ ...saved, enabled: ++lists === 1 }] : { learningEnabled: true })
    expect((await runLoop(opts)).text).toBe('Here are your assignments.')
    expect(sandbox.exec).not.toHaveBeenCalled()
  })

  it('honors a user stop after routing and before sandbox execution', async () => {
    const { opts, sandbox, controller, saved, extensions } = setup()
    let lists = 0
    extensions.mockImplementation(async (op) => {
      if (op === 'list' && ++lists === 2) controller.abort()
      return op === 'list' ? [saved] : { learningEnabled: true }
    })
    await expect(runLoop(opts)).rejects.toThrow()
    expect(sandbox.exec).not.toHaveBeenCalled()
  })

  it('returns source verification flags to the model for correction in the next step', async () => {
    const { opts, sandbox, extensions } = setup()
    extensions.mockImplementation(async (op) => op === 'list' ? [] : { learningEnabled: true })
    let step = 0
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream<StreamPart>({
      initialDelayInMs: null, chunkDelayInMs: null, chunks: step++ === 0 ? [
        { type: 'tool-call', toolCallId: 'verify', toolName: 'verify_extraction', input: JSON.stringify({
          source: 'Biology essay is due Friday. Registration closes Monday.',
          fields: [{ field: 'due', value: 'Monday', meaning: 'Biology essay deadline' }],
        }) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
      ] : final,
    }) }) })
    vi.mocked(resolveModel).mockReturnValue(model)
    const result = await runLoop(opts)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(JSON.stringify(model.doStreamCalls[1])).toContain('unsupported')
    expect(JSON.stringify(result.responseMessages)).toContain('unsupported')
    expect(sandbox.exec).not.toHaveBeenCalled()
  })
})
