import { describe, expect, it, vi } from 'vitest'
import { buildTools, type BuildToolsArgs } from './tools'

function buildForContext(ctx: BuildToolsArgs['ctx']) {
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
  })
}

describe('subagent tool boundaries', () => {
  it('removes every browser-capable entry point for an offline subagent', () => {
    const tools = buildForContext({
      agentId: 'sub-offline',
      currentTabId: 7,
      allowedTabIds: [],
      offlineOnly: true,
    })

    expect(Object.keys(tools)).toEqual(['filesystem_view'])
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
})

describe('Handoff tool capabilities', () => {
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
