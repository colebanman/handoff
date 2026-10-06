import { afterEach, describe, expect, it, vi } from 'vitest'
import { getContextTab } from './context-tab'

afterEach(() => vi.unstubAllGlobals())

function setup(search: string, active: object, tabs: object[] = []): void {
  vi.stubGlobal('location', { search })
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    tabs: { query: vi.fn().mockResolvedValueOnce([active]).mockResolvedValue(tabs) },
  })
}

describe('browser context in full-tab chat', () => {
  it('keeps the active tab in the sidebar', async () => {
    setup('', { id: 1, url: 'https://example.com' })
    expect((await getContextTab())?.id).toBe(1)
  })
  it('uses the most recent web page instead of capturing the chat itself', async () => {
    setup('?view=tab', { id: 10, url: 'chrome-extension://test/sidepanel.html?view=tab' }, [
      { id: 1, url: 'https://example.com/older', lastAccessed: 100 },
      { id: 2, url: 'https://example.com/recent', lastAccessed: 200 },
      { id: 3, url: 'chrome://extensions', lastAccessed: 300 },
    ])
    expect((await getContextTab())?.id).toBe(2)
  })
  it('uses the active browser page if the chat tab is in the background', async () => {
    setup('?view=tab', { id: 2, url: 'https://example.com' })
    expect((await getContextTab())?.id).toBe(2)
  })
  it('returns no target when only internal pages are open', async () => {
    setup('?view=tab', { id: 10, url: 'chrome-extension://test/sidepanel.html?view=tab' }, [
      { id: 3, url: 'chrome://extensions' },
    ])
    expect(await getContextTab()).toBeUndefined()
  })
})
