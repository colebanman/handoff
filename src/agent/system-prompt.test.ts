import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './system-prompt'

describe('main-agent memory scaffolding', () => {
  it('keeps mutable inventories out of both system blocks', () => {
    const prompt = buildSystemPrompt({ isSubagent: false })
    expect(prompt.dynamicPrompt).toBe('')
    expect(prompt.staticPrompt).toContain('<context source="harness">')
    expect(prompt.staticPrompt).toContain('Read one entry or several')
    expect(prompt.staticPrompt).not.toContain('Workspace files:')
    expect(prompt.staticPrompt).not.toContain('What you remember about this user')
  })

  it('teaches subagents to use field guides without giving them user memory', () => {
    const prompt = buildSystemPrompt({ isSubagent: true, task: 'Do a focused task.' })
    expect(prompt.staticPrompt).toContain('# Site field guides')
    expect(prompt.staticPrompt).not.toContain('# Long-term memory')
    expect(prompt.dynamicPrompt).not.toContain('Workspace files:')
  })

  it('makes blank-tab subagents explicitly offline-only', () => {
    const prompt = buildSystemPrompt({
      isSubagent: true,
      allowedTabIds: [],
      offlineOnly: true,
      task: 'Retrieve the user\'s Canvas assignments.',
    })

    expect(prompt.dynamicPrompt).toContain('OFFLINE-ONLY')
    expect(prompt.dynamicPrompt).toContain('Do not attempt to open or navigate a site')
    expect(prompt.dynamicPrompt).toContain('(none assigned — do not touch any tab)')
  })


})
