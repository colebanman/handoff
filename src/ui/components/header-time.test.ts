import { expect, it } from 'vitest'
import { formatChatTimestamp, fullChatTimestamp } from './Header'

it('keeps malformed saved chat/provenance dates from crashing the entire panel', () => {
  for (const value of [NaN, Infinity, -Infinity, 9e20, undefined as unknown as number]) {
    expect(formatChatTimestamp(value)).toBe('Unknown date')
    expect(fullChatTimestamp(value)).toBe('Unknown date')
  }
  expect(fullChatTimestamp(Date.UTC(2026, 9, 5, 12))).toContain('2026')
})
