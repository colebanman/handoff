import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const extensionId = 'abcdefghijklmnopabcdefghijklmnop'

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('Claude extension-native browser transport', () => {
  it('sets the token-exchange fingerprint only on exact native POST endpoints initiated by this extension', async () => {
    const updateSessionRules = vi.fn<(options: chrome.declarativeNetRequest.UpdateRuleOptions) => Promise<void>>(async () => {})
    vi.stubGlobal('chrome', { runtime: { id: extensionId }, declarativeNetRequest: { updateSessionRules } })
    const { ensureAnthropicBrowserTransport } = await import('./anthropic-browser')
    await ensureAnthropicBrowserTransport()
    const update = updateSessionRules.mock.calls[0]![0] as unknown as chrome.declarativeNetRequest.UpdateRuleOptions
    expect(update.removeRuleIds).toEqual([510001, 510002])
    expect(update.addRules).toHaveLength(2)
    for (const rule of update.addRules!) {
      expect(rule.action.type).toBe('modifyHeaders')
      expect(rule.action.requestHeaders).toContainEqual({ header: 'Origin', operation: 'remove' })
      expect(rule.condition).toMatchObject({
        initiatorDomains: [extensionId], resourceTypes: ['xmlhttprequest'], requestMethods: ['post'], isUrlFilterCaseSensitive: true,
      })
      // Without this exact initiator, an ordinary web page cannot match either rule.
      expect(rule.condition.initiatorDomains).not.toContain('claude.ai')
      expect(rule.condition.initiatorDomains).not.toContain('example.com')
    }
    const messages = new RegExp(update.addRules![0]!.condition.regexFilter!)
    expect(update.addRules![0]!.action.requestHeaders).toEqual([{ header: 'Origin', operation: 'remove' }])
    expect(update.addRules![1]!.action.requestHeaders).toEqual([
      { header: 'Origin', operation: 'remove' }, { header: 'User-Agent', operation: 'set', value: 'axios/1.15.2' },
    ])
    expect(messages.test('https://api.anthropic.com/v1/messages')).toBe(true)
    expect(messages.test('https://api.anthropic.com/v1/messages?beta=true')).toBe(true)
    for (const url of [
      'http://api.anthropic.com/v1/messages', 'https://api.anthropic.com.evil.example/v1/messages',
      'https://api.anthropic.com/v1/messages/count_tokens', 'https://api.anthropic.com/v1/messages/',
      'https://example.com/?url=https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/models',
    ]) expect(messages.test(url)).toBe(false)
    const tokens = new RegExp(update.addRules![1]!.condition.regexFilter!)
    expect(tokens.test('https://platform.claude.com/v1/oauth/token')).toBe(true)
    expect(tokens.test('https://platform.claude.com/oauth/code/callback')).toBe(false)
    expect(tokens.test('https://claude.ai/oauth/authorize')).toBe(false)
  })

  it('deduplicates callers locally and atomically replaces only its own rules across contexts', async () => {
    const updateSessionRules = vi.fn(async () => {})
    vi.stubGlobal('chrome', { runtime: { id: extensionId }, declarativeNetRequest: { updateSessionRules } })
    const first = await import('./anthropic-browser')
    await Promise.all([first.ensureAnthropicBrowserTransport(), first.ensureAnthropicBrowserTransport()])
    await first.ensureAnthropicBrowserTransport()
    expect(updateSessionRules).toHaveBeenCalledOnce()
    vi.resetModules()
    const second = await import('./anthropic-browser')
    await second.ensureAnthropicBrowserTransport()
    expect(updateSessionRules).toHaveBeenCalledTimes(2)
    expect(updateSessionRules.mock.calls[0]).toEqual(updateSessionRules.mock.calls[1])
  })

  it('fails clearly in a real extension without the required capability', async () => {
    vi.stubGlobal('chrome', { runtime: { id: extensionId } })
    const { ensureAnthropicBrowserTransport } = await import('./anthropic-browser')
    await expect(ensureAnthropicBrowserTransport()).rejects.toThrow(/requires the updated extension permission/)
  })

  it('allows a retry after the permission or rule update was rejected', async () => {
    const updateSessionRules = vi.fn().mockRejectedValueOnce(new Error('Permission denied')).mockResolvedValue(undefined)
    vi.stubGlobal('chrome', { runtime: { id: extensionId }, declarativeNetRequest: { updateSessionRules } })
    const { ensureAnthropicBrowserTransport } = await import('./anthropic-browser')
    await expect(ensureAnthropicBrowserTransport()).rejects.toThrow(/declarativeNetRequestWithHostAccess/)
    await expect(ensureAnthropicBrowserTransport()).resolves.toBeUndefined()
    expect(updateSessionRules).toHaveBeenCalledTimes(2)
  })

  it('skips native Node callers and test environments without an extension runtime ID', async () => {
    vi.stubGlobal('chrome', undefined)
    const { ensureAnthropicBrowserTransport } = await import('./anthropic-browser')
    await expect(ensureAnthropicBrowserTransport()).resolves.toBeUndefined()
    vi.stubGlobal('chrome', { storage: {} })
    await expect(ensureAnthropicBrowserTransport()).resolves.toBeUndefined()
  })
})
