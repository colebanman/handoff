import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type VfsSkillMetadata } from '../shared/types'
import { normalizeSettings } from '../shared/normalize-settings'
import { extensionManifest, type ExtensionSummary } from '../shared/extensions'
import { createTypeSafe, TypeSafeSession, verifyExtraction, type DecisionQuestion } from './typesafe'
import { chooseSavedShortcut } from './typesafe-shortcut'
import { workspaceContext } from './runtime-context'
import { extensionContext } from './extension-context'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function server(pick: (id: string, question: DecisionQuestion) => string | number = (_, q) => q.type === 'noul' ? 0.99 : 'c0') {
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, DecisionQuestion> }
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
      const value = pick(id, q)
      return [id, q.type === 'noul' ? { type: 'noul', noul: value } : {
        type: 'choice', choice: value, confidence: 0.99,
        probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) => [key, key === value ? 1 : 0])),
      }]
    }))
    return new Response(JSON.stringify({ answers }))
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const client = (signal = new AbortController().signal) => new TypeSafeSession('test-typesafe-key', signal)
function entry(effects = 'read', input: unknown = { type: 'object' }): ExtensionSummary {
  const manifest = extensionManifest.parse({ version: 1, id: 'courses', description: 'Course assignment retrieval',
    sites: ['school.example/**'], actions: { assignments: { description: 'Read current assignments', effects, input } } })
  return { id: manifest.id, revision: 2, enabled: true, manifest, description: manifest.description,
    results: [{ name: 'read', action: 'assignments', mode: 'live', ok: true }], path: '/skills/courses', revisions: [2] }
}
const tabs = [{ id: 7, url: 'https://school.example/course' }]
const messages = [{ role: 'user' as const, content: 'Get my assignments.' }]

describe('TypeSafe transport and settings', () => {
  it('is opt-in, keeps credentials separate, trims and clears keys', () => {
    const fetcher = server()
    expect(createTypeSafe(DEFAULT_SETTINGS, new AbortController().signal)).toBeUndefined()
    expect(createTypeSafe({ ...DEFAULT_SETTINGS, typeSafeApiKey: 'key' }, new AbortController().signal)).toBeUndefined()
    expect(createTypeSafe({ ...DEFAULT_SETTINGS, typeSafeEnabled: true }, new AbortController().signal)).toBeUndefined()
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, apiKey: 'chat-key', typeSafeEnabled: true, typeSafeApiKey: ' decision-key ' })
    expect(settings.apiKey).toBe('chat-key')
    expect(settings.typeSafeApiKey).toBe('decision-key')
    expect(normalizeSettings({ ...settings, typeSafeApiKey: ' ' }).typeSafeApiKey).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('sends typed questions to the fixed endpoint and caches rankings for the turn', async () => {
    const fetcher = server()
    const session = client()
    const candidates = [{ id: 'skill', description: 'Course assignments' }]
    expect(await session.rank('Check my classes', candidates)).toEqual(new Map([['skill', 0.99]]))
    await session.rank('Check my classes', candidates)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![0]).toBe('https://api.typesafe.ai/v1/systemone')
    const request = fetcher.mock.calls[0]![1]
    expect(request.headers).toMatchObject({ Authorization: 'Bearer test-typesafe-key' })
    expect(JSON.parse(String(request.body)).model).toBe('jev-latest')
    expect(String(request.body)).not.toContain('test-typesafe-key')
    await session.rank('A different task', candidates)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([401, 429, 529])('falls back for HTTP %s without repeatedly retrying during the turn', async (status) => {
    const fetcher = vi.fn(async () => new Response('private server error', { status }))
    vi.stubGlobal('fetch', fetcher)
    const session = client()
    expect(await session.evaluate('state', { yes: { type: 'noul', instructions: 'Yes?' } })).toBeUndefined()
    expect(await session.evaluate('state', { yes: { type: 'noul', instructions: 'Yes?' } })).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed or incomplete answers and never treats them as verification success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answers: { support0: { type: 'noul', noul: 1 } } }))))
    expect(await verifyExtraction(client(), 'Assignment due Friday', [{ field: 'date', value: 'Friday', meaning: 'Assignment deadline' }]))
      .toMatchObject({ status: 'unavailable' })
  })

  it('bounds unresponsive requests and propagates cancellation', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const pending = client().evaluate('state', { yes: { type: 'noul', instructions: 'Yes?' } })
    await vi.advanceTimersByTimeAsync(3000)
    expect(await pending).toBeUndefined()
    const controller = new AbortController()
    const cancelled = client(controller.signal).evaluate('state', { yes: { type: 'noul', instructions: 'Yes?' } })
    const assertion = expect(cancelled).rejects.toThrow()
    controller.abort()
    await assertion
  })
})

