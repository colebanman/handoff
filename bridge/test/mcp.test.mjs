import { describe, expect, it } from 'vitest'
import { MCP_INSTRUCTIONS, TOOLS } from '../src/mcp.mjs'

describe('MCP natural-language routing', () => {
  it('tells coding agents to translate ordinary Ask Handoff phrasing into handoff_ask', () => {
    const ask = TOOLS.find((tool) => tool.name === 'handoff_ask')

    expect(ask?.description).toContain('"ask Handoff"')
    expect(ask?.description).toContain('"send this to Handoff"')
    expect(ask?.description).toContain('Google Doc')
    expect(ask?.description).toContain('call handoff_ask')
    expect(ask?.inputSchema.properties.prompt.description).toContain('Include URLs or page context')
  })

  it('makes the full handoff behavior available in MCP initialize instructions', () => {
    expect(MCP_INSTRUCTIONS).toContain('without requiring an MCP tool name')
    expect(MCP_INSTRUCTIONS).toContain("The handoff_ask result is Handoff's handoff back to you")
    expect(MCP_INSTRUCTIONS).toContain('retrieve it with handoff_pull_file')
  })

  it('exposes only incoming task and file operations', () => {
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual([
      'handoff_ask', 'handoff_follow', 'handoff_wait', 'handoff_get', 'handoff_tool_calls',
      'handoff_list_chats', 'handoff_cancel', 'handoff_status', 'handoff_push_file', 'handoff_pull_file',
      'handoff_fs_list', 'handoff_fs_read', 'handoff_fs_write', 'handoff_fs_delete',
    ].sort())
  })
})
