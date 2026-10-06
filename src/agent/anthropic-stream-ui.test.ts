import { afterEach, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS, type AgentEvent, type TranscriptItem, type VirtualFileSystemService,
} from '../shared/types'
import { applyEvent } from '../ui/reducer'
import { describeStep } from '../ui/tool-labels'
import { createAnthropicModel } from './anthropic-transport'
import { resolveModel, resolveModelAccess } from './models'
import { runLoop, type RunLoopOptions } from './run'

vi.mock('./models', () => ({ resolveModel: vi.fn(), resolveModelAccess: vi.fn() }))

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

/** Split both SSE frames and UTF-8 characters across network chunks. */
function response(events: object[]): Response {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 23) controller.enqueue(bytes.slice(offset, offset + 23))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

const start = () => ({ type: 'message_start', message: {
  id: 'msg_claude_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
  content: [], stop_reason: null, stop_sequence: null,
  usage: { input_tokens: 30, output_tokens: 0 },
} })
const delta = (index: number, type: string, value: string) => ({
  type: 'content_block_delta', index,
  delta: { type, [type === 'input_json_delta' ? 'partial_json' : type === 'signature_delta' ? 'signature' : type === 'thinking_delta' ? 'thinking' : 'text']: value },
})
const stop = (index: number) => ({ type: 'content_block_stop', index })

it('parses native Claude reasoning and parallel tools into separate live transcript rows', async () => {
  const firstInput = { intent: 'Reading "Course A" notes', code: 'return "line\\n😀";' }
  const secondInput = { intent: 'Inspecting course folders', code: 'return ["a", "b"];' }
  const firstJson = JSON.stringify(firstInput)
  const secondJson = JSON.stringify(secondInput)
  const requests: any[] = []
  const settings = { ...DEFAULT_SETTINGS, provider: 'anthropic' as const, anthropicAuthMode: 'api-key' as const, modelId: 'claude-sonnet-5-5', apiKey: 'fixture-key' }
  const model = createAnthropicModel({ modelId: settings.modelId, apiKey: settings.apiKey, fetch: async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    if (requests.length === 1) {
      const fragments: object[] = []
      // Real Anthropic streams start tool_use with input:{}; that initial object
      // must not be concatenated with the subsequent partial_json fragments.
      for (let offset = 0; offset < Math.max(firstJson.length, secondJson.length); offset += 3) {
        if (offset < firstJson.length) fragments.push(delta(2, 'input_json_delta', firstJson.slice(offset, offset + 3)))
        if (offset < secondJson.length) fragments.push(delta(3, 'input_json_delta', secondJson.slice(offset, offset + 3)))
      }
      return response([
        start(),
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        delta(0, 'thinking_delta', 'I will inspect the course notes before answering. '),
        delta(0, 'thinking_delta', 'Then I will compare the folder names.'),
        delta(0, 'signature_delta', 'opaque-first-signature'), stop(0),
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        delta(1, 'text_delta', 'I’ll inspect the local notes.'), stop(1),
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_read', name: 'sandbox_exec', input: {} } },
        { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_list', name: 'sandbox_exec', input: {} } },
        delta(2, 'input_json_delta', ''), ...fragments, stop(2), stop(3),
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 50 } },
        { type: 'message_stop' },
      ])
    }
    return response([
      start(),
      // Anthropic reuses content-block indices in each response. These must
      // become a new reasoning row and text row, not append to the first step.
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      delta(0, 'thinking_delta', 'The file contents and folder names agree.'),
      delta(0, 'signature_delta', 'opaque-second-signature'), stop(0),
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      delta(1, 'text_delta', 'The notes are ready.'), stop(1),
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 15 } },
      { type: 'message_stop' },
    ])
  } })
  vi.mocked(resolveModelAccess).mockResolvedValue({ settings })
  vi.mocked(resolveModel).mockReturnValue(model)
  vi.stubGlobal('chrome', { tabs: { query: async () => [] } })
  const events: AgentEvent[] = []
  let transcript: TranscriptItem[] = []
  const liveLabels: Array<{ id: string; label: string; input: unknown }> = []
  const execute = vi.fn(async (_args: { code: string }) => ({ ok: true, value: 'Fixture result', logs: [], durationMs: 1 }))
  const result = await runLoop({
    ctx: { agentId: 'main', currentTabId: 0 }, settings, modelId: settings.modelId,
    messages: [{ role: 'user', content: 'Read the local notes and compare the folders.' }],
    signal: new AbortController().signal, sandboxSessionId: 'claude-stream-fixture', isSubagent: false,
    spawnSubagent: vi.fn(), tasks: {} as RunLoopOptions['tasks'],
    deps: {
      cdp: {} as RunLoopOptions['deps']['cdp'], sandbox: { exec: execute },
      vfs: { summary: async () => ({ entries: [], skills: [] }) } as unknown as VirtualFileSystemService,
    },
    emit: (event) => {
      events.push(event)
      transcript = applyEvent(transcript, event)
      if (event.type !== 'tool-input-delta') return
      const row = transcript.find((item) => item.kind === 'tool' && item.id === event.toolCallId)
      if (row?.kind === 'tool' && row.inputStreaming) {
        liveLabels.push({ id: row.id, label: describeStep(row).label, input: row.input })
      }
    },
  })

  expect(result.errorText).toBeUndefined()
  expect(result.text).toBe('The notes are ready.')
  expect(requests).toHaveLength(2)
  expect(execute).toHaveBeenCalledTimes(2)
  expect(execute.mock.calls.map((call) => call[0].code)).toEqual([firstInput.code, secondInput.code])
  expect(liveLabels).toContainEqual(expect.objectContaining({ id: 'toolu_read', label: firstInput.intent }))
  expect(liveLabels).toContainEqual(expect.objectContaining({ id: 'toolu_list', label: secondInput.intent }))
  const tools = transcript.filter((item) => item.kind === 'tool')
  expect(tools).toHaveLength(2)
  expect(tools[0]).toMatchObject({ id: 'toolu_read', toolName: 'sandbox_exec', inputText: firstJson, input: firstInput, inputStreaming: false, status: 'done' })
  expect(tools[1]).toMatchObject({ id: 'toolu_list', toolName: 'sandbox_exec', inputText: secondJson, input: secondInput, inputStreaming: false, status: 'done' })
  const thoughts = transcript.filter((item) => item.kind === 'reasoning')
  expect(thoughts.map((item) => item.text)).toEqual([
    'I will inspect the course notes before answering. Then I will compare the folder names.',
    'The file contents and folder names agree.',
  ])
  expect(new Set(thoughts.map((item) => item.id)).size).toBe(2)
  expect(thoughts.every((item) => !item.streaming)).toBe(true)
  expect(transcript.filter((item) => item.kind === 'text').map((item) => item.text)).toEqual([
    'I’ll inspect the local notes.', 'The notes are ready.',
  ])
  expect(events.filter((event) => event.type === 'tool-input-start').map((event) => event.toolCallId)).toEqual(['toolu_read', 'toolu_list'])
  expect(JSON.stringify(requests[1].messages)).toContain('opaque-first-signature')
  expect(JSON.stringify(transcript)).not.toContain('opaque-first-signature')
})
