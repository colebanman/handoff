import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CdpService, VirtualFileSystemService, VfsEntry } from '../shared/types'
import { createApiDispatch } from './api-dispatch'
import { resetSharedSurfaceAssignments, sharedSurfaceAssignments } from '../agent/surfaces'

afterEach(() => { vi.unstubAllGlobals(); resetSharedSurfaceAssignments() })

describe('documented sandbox contracts', () => {
  it('refuses tab and group mutations that would interfere with a running child', async () => {
    sharedSurfaceAssignments().claim('sub-a', [7])
    const remove = vi.fn(), update = vi.fn()
    vi.stubGlobal('chrome', { tabs: { remove, query: async () => [{ id: 7 }] }, tabGroups: { update } })
    const dispatch = createApiDispatch({} as CdpService, {} as VirtualFileSystemService, { agentId: 'main', surfaceOwnerId: 'main:chat-b' })
    await expect(dispatch('tabs.close', [7])).rejects.toThrow('owned by sub-a')
    await expect(dispatch('tabGroups.update', [3, { collapsed: true }])).rejects.toThrow('owned by sub-a')
    expect(remove).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
  it('isolates main-agent scratch data and restores it for the same sandbox session', async () => {
    const make = (sessionId: string) => createApiDispatch({} as CdpService, {} as VirtualFileSystemService, { agentId: 'main', sessionId })
    await make('chat-a')('storage.set', ['records', ['account A']])
    await expect(make('chat-b')('storage.get', ['records'])).resolves.toBeNull()
    await expect(make('chat-a')('storage.get', ['records'])).resolves.toEqual(['account A'])
  })

  it('rejects implicit partial text reads but supports intentional excerpts and pagination', async () => {
    const readText = vi.fn().mockResolvedValue({ text: 'prefix', totalChars: 200_000, truncated: true })
    const dispatch = createApiDispatch({} as CdpService, { readText } as unknown as VirtualFileSystemService)
    await expect(dispatch('fs.readText', ['/workspace/large.csv'])).rejects.toThrow('api.fs.extractText')
    await expect(dispatch('fs.readText', ['/workspace/large.csv', { maxChars: 6 }])).resolves.toBe('prefix')
    await expect(dispatch('fs.extractText', ['/workspace/large.csv'])).resolves.toMatchObject({ truncated: true, totalChars: 200_000 })
  })

  it('passes the advertised search scope to VFS before limiting results', async () => {
    const search = vi.fn().mockResolvedValue([])
    const dispatch = createApiDispatch({} as CdpService, { search } as unknown as VirtualFileSystemService)
    await dispatch('fs.search', ['record', { rootOrPath: '/workspace/project', maxResults: 2 }])
    expect(search).toHaveBeenCalledWith('record', { root: 'workspace', prefix: '/workspace/project', maxResults: 2 })
  })

  it('adds to a returned group rather than silently creating another one', async () => {
    const group = vi.fn().mockResolvedValue(17)
    vi.stubGlobal('chrome', { tabs: { group } })
    const dispatch = createApiDispatch({} as CdpService, {} as VirtualFileSystemService)
    const result = await dispatch('tabs.group', [{ tabIds: [1, 2] }])
    expect(result).toEqual({ groupId: 17, tabIds: [1, 2] })
    await dispatch('tabs.group', [{ tabIds: [3], groupId: result }])
    expect(group).toHaveBeenLastCalledWith({ tabIds: [3], groupId: 17 })
    await expect(dispatch('tabs.group', [{ tabIds: [3], groupId: 'invalid' }])).rejects.toThrow('numeric groupId')
    expect(group).toHaveBeenCalledTimes(2)
  })

  it('throws on binary page.fetch bodies while preserving ordinary HTTP errors', async () => {
    const evalInPage = vi.fn().mockResolvedValueOnce({ ok: true, binary: true, error: 'Use api.fs.importUrl' })
      .mockResolvedValueOnce({ ok: false, status: 403, text: 'Forbidden' })
    const dispatch = createApiDispatch({ evalInPage } as unknown as CdpService, {} as VirtualFileSystemService)
    await expect(dispatch('page.fetch', [7, 'https://example.com/a.pdf'])).rejects.toThrow('api.fs.importUrl')
    await expect(dispatch('page.fetch', [7, 'https://example.com/a.json'])).resolves.toMatchObject({ ok: false, status: 403 })
  })
})

describe('offline sandbox scope', () => {
  it('supports paginated file reads, writes, and isolated scratch storage', async () => {
    const page = { path: '/workspace/pack.json', text: 'tail', truncated: false, totalChars: 104 }
    const readText = vi.fn().mockResolvedValue(page)
    const writeText = vi.fn().mockResolvedValue({ path: '/workspace/result.json' })
    const dispatch = createApiDispatch({} as CdpService, { readText, writeText } as unknown as VirtualFileSystemService, {
      offlineOnly: true, allowedTabIds: [],
    })
    await expect(dispatch('fs.extractText', ['/workspace/pack.json', { offset: 100, maxChars: 4 }])).resolves.toEqual(page)
    expect(readText).toHaveBeenCalledWith('/workspace/pack.json', { offset: 100, maxChars: 4 })
    await dispatch('fs.writeText', ['/workspace/result.json', '[]'])
    expect(writeText).toHaveBeenCalledWith('/workspace/result.json', '[]', expect.anything())
    await dispatch('storage.set', ['count', 130])
    await expect(dispatch('storage.get', ['count'])).resolves.toBe(130)
    const other = createApiDispatch({} as CdpService, {} as VirtualFileSystemService, { offlineOnly: true, allowedTabIds: [] })
    await expect(other('storage.get', ['count'])).resolves.toBeNull()
  })

  it.each([
    'fetch', 'fs.importUrl', 'require.source', 'cdp',
    'page.eval', 'page.navigate', 'page.fetch', 'frames.eval', 'net.body',
    'tabs.list', 'tabs.create', 'tabs.get', 'tabGroups.list',
    'history.search', 'bookmarks.search', 'downloads.search',
    'artifacts.create', 'artifacts.eval', 'artifacts.open',
    'extensions.resolve', 'automations.create', 'stickies.open', 'fs.futureApi',
  ])('rejects %s before dispatching it', async (path) => {
    const dispatch = createApiDispatch({} as CdpService, {} as VirtualFileSystemService, {
      offlineOnly: true, allowedTabIds: [],
    })
    await expect(dispatch(path, [])).rejects.toThrow(`api.${path} is unavailable to offline-only subagents`)
  })
})

describe('site-context tab observations', () => {
  it('reports explicit and default sandbox tabs only after scope validation', async () => {
    const observed = vi.fn()
    const dispatch = createApiDispatch(
      { send: vi.fn().mockResolvedValue({}) } as unknown as CdpService,
      {} as VirtualFileSystemService,
      { allowedTabIds: [7, 8], getCurrentTabId: () => 7, onTabObserved: observed },
    )
    await dispatch('cdp', [8, 'Page.getLayoutMetrics'])
    await dispatch('cdp', [null, 'Page.getLayoutMetrics'])
    await expect(dispatch('cdp', [9, 'Page.getLayoutMetrics'])).rejects.toThrow()
    expect(observed.mock.calls).toEqual([[8], [7]])
  })
})

describe('page.attachFiles sandbox API', () => {
  it('reads complete VFS files and forwards them to the page attachment primitive', async () => {
    const entry: VfsEntry = {
      path: '/workspace/resume.pdf',
      root: 'workspace',
      name: 'resume.pdf',
      mediaType: 'application/pdf',
      size: 4,
      createdAt: 10,
      updatedAt: 20,
    }
    const attachFiles = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'input',
      target: 'input',
      count: 1,
      names: ['resume.pdf'],
    })
    const cdp = { attachFiles } as unknown as CdpService
    const vfs = {
      getEntry: vi.fn().mockResolvedValue(entry),
      readBytes: vi.fn().mockResolvedValue({
        path: entry.path,
        base64: 'dGVzdA==',
        mediaType: entry.mediaType,
        size: entry.size,
        truncated: false,
      }),
    } as unknown as VirtualFileSystemService
    const dispatch = createApiDispatch(cdp, vfs, {
      allowedTabIds: [7],
      getCurrentTabId: () => 7,
    })

    const result = await dispatch('page.attachFiles', [
      '/workspace/resume.pdf',
      { selector: 'input[type=file]', mode: 'input' },
    ])

    expect(vfs.readBytes).toHaveBeenCalledWith(entry.path, { length: entry.size })
    expect(attachFiles).toHaveBeenCalledWith(
      7,
      { ref: undefined, selector: 'input[type=file]', mode: 'input' },
      [{
        name: entry.name,
        mediaType: entry.mediaType,
        size: entry.size,
        base64: 'dGVzdA==',
        lastModified: entry.updatedAt,
      }],
      undefined,
    )
    expect(result).toEqual({ ok: true, mode: 'input', target: 'input', count: 1, names: ['resume.pdf'] })
  })

  it('rejects host paths instead of pretending the page can see them', async () => {
    const dispatch = createApiDispatch({} as CdpService, {} as VirtualFileSystemService)
    await expect(dispatch('page.attachFiles', [7, '/Users/me/resume.pdf', { mode: 'drop' }])).rejects.toThrow(
      'path outside the virtual filesystem',
    )
  })
})

