import { expect, it } from 'vitest'
import { formatRemaining } from './RateLimitBanner'

it('carries rounded seconds into the next minute', () => {
  expect(formatRemaining(119_999)).toBe('2m 0s')
  expect(formatRemaining(60_000)).toBe('1m 0s')
  expect(formatRemaining(90_000)).toBe('1m 30s')
  expect(formatRemaining(9_999)).toBe('10.0s')
})
