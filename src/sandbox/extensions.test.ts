import { describe, expect, it, vi } from 'vitest'
import { parseBundle } from '../shared/extensions'
import { createExtensionRuntime } from './extensions'
import type { JsonValue } from '../shared/rpc'
const bundle = parseBundle({
  manifest: { version: 1, id: 'example', description: 'Example', triggers: ['example'], actions: {
    'api.read': { description: 'Read a record', effects: 'read', input: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } }, output: { type: 'string' } },
  } },
  source: 'module.exports = {api:{read: async (ctx, input) => (await ctx.api.fetch(input.path)).text}}',
  tests: [{ name: 'record', action: 'api.read', input: { path: '/record' }, mode: 'fixture', replies: { fetch: [{ text: 'record' }] }, assert: [{ equals: 'record' }] }],
})

describe('executable skill loader', () => {
  it('binds cached source to the current execution, never a prior API closure', async () => {
    const call = vi.fn(async () => ({ ...bundle, revision: 1, binding: {}, config: {} }) as unknown as JsonValue)
    const first = createExtensionRuntime(call, () => ({ fetch: async () => ({ text: 'first execution' }) }), console)
    const second = createExtensionRuntime(call, () => ({ fetch: async () => ({ text: 'second execution' }) }), console)
    expect(await (first.apps as any).example.api.read({ path: '/record' })).toBe('first execution')
    expect(await (second.apps as any).example.for({ tabId: 42 }).api.read({ path: '/record' })).toBe('second execution')
    expect(call.mock.calls.at(-1)).toEqual(['extensions.resolve', [{ id: 'example', action: 'api.read', binding: { tabId: 42 } }]])
  })
  it('tests through the same loader and records actual assertion failures', async () => {
    const responses: unknown[] = []
    const call = async (path: string, args: JsonValue[]) => {
      if (path === 'extensions.draft') return { ...bundle, draftId: 'draft' } as unknown as JsonValue
      responses.push(args[0]); return args[0]!
    }
    const runtime = createExtensionRuntime(call, () => { throw new Error('Fixture must not call live API') }, console)
    await (runtime.management as any).test({ draftId: 'draft' })
    expect(responses[0]).toMatchObject({ results: [{ ok: true, mode: 'fixture' }] })
    const broken = structuredClone(bundle); broken.source = broken.source.replace('.text', '.wrong')
    const bad = createExtensionRuntime(async (path, args) => path === 'extensions.draft' ? broken as unknown as JsonValue : args[0]!, () => ({}), console)
    expect(await (bad.management as any).test({ draftId: 'draft' })).toMatchObject({ results: [{ ok: false }] })
  })
  it('rejects mismatched exports and invalid inputs before running effects', async () => {
    const api = { fetch: vi.fn() }
    const runtime = createExtensionRuntime(async () => ({ ...bundle, binding: {}, revision: 1 }) as unknown as JsonValue, () => api, console)
    await expect((runtime.apps as any).example.api.read({})).rejects.toThrow('required')
    expect(api.fetch).not.toHaveBeenCalled()
    const bad = createExtensionRuntime(async () => ({ ...bundle, source: 'module.exports = {other: () => 1}', binding: {} }) as unknown as JsonValue, () => api, console)
    await expect((bad.apps as any).example.api.read({ path: '/' })).rejects.toThrow('exactly match')
  })
  it('requires an explicit live test invocation', async () => {
    const live = { ...bundle, tests: bundle.tests.map((t) => ({ ...t, mode: 'live' })) }
    const fetch = vi.fn()
    const runtime = createExtensionRuntime(async (path, args) => path === 'extensions.draft' ? live as unknown as JsonValue : args[0]!, () => ({ fetch }), console)
    expect(await (runtime.management as any).test({ draftId: 'draft' })).toMatchObject({ results: [{ ok: false, error: expect.stringContaining('live:true') }] })
    expect(fetch).not.toHaveBeenCalled()
  })
})
