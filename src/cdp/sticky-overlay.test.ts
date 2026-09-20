import { afterEach, expect, it, vi } from 'vitest'
import { withoutStickyOverlay } from './sticky-overlay'
afterEach(() => vi.unstubAllGlobals())
it('suppresses stickies before an automation command and restores it after failure', async () => {
  const events: unknown[] = []
  vi.stubGlobal('chrome', { tabs: { sendMessage: async (_tab: number, msg: unknown) => { events.push(msg) } } })
  await expect(withoutStickyOverlay(42, true, async () => { events.push('capture'); throw new Error('failed') })).rejects.toThrow('failed')
  expect(events).toEqual([
    expect.objectContaining({ type: 'stickies.automation', active: true, hide: true }),
    'capture',
    expect.objectContaining({ type: 'stickies.automation', active: false }),
  ])
  expect((events[0] as { id: string }).id).toBe((events[2] as { id: string }).id)
})
it('keeps browser tools working on pages where no stickies content script exists', async () => {
  vi.stubGlobal('chrome', { tabs: { sendMessage: async () => { throw new Error('No receiver') } } })
  expect(await withoutStickyOverlay(42, false, async () => 'clicked')).toBe('clicked')
})
