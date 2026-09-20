import { describe, expect, it, vi } from 'vitest'
import type { CdpService, VirtualFileSystemService, VfsEntry } from '../shared/types'
import { createApiDispatch } from './api-dispatch'

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
