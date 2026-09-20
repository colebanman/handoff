import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CdpServiceImpl } from './service'

describe('CdpServiceImpl.attachFiles', () => {
  it('stages bytes in chunks and invokes the page with a real input/drop implementation', async () => {
    const service = Object.create(CdpServiceImpl.prototype) as CdpServiceImpl
    vi.spyOn(service, 'attach').mockResolvedValue()
    const send = vi.spyOn(service, 'send')
      .mockResolvedValueOnce({ result: { objectId: 'node-1' } })
      .mockResolvedValueOnce({ result: { value: true } })
      .mockResolvedValueOnce({ result: { value: 1 } })
      // Pointer cue before the dispatch: no backendNodeId here, so it is skipped.
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        result: {
          value: { ok: true, mode: 'drop', target: 'div', count: 1, names: ['photo.png'] },
        },
      })
      .mockResolvedValueOnce({ result: { value: true } })
      .mockResolvedValueOnce({})

    const result = await service.attachFiles(
      12,
      { selector: '#drop-zone', mode: 'drop' },
      [{ name: 'photo.png', mediaType: 'image/png', size: 3, base64: 'YWJj', lastModified: 123 }],
    )

    expect(result).toEqual({ ok: true, mode: 'drop', target: 'div', count: 1, names: ['photo.png'] })
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      'Runtime.evaluate',
      'Runtime.evaluate',
      'Runtime.evaluate',
      'DOM.describeNode',
      'Runtime.callFunctionOn',
      'Runtime.evaluate',
      'Runtime.releaseObject',
    ])
    const callParams = send.mock.calls[4]![2] as {
      objectId: string
      functionDeclaration: string
      arguments: Array<{ value: string }>
      userGesture: boolean
    }
    expect(callParams.objectId).toBe('node-1')
    expect(callParams.arguments[1]?.value).toBe('drop')
    expect(callParams.userGesture).toBe(true)
    expect(callParams.functionDeclaration).toContain('new File(')
    expect(callParams.functionDeclaration).toContain("new DragEvent(type")
    expect(callParams.functionDeclaration).toContain("new Event('change'")
  })
})

/** Bare instance: the constructor needs chrome.* that unit tests don't have. */
function makeService(cursor: Record<string, unknown>): CdpServiceImpl {
  const service = Object.create(CdpServiceImpl.prototype) as CdpServiceImpl
  Object.defineProperty(service, 'activityCursor', { value: cursor, writable: true })
  vi.spyOn(service, 'attach').mockResolvedValue()
  return service
}

describe('CdpServiceImpl.send cursor hooks', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      debugger: {
        sendCommand: (_target: unknown, _method: string, _params: unknown, cb: (r: unknown) => void) => cb({}),
      },
      runtime: {},
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('carries the scroll direction on mouseWheel', async () => {
    const show = vi.fn()
    const service = makeService({ show, hideOnNavigate: vi.fn() })
    await service.send(7, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 10, y: 20, deltaY: -300 })
    expect(show).toHaveBeenCalledWith(7, { kind: 'scroll', x: 10, y: 20, dy: -300 }, undefined)
  })

  it('leaves no dy on a plain move', async () => {
    const show = vi.fn()
    const service = makeService({ show, hideOnNavigate: vi.fn() })
    await service.send(7, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 2 })
    expect(show).toHaveBeenCalledWith(7, { kind: 'move', x: 1, y: 2 }, undefined)
  })

  it('soft-hides on navigation so the position survives the new document', async () => {
    const hideOnNavigate = vi.fn()
    const hide = vi.fn()
    const service = makeService({ show: vi.fn(), hideOnNavigate, hide })
    await service.send(7, 'Page.navigate', { url: 'https://example.com' })
    await service.send(7, 'Page.reload')
    expect(hideOnNavigate.mock.calls).toEqual([[7], [7]])
    expect(hide).not.toHaveBeenCalled()
  })
})