describe('artifacts sandbox API', () => {
  const entry = (path: string, mediaType = 'text/html'): VfsEntry => ({
    path,
    root: 'workspace',
    name: path.split('/').at(-1)!,
    mediaType,
    size: 10,
    createdAt: 1,
    updatedAt: 2,
  })

  it('refuses artifacts.* without a host but still resolves urls', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://ext/${p}` } })
    const dispatch = createApiDispatch({} as CdpService, {} as VirtualFileSystemService)
    await expect(dispatch('artifacts.eval', ['week', '1'])).rejects.toThrow(/only available to the agent runtime/)
    await expect(dispatch('artifacts.url', ['week'])).resolves.toBe(
      'chrome-extension://ext/artifact.html?path=%2Fworkspace%2Fartifacts%2Fweek.html',
    )
  })

  it('creates artifacts in /workspace/artifacts, opens on request, and reports viewers in list', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://ext/${p}` } })
    const writeText = vi.fn(async (path: string) => entry(path))
    const vfs = {
      writeText,
      getEntry: vi.fn(async (path: string) => entry(path)),
      list: vi.fn(async () => [entry('/workspace/artifacts/week.html'), entry('/workspace/notes.md', 'text/markdown')]),
    } as unknown as VirtualFileSystemService
    const artifacts = {
      list: vi.fn(() => [{ path: '/workspace/artifacts/week.html', url: 'u', tabId: 7, embed: false, ready: true }]),
      open: vi.fn(async () => ({ tabId: 7, url: 'u', created: true })),
      eval: vi.fn(async () => ({ value: 3, logs: [] })),
      save: vi.fn(),
      reload: vi.fn(),
      logs: vi.fn(async () => ['[error] boom']),
      trace: vi.fn(async () => [{ at: 0, path: 'fetch', args: 'https://x/api', ok: true, ms: 12, status: 200 }]),
      reset: vi.fn(async () => undefined),
      screenshot: vi.fn(),
      close: vi.fn(async () => 1),
    }
    const onTabCreated = vi.fn()
    const dispatch = createApiDispatch({} as CdpService, vfs, { onTabCreated }, undefined, { artifacts })

    const created = await dispatch('artifacts.create', [{ path: 'week', html: '<h1>Week</h1>' }])
    expect(writeText).toHaveBeenCalledWith('/workspace/artifacts/week.html', '<h1>Week</h1>', { mediaType: 'text/html', signal: undefined })
    expect(created).toMatchObject({ path: '/workspace/artifacts/week.html', tabId: null })
    expect(artifacts.open).not.toHaveBeenCalled()

    await dispatch('artifacts.create', ['inbox.html', '<p/>', { open: true, active: true }])
    expect(artifacts.open).toHaveBeenLastCalledWith('/workspace/artifacts/inbox.html', { active: true, signal: undefined })

    await dispatch('artifacts.open', ['week'])
    expect(onTabCreated).toHaveBeenCalledWith(7)

    await expect(dispatch('artifacts.eval', ['week', '1 + 2', { timeoutMs: 500 }])).resolves.toEqual({ value: 3, logs: [] })
    expect(artifacts.eval).toHaveBeenCalledWith('/workspace/artifacts/week.html', '1 + 2', { timeoutMs: 500, signal: undefined })
    await expect(dispatch('artifacts.logs', ['week'])).resolves.toEqual(['[error] boom'])
    await expect(dispatch('artifacts.close', ['week'])).resolves.toEqual({ closed: 1 })
    await expect(dispatch('artifacts.trace', ['week'])).resolves.toEqual([
      { at: '1970-01-01T00:00:00.000Z', call: 'ai.fetch(https://x/api)', ok: true, status: 200, ms: 12, error: null },
    ])
    await expect(dispatch('artifacts.reset', ['week'])).resolves.toMatchObject({ ok: true })
    expect(artifacts.reset).toHaveBeenCalledWith('/workspace/artifacts/week.html', { signal: undefined })

    const listed = (await dispatch('artifacts.list', [])) as Array<Record<string, unknown>>
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      path: '/workspace/artifacts/week.html',
      inArtifactsDir: true,
      viewers: [{ tabId: 7, embed: false, ready: true }],
    })
  })
})

