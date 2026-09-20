import { describe, expect, it } from 'vitest'
import { buildLunaMessage } from './onboarding-luna'

describe('onboarding Luna context', () => {
  it('includes existing memory as delimited data for upgrade-safe reruns', () => {
    const memory = JSON.stringify([
      {
        title: 'Attends Example College',
        body: 'Legacy unprefixed memory from an earlier build.',
        updated: '2026-07-01',
      },
    ])
    const prompt = buildLunaMessage('Chrome evidence', memory)

    expect(prompt).toContain('Chrome evidence')
    expect(prompt).toContain(`<existing_memories>\n${memory}\n</existing_memories>`)
  })

  it('represents a missing or empty memory file without special migration state', () => {
    expect(buildLunaMessage('Chrome evidence')).toContain('<existing_memories>\n[]\n</existing_memories>')
  })
})