describe('CdpServiceImpl pointer arrival', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      debugger: {
        sendCommand: (_target: unknown, _method: string, _params: unknown, cb: (r: unknown) => void) => cb({}),
      },
      runtime: {},
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  /** click()/scroll() resolve coordinates through private helpers; stub them out. */
  function stubGeometry(service: CdpServiceImpl, point = { x: 10, y: 20 }): void {
    const internals = service as unknown as {
      resolveRef: (tabId: number, ref: string) => number
      centerOf: (tabId: number, backendNodeId: number, signal?: AbortSignal) => Promise<{ x: number; y: number }>
    }
    vi.spyOn(internals, 'resolveRef').mockReturnValue(5)
    vi.spyOn(internals, 'centerOf').mockResolvedValue(point)
  }

  it('lets the pointer arrive before the click dispatch', async () => {
    const order: string[] = []
    const showAndWait = vi.fn(async () => { order.push('cursor') })
    const service = makeService({ showAndWait, show: vi.fn() })
    stubGeometry(service)
    vi.spyOn(service, 'send').mockImplementation(async (_tabId: number, method: string) => {
      order.push(method)
      return undefined as never
    })

    const signal = new AbortController().signal
    await service.click(7, 'e1', signal)

    expect(showAndWait).toHaveBeenCalledWith(7, { kind: 'move', x: 10, y: 20 }, signal)
    expect(order).toEqual([
      'cursor', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent',
    ])
  })

  it('lets the pointer arrive before the wheel dispatch', async () => {
    const order: string[] = []
    const showAndWait = vi.fn(async () => { order.push('cursor') })
    const service = makeService({ showAndWait, show: vi.fn() })
    stubGeometry(service, { x: 44, y: 55 })
    vi.spyOn(service, 'send').mockImplementation(async (_tabId: number, method: string) => {
      order.push(method)
      return undefined as never
    })

    await service.scroll(7, { ref: 'e1', dy: 200 })

    expect(showAndWait).toHaveBeenCalledWith(7, { kind: 'move', x: 44, y: 55 }, undefined)
    expect(order).toEqual(['cursor', 'Input.dispatchMouseEvent'])
  })
})

describe('CdpServiceImpl.switchTabs', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubTabs(win: Partial<chrome.windows.Window>): void {
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 2, index: 1, windowId: 9 }),
        query: vi.fn(async (q: { active?: boolean }) =>
          q.active
            ? [{ id: 1, index: 0, pinned: false }]
            : [
                { id: 1, index: 0, pinned: false },
                { id: 2, index: 1, pinned: false },
                { id: 3, index: 2, pinned: false },
              ],
        ),
      },
      windows: { get: vi.fn().mockResolvedValue(win) },
    })
  }

  it('estimates the strip x and defaults fromTab to the window\'s active tab', async () => {
    stubTabs({ width: 1200 })
    const switchTabs = vi.fn().mockResolvedValue(undefined)
    const service = makeService({ switchTabs })
    const signal = new AbortController().signal
    const activate = vi.fn().mockResolvedValue(undefined)

    await service.switchTabs({ toTab: 2, signal, activate })

    expect(switchTabs).toHaveBeenCalledWith({ fromTab: 1, toTab: 2, signal, stripX: 360, activate })
  })

  it('drops the estimate when the window is too narrow', async () => {
    stubTabs({ width: 400 })
    const switchTabs = vi.fn().mockResolvedValue(undefined)
    const service = makeService({ switchTabs })
    const signal = new AbortController().signal

    await service.switchTabs({ toTab: 2, signal, activate: vi.fn().mockResolvedValue(undefined) })

    expect(switchTabs.mock.calls[0]![0].stripX).toBeUndefined()
  })

  it('passes the target favicon through as a data URL', async () => {
    stubTabs({ width: 1200 })
    const tabs = (globalThis as unknown as { chrome: { tabs: { get: ReturnType<typeof vi.fn> } } }).chrome.tabs
    tabs.get.mockResolvedValue({ id: 2, index: 1, windowId: 9, favIconUrl: 'https://example.com/favicon.ico' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/x-icon' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }))
    const switchTabs = vi.fn().mockResolvedValue(undefined)
    const service = makeService({ switchTabs })

    await service.switchTabs({ toTab: 2, signal: new AbortController().signal, activate: vi.fn().mockResolvedValue(undefined) })

    expect(switchTabs.mock.calls[0]![0].icon).toBe(`data:image/x-icon;base64,${btoa('\x01\x02\x03')}`)
  })

  it('omits an unreachable favicon rather than delaying the switch', async () => {
    stubTabs({ width: 1200 })
    const tabs = (globalThis as unknown as { chrome: { tabs: { get: ReturnType<typeof vi.fn> } } }).chrome.tabs
    tabs.get.mockResolvedValue({ id: 2, index: 1, windowId: 9, favIconUrl: 'chrome://favicon/x' })
    const switchTabs = vi.fn().mockResolvedValue(undefined)
    const service = makeService({ switchTabs })

    await service.switchTabs({ toTab: 2, signal: new AbortController().signal, activate: vi.fn().mockResolvedValue(undefined) })

    expect(switchTabs.mock.calls[0]![0].icon).toBeUndefined()
  })

  it('activates directly with no signal to choreograph against', async () => {
    const switchTabs = vi.fn()
    const service = makeService({ switchTabs })
    const activate = vi.fn().mockResolvedValue(undefined)

    await service.switchTabs({ toTab: 2, activate })

    expect(activate).toHaveBeenCalledOnce()
    expect(switchTabs).not.toHaveBeenCalled()
  })
})
