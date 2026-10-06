import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildTools, type BuildToolsArgs } from './tools'
import { createApiDispatch } from '../sandbox/api-dispatch'
import { resetSharedSurfaceAssignments, sharedSurfaceAssignments } from './surfaces'

afterEach(() => resetSharedSurfaceAssignments())

function buildForContext(ctx: BuildToolsArgs['ctx'], overrides: Partial<BuildToolsArgs> = {}) {
  const tasks: BuildToolsArgs['tasks'] = {
    get: () => undefined,
    list: () => [],
    cancel: () => {},
    signal: () => undefined,
    steer: () => false,
    canResume: () => false,
    markFailureReported: () => {},
  }
  return buildTools({
    cdp: {} as BuildToolsArgs['cdp'],
    sandbox: {} as BuildToolsArgs['sandbox'],
    vfs: {} as BuildToolsArgs['vfs'],
    ctx,
    emit: () => {},
    spawnSubagent: async () => '',
    tasks,
    signal: new AbortController().signal,
    sandboxSessionId: 'test-session',
    ...overrides,
  })
}

describe('subagent tool boundaries', () => {
  it('keeps local computation and file viewing for an offline subagent', () => {
    const tools = buildForContext({
      agentId: 'sub-offline',
      currentTabId: 7,
      allowedTabIds: [],
      offlineOnly: true,
    })

    expect(Object.keys(tools)).toEqual(['filesystem_view', 'sandbox_exec'])
    expect(tools.sandbox_exec?.description).toContain('local workspace files')
  })

  it('lets an offline reviewer process a complete JSON pack through the scoped sandbox', async () => {
    const records = Array.from({ length: 130 }, (_, id) => ({ id, description: `Full description ${id}` }))
    const readText = vi.fn().mockResolvedValue({ text: JSON.stringify(records), truncated: false })
    const vfs = { readText } as unknown as BuildToolsArgs['vfs']
    const addTabs = vi.fn()
    const exec = vi.fn<BuildToolsArgs['sandbox']['exec']>(async ({ code, scope }) => {
      expect(scope).toMatchObject({ offlineOnly: true, allowedTabIds: [] })
      const dispatch = createApiDispatch({} as BuildToolsArgs['cdp'], vfs, scope)
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const value = await new AsyncFunction('api', code)({
        fs: { readText: (path: string) => dispatch('fs.readText', [path]) },
      })
      return { ok: true, value: JSON.stringify(value), logs: [], durationMs: 1 }
    })
    const tools = buildForContext({
      agentId: 'sub-reviewer', currentTabId: 7, allowedTabIds: [], offlineOnly: true,
    }, {
      vfs, sandbox: { exec }, tabGroups: { addTabs } as unknown as BuildToolsArgs['tabGroups'],
    })
    const result = await tools.sandbox_exec!.execute!({
      intent: 'Reviewing the full record pack',
      code: 'const records = JSON.parse(await api.fs.readText("/workspace/pack.json")); return { count: records.length, last: records.at(-1).description };',
    }, { toolCallId: 'review', messages: [] })

    expect(result).toContain('"count":130')
    expect(result).toContain('Full description 129')
    expect(readText).toHaveBeenCalledWith('/workspace/pack.json', expect.anything())
    expect(addTabs).not.toHaveBeenCalled()
  })

  it('lets a prepared-tab subagent use its page but not manage Chrome tabs', () => {
    const tools = buildForContext({
      agentId: 'sub-browser',
      currentTabId: 9,
      allowedTabIds: [9],
    })

    expect(tools.browser_navigate).toBeDefined()
    expect(tools.browser_tabs).toBeUndefined()
    expect(tools.sandbox_exec).toBeDefined()
  })

  it('views offline HTML as source without opening a live artifact', async () => {
    const screenshot = vi.fn()
    const tools = buildForContext({
      agentId: 'sub-offline', currentTabId: 7, allowedTabIds: [], offlineOnly: true,
    }, {
      artifacts: { screenshot } as unknown as BuildToolsArgs['artifacts'],
      vfs: {
        getEntry: vi.fn().mockResolvedValue({ path: '/workspace/artifacts/report.html', name: 'report.html', mediaType: 'text/html', size: 12 }),
        readText: vi.fn().mockResolvedValue({ text: '<p>Local</p>', truncated: false }),
      } as unknown as BuildToolsArgs['vfs'],
    })
    await expect(tools.filesystem_view!.execute!({ path: '/workspace/artifacts/report.html' }, {
      toolCallId: 'view', messages: [],
    })).resolves.toMatchObject({ mode: 'text', text: '<p>Local</p>' })
    expect(screenshot).not.toHaveBeenCalled()
  })
})

describe('Handoff tool capabilities', () => {
  it('blocks both browser tools and sandbox CDP against a delegated tab', async () => {
    sharedSurfaceAssignments().claim('sub-a', [7])
    const click = vi.fn(), send = vi.fn()
    const cdp = { click, send } as unknown as BuildToolsArgs['cdp']
    const tools = buildForContext({ agentId: 'main', surfaceOwnerId: 'main:chat-b', currentTabId: 7 }, { cdp })
    const result = await tools.browser_click!.execute!({ ref: 'e1' }, { toolCallId: 'click', messages: [] })
    expect(result).toContain('owned by sub-a')
    const dispatch = createApiDispatch(cdp, {} as BuildToolsArgs['vfs'], { agentId: 'main', surfaceOwnerId: 'main:chat-b' })
    await expect(dispatch('cdp', [7, 'Input.insertText', { text: 'wrong tab' }])).rejects.toThrow('owned by sub-a')
    expect(click).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it('keeps sandbox failures machine-readable when partial work logged output', async () => {
    const tools = buildForContext({ agentId: 'main', currentTabId: 1 }, {
      sandbox: { exec: async () => ({ ok: false, error: 'Later step failed', logs: ['[log] First step finished'], durationMs: 1 }) },
    })
    const output = await tools.sandbox_exec!.execute!({ intent: 'Running a script', code: '' }, { toolCallId: 'test', messages: [] })
    expect(output).toMatch(/^Error: Later step failed/)
    expect(output).toContain('First step finished')
    expect(await tools.sandbox_exec!.toModelOutput!({ output, toolCallId: 'test', input: {} as never })).toMatchObject({ type: 'error-text' })
  })
  it('provides browser tools without local-agent or MCP capabilities, even with an obsolete callback', () => {
    const tools = buildTools({
      cdp: {} as BuildToolsArgs['cdp'],
      sandbox: {} as BuildToolsArgs['sandbox'],
      vfs: {} as BuildToolsArgs['vfs'],
      ctx: { agentId: 'main', currentTabId: 1 },
      emit: vi.fn(),
      spawnSubagent: vi.fn(),
      tasks: {} as BuildToolsArgs['tasks'],
      signal: new AbortController().signal,
      sandboxSessionId: 'test',
      codingAgent: vi.fn(),
    } as BuildToolsArgs & { codingAgent: ReturnType<typeof vi.fn> })

    expect(tools.browser_snapshot).toBeDefined()
    expect(tools.sandbox_exec).toBeDefined()
    expect(Object.keys(tools).join(' ')).not.toMatch(/coding_agent|codex|mcp|room/i)
    expect(Object.values(tools).map((tool) => tool.description).join('\n')).not.toMatch(/codex|\bmcp\b/i)
  })
})
