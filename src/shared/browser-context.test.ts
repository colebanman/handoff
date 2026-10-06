import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from 'ai'
import { browserContextMetadata, getBrowserContextTab, latestContextTabId, withoutBrowserContextMetadata } from './browser-context'

afterEach(() => vi.unstubAllGlobals())

describe('captured browser targets', () => {
  it('uses the same full-tab fallback from the worker and UI', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: () => 'chrome-extension://test/sidepanel.html' }, tabs: {
      query: vi.fn().mockResolvedValueOnce([{ id: 100, url: 'chrome-extension://test/sidepanel.html?view=tab' }])
        .mockResolvedValue([{ id: 42, url: 'https://example.com', lastAccessed: 10 }]),
    } })
    expect((await getBrowserContextTab())?.id).toBe(42)
  })

  it('retains the sent target even if Chrome focus changed before execution or retry', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Use this page', ...browserContextMetadata(42) },
      { role: 'user', content: '<context source="harness">\n<workspace/>\n</context>' },
    ]
    expect(latestContextTabId(messages)).toBe(42)
    expect(latestContextTabId([{ role: 'user', content: 'Use this page', ...browserContextMetadata(null) }])).toBeNull()
    expect(latestContextTabId([...messages, { role: 'user', content: 'A new task without ambient context' }])).toBeUndefined()
    const projected = withoutBrowserContextMetadata(messages)
    expect(JSON.stringify(projected)).not.toContain('contextTabId')
    expect(latestContextTabId(messages)).toBe(42)
  })

  it('can resume older chats from their captured ambient block', () => {
    expect(latestContextTabId([{ role: 'user', content: 'Read this\n\n<context>\nLocal time: now\nActive tab: [42] Page — https://example.com\n</context>' }])).toBe(42)
  })

  it('resumes the logical working tab, while a new user message can select a new initial tab', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Use this page', ...browserContextMetadata(42) },
      { role: 'user', content: '<context source="harness">\n<browser-target>Working tab 5</browser-target>\n</context>',
        providerOptions: { harness: { workingTabId: 5 } } },
    ]
    expect(latestContextTabId(messages)).toBe(5)
    expect(latestContextTabId([...messages, { role: 'user', content: 'Now use this tab', ...browserContextMetadata(9) }])).toBe(9)
    expect(JSON.stringify(withoutBrowserContextMetadata(messages))).not.toContain('workingTabId')
  })
})