describe('tabs.activate choreography', () => {
  it('routes the activation through the cursor tab switch when the service offers one', async () => {
    vi.stubGlobal('chrome', {
      tabs: { update: vi.fn().mockResolvedValue({ id: 5, index: 1, active: true }) },
    })
    const switchTabs = vi.fn(async (opts: { activate: () => Promise<void> }) => {
      await opts.activate()
    })
    const setCurrentTabId = vi.fn()
    const signal = new AbortController().signal
    const dispatch = createApiDispatch(
      { switchTabs } as unknown as CdpService,
      {} as VirtualFileSystemService,
      { setCurrentTabId },
      signal,
    )

    await dispatch('tabs.activate', [5])

    expect(switchTabs).toHaveBeenCalledOnce()
    expect(switchTabs.mock.calls[0]![0]).toMatchObject({ toTab: 5, signal })
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { active: true })
    expect(setCurrentTabId).toHaveBeenCalledWith(5)
    vi.unstubAllGlobals()
  })
})

describe('verified form sandbox APIs', () => {
  it('forwards default and explicit tab calls to the shared driver with cancellation', async () => {
    const result = { ok: true, fields: [{ ref: 'e1', status: 'verified' }] }
    const fill = vi.fn().mockResolvedValue(result), select = vi.fn().mockResolvedValue(result)
    const controller = new AbortController()
    const dispatch = createApiDispatch({ fill, select } as unknown as CdpService, {} as VirtualFileSystemService,
      { getCurrentTabId: () => 7, allowedTabIds: [7] }, controller.signal)
    await expect(dispatch('page.fill', [[{ ref: 'e1', select: 'No' }]])).resolves.toEqual(result)
    expect(fill).toHaveBeenCalledWith(7, [{ ref: 'e1', select: 'No' }], controller.signal)
    await dispatch('page.select', [7, 'e1', 'Yes'])
    await dispatch('page.select', ['e1', 'No'])
    expect(select).toHaveBeenLastCalledWith(7, 'e1', 'No', controller.signal)
    await expect(dispatch('page.fill', [8, [{ ref: 'e1', checked: true }]])).rejects.toThrow('scope')
    await expect(dispatch('page.fill', [7, [{ ref: 'e1', text: 'a', select: 'No' }]])).rejects.toThrow()
    await expect(dispatch('page.select', [7, 'e1', ' '])).rejects.toThrow()
    expect(fill).toHaveBeenCalledTimes(1)
    controller.abort()
    await expect(dispatch('page.select', [7, 'e1', 'No'])).rejects.toMatchObject({ name: 'AbortError' })
    expect(select).toHaveBeenCalledTimes(2)
  })
  it.each(['page.fill', 'page.select'])('rejects %s in offline mode before browser access', async path => {
    const dispatch = createApiDispatch({} as CdpService, {} as VirtualFileSystemService, { offlineOnly: true, allowedTabIds: [] })
    await expect(dispatch(path, [])).rejects.toThrow('offline-only')
  })
})
