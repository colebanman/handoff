import { describe, expect, it } from 'vitest'
import { reconcileActivityIdentity as reconcile } from './activity-identity'

describe('activity identity across transcript updates', () => {
  it('hands a pending block to its first tool without replaying its entrance', () => {
    const pending = reconcile([], [{ ids: [], after: 'user' }])
    expect(reconcile(pending, [{ ids: ['tool'], after: 'user' }])[0]!.key).toBe(pending[0]!.key)
  })

  it('preserves the block when a connection restart removes preceding prose', () => {
    const before = reconcile([], [{ ids: ['tool'], after: 'uncommitted-text' }])
    expect(reconcile(before, [{ ids: ['tool'], after: null }])[0]!.key).toBe(before[0]!.key)
  })

  it('does not carry a reader disclosure into unrelated replacement history', () => {
    const before = reconcile([], [{ ids: ['old'], after: null }])
    expect(reconcile(before, [{ ids: ['new'], after: null }])[0]!.key).not.toBe(before[0]!.key)
  })

  it('preserves identity when the first item is removed but later work survives', () => {
    const before = reconcile([], [{ ids: ['reasoning', 'tool'], after: 'user' }])
    expect(reconcile(before, [{ ids: ['tool'], after: 'user' }])[0]!.key).toBe(before[0]!.key)
  })

  it('merges into the first surviving block, and splits without duplicate keys', () => {
    const before = reconcile([], [{ ids: ['a'], after: null }, { ids: ['b'], after: 'text' }])
    const merged = reconcile(before, [{ ids: ['a', 'b'], after: null }])
    expect(merged[0]!.key).toBe(before[0]!.key)
    const split = reconcile(merged, [{ ids: ['a'], after: null }, { ids: ['b'], after: 'new-text' }])
    expect(split[0]!.key).toBe(merged[0]!.key)
    expect(new Set(split.map(block => block.key)).size).toBe(2)
  })

  it('does not steal a pending slot from a different turn', () => {
    const before = reconcile([], [{ ids: [], after: 'user-a' }])
    expect(reconcile(before, [{ ids: ['tool'], after: 'user-b' }])[0]!.key).not.toBe(before[0]!.key)
  })
})
