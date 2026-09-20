import { describe, expect, it } from 'vitest'
import { isRuntimeContextMessage, RUNTIME_CONTEXT_START } from './context-blocks'

describe('generated context versus real user turns', () => {
  const text = `${RUNTIME_CONTEXT_START}<workspace>Files</workspace>\n</context>`
  it('recognizes both SDK text representations for turn counting and reverts', () => {
    expect(isRuntimeContextMessage({ role: 'user', content: text })).toBe(true)
    expect(isRuntimeContextMessage({ role: 'user', content: [{ type: 'text', text }] })).toBe(true)
  })
  it('does not mistake quoted context, tool output, or attachments for a generated turn', () => {
    expect(isRuntimeContextMessage({ role: 'user', content: `Explain this: ${text}` })).toBe(false)
    expect(isRuntimeContextMessage({ role: 'tool', content: text })).toBe(false)
    expect(isRuntimeContextMessage({ role: 'user', content: [{ type: 'text', text }, { type: 'file', data: 'x' }] })).toBe(false)
  })
})
