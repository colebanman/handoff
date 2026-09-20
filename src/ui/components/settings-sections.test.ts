import { describe, expect, it } from 'vitest'
import { resolveSection, SETTINGS_SECTIONS } from './settings-sections'

describe('settings section registry', () => {
  it('keeps the five extension tabs in their existing order', () => {
    expect(SETTINGS_SECTIONS.map(section => section.id)).toEqual(['account', 'behavior', 'instructions', 'automations', 'appearance'])
  })

  it('maps legacy tab ids and falls back to the first visible tab', () => {
    expect(resolveSection('accounts')).toBe('account')
    expect(resolveSection('mini')).toBe('account')
    expect(resolveSection('sidekick')).toBe('account')
    expect(resolveSection(undefined)).toBe('account')
    expect(resolveSection('nonsense')).toBe('account')
    expect(resolveSection('workspace')).toBe('account')
  })
})
