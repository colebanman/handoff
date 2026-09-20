import { describe, expect, it } from 'vitest'
import { surfaceLabel, surfaceLabels } from './surfaces-label'

describe('surfaceLabel', () => {
  it('names a tab by its title when one is known', () => {
    expect(surfaceLabel('tab:123', { '123': 'Anthropic — Home' })).toBe('Tab · Anthropic — Home')
    expect(surfaceLabel('tab:123', new Map([['123', 'Anthropic — Home']]))).toBe('Tab · Anthropic — Home')
  })

  it('falls back to the tab id without a title', () => {
    expect(surfaceLabel('tab:123')).toBe('Tab 123')
    expect(surfaceLabel('tab:123', {})).toBe('Tab 123')
    expect(surfaceLabel('tab:123', { '123': '   ' })).toBe('Tab 123')
    expect(surfaceLabel('tab:123', { '456': 'Other' })).toBe('Tab 123')
  })

  it('trims a known title', () => {
    expect(surfaceLabel('tab:7', { '7': '  Inbox  ' })).toBe('Tab · Inbox')
  })

  it('returns anything unrecognized unchanged', () => {
    expect(surfaceLabel('window:9')).toBe('window:9')
    expect(surfaceLabel('')).toBe('')
  })
})

describe('surfaceLabels', () => {
  it('maps a list in order and skips empties', () => {
    expect(surfaceLabels(['tab:1', '', 'tab:2'], { '1': 'Docs' })).toEqual(['Tab · Docs', 'Tab 2'])
  })

  it('returns an empty list when there are no surfaces', () => {
    expect(surfaceLabels(undefined)).toEqual([])
    expect(surfaceLabels([])).toEqual([])
  })
})