describe('semantic context selection', () => {
  it('finds a skill beyond the old alphabetical cap and preserves explicit requests', () => {
    const skills: VfsSkillMetadata[] = Array.from({ length: 50 }, (_, i) => ({ name: `skill${i}`, description: 'Task helper',
      path: `/skills/${String(i).padStart(2, '0')}`, rootPath: '/skills', updatedAt: 1 }))
    const scores = new Map(skills.map((s) => [s.path, s.name === 'skill49' ? 0.99 : 0.1]))
    const context = workspaceContext([], skills, scores, 'Use $skill30 for my course')
    expect(context).toContain('$skill49')
    expect(context).toContain('$skill30')
    expect(context).toContain('38 more')
    expect(context.indexOf('$skill30')).toBeLessThan(context.indexOf('$skill49'))
    expect(workspaceContext([], skills)).not.toContain('$skill49')
  })

  it('cannot use semantic scores to expose a disabled or out-of-scope browser function', () => {
    const saved = entry()
    const scores = new Map([['courses.assignments@2', 1]])
    const options = { isSubagent: true, currentTabId: 1, allowedTabIds: [1] }
    expect(extensionContext([saved], 'Get assignments', tabs, options, undefined, true, scores).block).not.toContain('apps.courses')
    expect(extensionContext([{ ...saved, enabled: false }], 'Get assignments', tabs,
      { isSubagent: false, currentTabId: 7 }, undefined, true, scores).block).not.toContain('apps.courses')
  })
})

describe('saved-function shortcuts', () => {
  it('selects a tested read and enum inputs, binding the real tab without generating code', async () => {
    server((id, q) => q.type === 'noul' ? 0.99 : id === 'action' ? 'c0' : 'v1')
    const saved = entry('read', { type: 'object', required: ['period'], properties: { period: { type: 'string', enum: ['today', 'week'] } } })
    const result = await chooseSavedShortcut(client(), [saved], tabs, messages)
    expect(result).toMatchObject({ id: 'courses', revision: 2, path: 'assignments', tabId: 7, input: { period: 'week' } })
    const assignments = vi.fn(async () => ['Fresh result'])
    const bind = vi.fn(() => ({ assignments }))
    const value = await new Function('apps', `return (async () => { ${result!.code} })()` )({ courses: { for: bind } })
    expect(value).toEqual(['Fresh result'])
    expect(bind).toHaveBeenCalledWith({ tabId: 7 })
    expect(assignments).toHaveBeenCalledWith({ period: 'week' })
  })

  it('falls back without contacting TypeSafe for writes, missing free-text inputs, disabled functions, and missing matching tabs', async () => {
    const fetcher = server()
    for (const saved of [entry('write'), entry('browser'), { ...entry(), enabled: false },
      entry('read', { type: 'object', required: ['query'], properties: { query: { type: 'string' } } }),
      { ...entry(), results: [] }]) {
      expect(await chooseSavedShortcut(client(), [saved], tabs, messages)).toBeUndefined()
    }
    expect(await chooseSavedShortcut(client(), [entry()], [{ id: 1, url: 'https://other.example' }], messages)).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('falls back on unknown inputs and ambiguous or non-actionable requests', async () => {
    server((id, q) => q.type === 'noul' ? 0.99 : id === 'action' ? 'c0' : 'unknown')
    expect(await chooseSavedShortcut(client(), [entry('read', { type: 'object', properties: { period: { type: 'boolean' } } })], tabs, messages)).toBeUndefined()
    server((_, q) => q.type === 'noul' ? 0.5 : 'c0')
    expect(await chooseSavedShortcut(client(), [entry()], tabs, messages)).toBeUndefined()
  })

  it('never replays a shortcut when resuming a turn that has assistant progress', async () => {
    const fetcher = server()
    expect(await chooseSavedShortcut(client(), [entry()], tabs, [...messages, { role: 'assistant', content: 'I already fetched the assignments.' }])).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('extraction checks', () => {
  it('distinguishes supported, unsupported and uncertain fields and exposes the reason signals', async () => {
    const fetcher = server((id) => id === 'support1' ? 0.05 : id === 'match2' ? 0.5 : 0.99)
    const fields = ['assignmentDate', 'registrationDate', 'timeZone'].map((field) => ({ field, value: 'value', meaning: `The ${field} of Biology assignment 1` }))
    const result = await verifyExtraction(client(), 'The original page text.', fields)
    expect(result.status).toBe('review')
    expect(result.fields?.map((f) => f.status)).toEqual(['supported', 'unsupported', 'uncertain'])
    expect(Object.keys(JSON.parse(String(fetcher.mock.calls[0]![1].body)).questions)).toHaveLength(6)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
