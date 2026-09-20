import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, SandboxService, VirtualFileSystemService, VfsEntry } from '../shared/types'
import type { JsonValue } from '../shared/rpc'
import type { TaskRegistry } from './tasks'
import type { SpawnSubagentFn } from './tools'
import { buildWorkflowCode, makeRunWorkflow } from './workflows'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>

function workflowApi(
  dispatch: (path: string, args: JsonValue[]) => Promise<JsonValue>,
): { workflow: Record<string, (...args: JsonValue[]) => Promise<JsonValue>> } {
  return {
    workflow: {
      agent: (request) => dispatch('workflow.agent', [request]),
      phase: (id) => dispatch('workflow.phase', [id]),
      log: (message) => dispatch('workflow.log', [message]),
    },
  }
}

async function evaluateWorkflow(
  script: string,
  args: JsonValue | undefined,
  dispatch: (path: string, values: JsonValue[]) => Promise<JsonValue>,
): Promise<unknown> {
  return new AsyncFunction('api', buildWorkflowCode(script, args))(workflowApi(dispatch))
}

function executableSandbox(): SandboxService {
  return {
    async exec(opts) {
      const startedAt = Date.now()
      try {
        if (!opts.dispatch) throw new Error('missing workflow dispatcher')
        const value = await new AsyncFunction('api', opts.code)(workflowApi(opts.dispatch))
        return {
          ok: true,
          value: value === undefined ? undefined : JSON.stringify(value),
          logs: [],
          durationMs: Date.now() - startedAt,
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          logs: [],
          durationMs: Date.now() - startedAt,
        }
      }
    },
  }
}

function memoryVfs(): { vfs: VirtualFileSystemService; writes: Map<string, string> } {
  const writes = new Map<string, string>()
  const vfs = {
    async writeText(path: string, value: string, opts?: { mediaType?: string }): Promise<VfsEntry> {
      writes.set(path, value)
      const now = Date.now()
      return {
        path,
        root: 'workspace',
        name: path.split('/').at(-1) ?? path,
        mediaType: opts?.mediaType ?? 'text/plain',
        size: value.length,
        createdAt: now,
        updatedAt: now,
      }
    },
    async readText(path: string) {
      const text = writes.get(path)
      if (text === undefined) throw new Error(`missing ${path}`)
      return { path, text, truncated: false, totalChars: text.length }
    },
  } as unknown as VirtualFileSystemService
  return { vfs, writes }
}

function coordinator(spawnSubagent: SpawnSubagentFn) {
  const events: AgentEvent[] = []
  const { vfs, writes } = memoryVfs()
  const run = makeRunWorkflow({
    chatId: 'chat-1',
    emit: (event) => events.push(event),
    sandbox: executableSandbox(),
    vfs,
    tasks: {} as TaskRegistry,
    spawnSubagent,
    parentSignal: new AbortController().signal,
  })
  return { run, events, writes }
}

describe('workflow JavaScript DSL', () => {
  it('reuses one prompt across a parallel fan-out and preserves one batch', async () => {
    const requests: Array<Record<string, JsonValue>> = []
    const result = await evaluateWorkflow(
      `
const prompt = args.prompt;
return await parallel([
  () => agent(prompt, { label: 'First' }),
  () => agent(prompt, { label: 'Second' }),
  () => agent(prompt, { label: 'Third' }),
]);`,
      { prompt: 'Review this once' },
      async (path, values) => {
        expect(path).toBe('workflow.agent')
        const request = values[0] as Record<string, JsonValue>
        requests.push(request)
        return request.label ?? null
      },
    )

    expect(result).toEqual(['First', 'Second', 'Third'])
    expect(requests.map((request) => request.prompt)).toEqual([
      'Review this once',
      'Review this once',
      'Review this once',
    ])
    expect(new Set(requests.map((request) => request.batchId)).size).toBe(1)
  })

  it('feeds an earlier subagent result into a later prompt', async () => {
    const prompts: string[] = []
    const result = await evaluateWorkflow(
      `
const research = await agent('Collect evidence');
return await agent('Synthesize this evidence: ' + research);`,
      undefined,
      async (_path, values) => {
        const prompt = (values[0] as Record<string, JsonValue>).prompt as string
        prompts.push(prompt)
        return prompts.length === 1 ? 'three findings' : 'final answer'
      },
    )

    expect(prompts).toEqual(['Collect evidence', 'Synthesize this evidence: three findings'])
    expect(result).toBe('final answer')
  })
})

describe('workflow coordinator', () => {
  it('persists inline source and converts a failed child to null', async () => {
    const spawn = vi.fn<SpawnSubagentFn>(async ({ task }) =>
      task === 'fail' ? 'Error: subagent failed — expected failure' : 'usable result',
    )
    const { run, events, writes } = coordinator(spawn)
    const report = await run({
      title: 'Failure tolerant review',
      description: 'Continue when one reviewer fails.',
      script: `
const [failed, ok] = await parallel([
  () => agent('fail', { label: 'Unreliable' }),
  () => agent('succeed', { label: 'Reliable' }),
]);
return { failed, ok };`,
      parentToolCallId: 'tool-1',
    })

    expect(report).toContain('"failed": null')
    expect(report).toContain('"ok": "usable result"')
    expect(writes.size).toBe(1)
    expect([...writes.values()][0]).toMatch(/^\/\/ handoff-workflow: /)
    expect(events.some((event) => event.type === 'workflow-finish' && event.status === 'done')).toBe(true)
  })

  it('rejects an eleventh subagent before launching it', async () => {
    const spawn = vi.fn<SpawnSubagentFn>(async ({ task }) => task)
    const { run, events } = coordinator(spawn)
    const report = await run({
      title: 'Overwide fan out',
      description: 'Exercise the workflow safety limit.',
      script: `return await Promise.all(Array.from({ length: 11 }, (_, i) => agent('agent-' + i)));`,
      parentToolCallId: 'tool-2',
    })

    expect(spawn).toHaveBeenCalledTimes(10)
    expect(report).toContain('at most 10 agents')
    expect(events.some((event) => event.type === 'workflow-finish' && event.status === 'error')).toBe(true)
  })
})
