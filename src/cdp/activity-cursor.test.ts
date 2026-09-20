import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActivityCursor, ARRIVAL_WAIT_CAP_MS, estimateTabStripX } from './activity-cursor'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('ActivityCursor lifecycle', () => {
  function setup() {
    const executeScript = vi.fn().mockResolvedValue([])
    vi.stubGlobal('chrome', { scripting: { executeScript } })
    return { cursor: new ActivityCursor(), executeScript }
  }

  it('keeps a positioned cursor alive through long and overlapping tools, then stops heartbeats', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    const finish = cursor.begin(run.signal)
    const endA = cursor.beginTool(run.signal)
    await vi.advanceTimersByTimeAsync(4000)
    expect(executeScript).not.toHaveBeenCalled() // No guessed initial position.
    cursor.show(1, { kind: 'click', x: 30, y: 40 }, run.signal)
    const endB = cursor.beginTool(run.signal)
    await vi.advanceTimersByTimeAsync(12000)
    expect(executeScript.mock.calls.filter(([call]) => call.args[0].kind === 'keepalive').length).toBeGreaterThanOrEqual(6)
    endA()
    await vi.advanceTimersByTimeAsync(4000)
    expect(executeScript.mock.calls.at(-1)![0].args[0].kind).toBe('keepalive')
    endB()
    await vi.advanceTimersByTimeAsync(0)
    const count = executeScript.mock.calls.length
    await vi.advanceTimersByTimeAsync(12000)
    expect(executeScript).toHaveBeenCalledTimes(count)
    finish()
  })

  it('cancellation stops a running tool heartbeat and ignores its late completion', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.begin(run.signal)
    const endTool = cursor.beginTool(run.signal)
    cursor.show(1, { kind: 'click', x: 30, y: 40 }, run.signal)
    await vi.advanceTimersByTimeAsync(2000)
    run.abort()
    await vi.advanceTimersByTimeAsync(0)
    const count = executeScript.mock.calls.length
    endTool()
    await vi.advanceTimersByTimeAsync(12000)
    expect(executeScript).toHaveBeenCalledTimes(count)
    expect(executeScript.mock.calls.at(-1)![0].args[0]).toMatchObject({ kind: 'hide', immediate: true })
  })

  it('only shows for live runs and clears on abort, rejecting late tool updates', async () => {
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.show(1, { kind: 'click', x: 40, y: 50 }, run.signal)
    expect(executeScript).not.toHaveBeenCalled()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'click', x: 40, y: 50 }, run.signal)
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(1))
    run.abort()
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(2))
    expect(executeScript.mock.calls[1]![0].args[0].kind).toBe('hide')
    cursor.show(1, { kind: 'type' }, run.signal)
    expect(executeScript).toHaveBeenCalledTimes(2)
  })

  it('finishing one run leaves the newer owner of a shared tab visible', async () => {
    const { cursor, executeScript } = setup()
    const a = new AbortController(), b = new AbortController()
    const endA = cursor.begin(a.signal)
    const endB = cursor.begin(b.signal)
    cursor.show(1, { kind: 'move', x: 10, y: 20 }, a.signal)
    cursor.show(1, { kind: 'click', x: 30, y: 40 }, b.signal)
    endA()
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(2))
    expect(executeScript.mock.calls.map(([call]) => call.args[0].kind)).toEqual(['move', 'click'])
    endB()
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(3))
    expect(executeScript.mock.calls[2]![0].args[0].kind).toBe('finish')
  })

  it('orders capture cleanup after in-flight injection and coalesces queued updates', async () => {
    const { cursor, executeScript } = setup()
    let release!: () => void
    executeScript.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'move', x: 10, y: 10 }, run.signal)
    cursor.show(1, { kind: 'click', x: 20, y: 20 }, run.signal)
    const hidden = cursor.hide(1, true)
    expect(executeScript).toHaveBeenCalledTimes(1)
    release()
    await hidden
    expect(executeScript.mock.calls.map(([call]) => call.args[0])).toEqual([
      { kind: 'move', x: 10, y: 10, captureHidden: false, armedFor: 0, lifetime: 30000 },
      { kind: 'hide', immediate: true, captureHidden: false, lifetime: 30000 },
    ])
  })

  it('temporarily suppresses screenshots without forgetting ownership or the destination', async () => {
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    const end = cursor.begin(run.signal)
    cursor.show(1, { kind: 'move', x: 10, y: 10 }, run.signal)
    await cursor.withoutCursor(1, async () => {
      expect(executeScript.mock.calls.at(-1)![0].args[0].captureHidden).toBe(true)
      cursor.show(1, { kind: 'click', x: 50, y: 50 }, run.signal)
      await Promise.resolve()
    })
    expect(executeScript.mock.calls.at(-1)![0].args[0].captureHidden).toBe(false)
    expect(executeScript.mock.calls.some(([call]) => call.args[0].kind === 'hide')).toBe(false)
    end()
    await vi.waitFor(() => expect(executeScript.mock.calls.at(-1)![0].args[0].kind).toBe('finish'))
  })

  it('restores after capture errors, but never resurrects an aborted run', async () => {
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'move', x: 10, y: 10 }, run.signal)
    await expect(cursor.withoutCursor(1, async () => { throw Error('capture failed') })).rejects.toThrow('capture failed')
    expect(executeScript.mock.calls.at(-1)![0].args[0].captureHidden).toBe(false)
    await cursor.withoutCursor(1, async () => { run.abort() })
    expect(executeScript.mock.calls.at(-1)![0].args[0].kind).toBe('hide')
  })

  it('treats injection failure as cosmetic and permits later activity', async () => {
    const { cursor, executeScript } = setup()
    executeScript.mockRejectedValueOnce(new Error('Cannot access this page'))
    const run = new AbortController()
    const end = cursor.begin(run.signal)
    cursor.show(1, { kind: 'move', x: 10, y: 10 }, run.signal)
    await cursor.hide(1)
    cursor.show(2, { kind: 'click', x: 20, y: 20 }, run.signal)
    end()
    await vi.waitFor(() => expect(executeScript.mock.calls.some(([call]) => call.target.tabId === 2)).toBe(true))
  })
})

describe('ActivityCursor ambient presence', () => {
  function setup() {
    const executeScript = vi.fn().mockResolvedValue([])
    vi.stubGlobal('chrome', { scripting: { executeScript } })
    return { cursor: new ActivityCursor(), executeScript }
  }
  const kinds = (calls: unknown[][]) => calls.map(([call]) => (call as { args: [{ kind: string }] }).args[0].kind)
  const arg = (call: unknown[]) => (call[0] as { args: [Record<string, unknown>] }).args[0]
  /** Favicon frames carry `step`; cursor activities carry `kind`. */
  const cursorCalls = (calls: unknown[][]) => calls.filter((call) => arg(call).kind !== undefined)
  const faviconCalls = (calls: unknown[][]) => calls.filter((call) => arg(call).step !== undefined)

  it('arms the page-side observer while a tool runs and disarms after the last one', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'click', x: 10, y: 20 }, run.signal)
    const endA = cursor.beginTool(run.signal)
    const endB = cursor.beginTool(run.signal)
    await vi.advanceTimersByTimeAsync(5000)
    const keepalives = executeScript.mock.calls.filter((call) => arg(call).kind === 'keepalive')
    expect(keepalives.length).toBeGreaterThanOrEqual(2)
    expect(keepalives.every((call) => arg(call).armedFor === 2500)).toBe(true)
    endA()
    await vi.advanceTimersByTimeAsync(0)
    expect(arg(executeScript.mock.calls.at(-1)!).armedFor).toBe(2500) // One tool still running.
    endB()
    await vi.advanceTimersByTimeAsync(0)
    expect(arg(executeScript.mock.calls.at(-1)!)).toMatchObject({ kind: 'keepalive', armedFor: 0 })
  })

  it('breathes between tools during a model turn and stops when the turn ends', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'click', x: 10, y: 20 }, run.signal)
    const endTurn = cursor.beginModelTurn(run.signal)
    await vi.advanceTimersByTimeAsync(5000)
    expect(kinds(executeScript.mock.calls).filter((kind) => kind === 'thinking').length).toBeGreaterThanOrEqual(2)

    const endTool = cursor.beginTool(run.signal)
    let mark = executeScript.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    let since = kinds(executeScript.mock.calls.slice(mark))
    expect(since).not.toContain('thinking') // A running tool owns the pose.
    expect(since).toContain('keepalive')

    endTool()
    mark = executeScript.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(kinds(executeScript.mock.calls.slice(mark))).toContain('thinking') // Resumes after the tool.

    endTurn()
    const total = executeScript.mock.calls.length
    await vi.advanceTimersByTimeAsync(8000)
    expect(executeScript).toHaveBeenCalledTimes(total)
  })

  it('never breathes outside ambient mode', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    cursor.setMode('actions')
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'click', x: 1, y: 2 }, run.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(arg(executeScript.mock.calls[0]!).lifetime).toBe(10000)
    cursor.beginModelTurn(run.signal)
    const total = executeScript.mock.calls.length
    await vi.advanceTimersByTimeAsync(8000)
    expect(executeScript).toHaveBeenCalledTimes(total)
  })

  it('choreographs a tab switch as exit, bounded hold, activate, enter', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'click', x: 10, y: 20 }, run.signal)
    await vi.advanceTimersByTimeAsync(0)
    const order: string[] = []
    executeScript.mockImplementation((options: { target: { tabId: number }; args: [{ kind?: string; step?: unknown }] }) => {
      order.push(`${options.args[0].kind ?? `favicon:${options.args[0].step}`}@${options.target.tabId}`)
      return Promise.resolve([])
    })
    const switching = cursor.switchTabs({
      fromTab: 1, toTab: 2, signal: run.signal, stripX: 400, icon: 'data:image/png;base64,AA',
      activate: async () => { order.push('activate') },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['exit@1', 'favicon:0@2']) // The tab has not flipped yet.
    await vi.advanceTimersByTimeAsync(110)
    expect(order.at(-1)).toBe('favicon:1@2')
    await vi.advanceTimersByTimeAsync(110)
    expect(order.at(-1)).toBe('favicon:2@2')
    expect(order).not.toContain('activate') // 220ms in: still pulsing.
    await vi.advanceTimersByTimeAsync(80)
    await switching
    expect(order).toEqual([
      'exit@1', 'favicon:0@2', 'favicon:1@2', 'favicon:2@2', 'activate', 'favicon:restore@2', 'enter@2',
    ])
    expect(arg(executeScript.mock.calls.at(-1)!)).toMatchObject({ kind: 'enter', x: 400, toY: 88 })
    expect(faviconCalls(executeScript.mock.calls).slice(0, 3).every((call) => arg(call).icon === 'data:image/png;base64,AA')).toBe(true)
  })

  it('skips the favicon pulse when the target tab is the tab it is leaving', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'click', x: 10, y: 20 }, run.signal)
    const switching = cursor.switchTabs({ fromTab: 1, toTab: 1, signal: run.signal, activate: async () => {} })
    await vi.advanceTimersByTimeAsync(400)
    await switching
    expect(faviconCalls(executeScript.mock.calls)).toHaveLength(0)
  })

  it('activates even when a favicon frame cannot be injected', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    executeScript.mockImplementation((options: { args: [{ step?: unknown }] }) =>
      options.args[0].step !== undefined
        ? Promise.reject(new Error('Cannot access this page'))
        : Promise.resolve([]))
    const run = new AbortController()
    cursor.begin(run.signal)
    let activated = false
    const switching = cursor.switchTabs({ fromTab: 1, toTab: 2, signal: run.signal, activate: async () => { activated = true } })
    await vi.advanceTimersByTimeAsync(400)
    await switching
    expect(activated).toBe(true)
    expect(kinds(cursorCalls(executeScript.mock.calls))).toContain('enter')
  })

  it('aborting during the hold cuts the switch short without waiting out the timer', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'click', x: 10, y: 20 }, run.signal)
    await vi.advanceTimersByTimeAsync(0)
    let activated = false
    const switching = cursor.switchTabs({
      fromTab: 1, toTab: 2, signal: run.signal, activate: async () => { activated = true },
    })
    run.abort()
    await vi.advanceTimersByTimeAsync(0)
    await switching
    expect(activated).toBe(true)
    expect(kinds(cursorCalls(executeScript.mock.calls))).not.toContain('enter')
    // The pulse never outlives the switch: the target tab gets its icon back.
    expect(faviconCalls(executeScript.mock.calls).map((call) => arg(call).step)).toEqual([0, 'restore'])
    await vi.advanceTimersByTimeAsync(400)
    expect(faviconCalls(executeScript.mock.calls).map((call) => arg(call).step)).toEqual([0, 'restore'])
  })

  it('sends no favicon frames outside ambient mode', async () => {
    const { cursor, executeScript } = setup()
    cursor.setMode('actions')
    const run = new AbortController()
    cursor.begin(run.signal)
    await cursor.switchTabs({ fromTab: 1, toTab: 2, signal: run.signal, activate: async () => {} })
    await Promise.resolve()
    expect(faviconCalls(executeScript.mock.calls)).toHaveLength(0)
  })

  it('in actions mode a tab switch is just the activation', async () => {
    const { cursor, executeScript } = setup()
    cursor.setMode('actions')
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'click', x: 10, y: 20 }, run.signal)
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(1))
    let activated = false
    await cursor.switchTabs({ fromTab: 1, toTab: 2, signal: run.signal, activate: async () => { activated = true } })
    expect(activated).toBe(true)
    expect(executeScript).toHaveBeenCalledTimes(1)
  })

  it('retries a dropped enter once the incoming document loads', async () => {
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.begin(run.signal)
    let enters = 0
    executeScript.mockImplementation((options: { args: [{ kind?: string }] }) =>
      options.args[0].kind === 'enter' && ++enters === 1
        ? Promise.reject(new Error('Cannot access this page'))
        : Promise.resolve([]))
    await cursor.switchTabs({ toTab: 2, signal: run.signal, stripX: 300, activate: async () => {} })
    await vi.waitFor(() => expect(enters).toBe(1))
    cursor.onNavigated(2, 'committed')
    cursor.onNavigated(2, 'domcontentloaded')
    await vi.waitFor(() => expect(enters).toBe(2))
    expect(arg(executeScript.mock.calls.at(-1)!)).toMatchObject({ kind: 'enter', x: 300 })
  })

  it('re-materializes at the remembered position after a navigation', async () => {
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'click', x: 120, y: 240 }, run.signal)
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(1))
    cursor.hideOnNavigate(1)
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(2))
    expect(arg(executeScript.mock.calls[1]!)).toMatchObject({ kind: 'hide', immediate: false })
    cursor.onNavigated(1, 'committed')
    cursor.onNavigated(1, 'domcontentloaded')
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(4))
    expect(executeScript.mock.calls.slice(2).map((call) => arg(call))).toMatchObject([
      { kind: 'move', x: 120, y: 240 }, { kind: 'park' },
    ])
  })

  it('parks in place when the tab has not navigated, and stays quiet outside ambient', async () => {
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'click', x: 8, y: 9 }, run.signal)
    cursor.park(1, run.signal)
    await vi.waitFor(() => expect(kinds(executeScript.mock.calls)).toEqual(['click', 'park']))
    cursor.setMode('actions')
    cursor.park(1, run.signal)
    cursor.onNavigated(1, 'committed')
    cursor.onNavigated(1, 'domcontentloaded')
    await Promise.resolve()
    expect(executeScript).toHaveBeenCalledTimes(2)
  })

  it('ignores tab activations it initiated and parks on user-initiated ones', async () => {
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(3, { kind: 'click', x: 5, y: 6 }, run.signal)
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(1))
    cursor.expectActivation(3)
    expect(cursor.consumeExpectedActivation(3)).toBe(true)
    expect(cursor.consumeExpectedActivation(3)).toBe(false) // Single use.
    cursor.expectActivation(3)
    cursor.onTabActivated(3)
    await Promise.resolve()
    expect(executeScript).toHaveBeenCalledTimes(1)
    cursor.onTabActivated(3)
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(2))
    expect(arg(executeScript.mock.calls[1]!).kind).toBe('park')
  })

  it('expires an expected activation after 1.5s', () => {
    vi.useFakeTimers()
    const { cursor } = setup()
    cursor.expectActivation(7)
    vi.advanceTimersByTime(1600)
    expect(cursor.consumeExpectedActivation(7)).toBe(false)
  })

  it('off hides what is presented and suppresses further presence', async () => {
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'click', x: 10, y: 10 }, run.signal)
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(1))
    cursor.setMode('off')
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(2))
    expect(arg(executeScript.mock.calls[1]!)).toMatchObject({ kind: 'hide', immediate: true })
    cursor.show(1, { kind: 'click', x: 20, y: 20 }, run.signal)
    cursor.park(1, run.signal)
    let activated = false
    await cursor.switchTabs({ toTab: 2, signal: run.signal, activate: async () => { activated = true } })
    expect(activated).toBe(true)
    await Promise.resolve()
    expect(executeScript).toHaveBeenCalledTimes(2)
  })
})

describe('ActivityCursor.showAndWait', () => {
  function setup() {
    const executeScript = vi.fn().mockResolvedValue([{ result: 0 }])
    vi.stubGlobal('chrome', { scripting: { executeScript } })
    return { cursor: new ActivityCursor(), executeScript }
  }

  /** Resolution order, not wall clock: track settlement without racing the timers. */
  function track(promise: Promise<void>): { done: () => boolean } {
    let done = false
    void promise.then(() => { done = true })
    return { done: () => done }
  }

  it('waits out the renderer estimate, then resolves', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    executeScript.mockResolvedValue([{ result: 230 }])
    const run = new AbortController()
    cursor.begin(run.signal)
    const waiting = track(cursor.showAndWait(1, { kind: 'move', x: 5, y: 6 }, run.signal))
    await vi.advanceTimersByTimeAsync(220)
    expect(waiting.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    expect(waiting.done()).toBe(true)
    expect((executeScript.mock.calls[0]![0] as { args: [Record<string, unknown>] }).args[0])
      .toMatchObject({ kind: 'move', x: 5, y: 6 })
  })

  it('caps the wait at the arrival cap', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    executeScript.mockResolvedValue([{ result: 5000 }])
    const run = new AbortController()
    cursor.begin(run.signal)
    const waiting = track(cursor.showAndWait(1, { kind: 'move', x: 5, y: 6 }, run.signal))
    await vi.advanceTimersByTimeAsync(ARRIVAL_WAIT_CAP_MS - 10)
    expect(waiting.done()).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    expect(waiting.done()).toBe(true)
  })

  it('resolves early when the run is aborted mid-wait', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    executeScript.mockResolvedValue([{ result: 400 }])
    const run = new AbortController()
    cursor.begin(run.signal)
    const waiting = track(cursor.showAndWait(1, { kind: 'move', x: 5, y: 6 }, run.signal))
    await vi.advanceTimersByTimeAsync(50)
    expect(waiting.done()).toBe(false)
    run.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(waiting.done()).toBe(true)
  })

  it('never delays the action when there is nothing to wait for', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    const run = new AbortController()
    cursor.begin(run.signal)
    const aborted = new AbortController()
    aborted.abort()

    const cases: Array<[string, Promise<void>]> = [
      ['estimate 0', cursor.showAndWait(1, { kind: 'move', x: 1, y: 2 }, run.signal)],
    ]
    executeScript.mockResolvedValue([{}]) // No estimate at all.
    cases.push(['no estimate', cursor.showAndWait(1, { kind: 'move', x: 3, y: 4 }, run.signal)])
    executeScript.mockRejectedValue(new Error('Cannot access this page'))
    cases.push(['restricted page', cursor.showAndWait(1, { kind: 'move', x: 5, y: 6 }, run.signal)])
    cases.push(['no signal', cursor.showAndWait(1, { kind: 'move', x: 5, y: 6 })])
    cases.push(['aborted signal', cursor.showAndWait(1, { kind: 'move', x: 5, y: 6 }, aborted.signal)])
    cases.push(['unknown session', cursor.showAndWait(1, { kind: 'move', x: 5, y: 6 }, new AbortController().signal)])
    for (const [name, promise] of cases) {
      const waiting = track(promise)
      await vi.advanceTimersByTimeAsync(0)
      expect(waiting.done(), name).toBe(true)
    }

    cursor.setMode('off')
    const off = track(cursor.showAndWait(1, { kind: 'move', x: 7, y: 8 }, run.signal))
    await vi.advanceTimersByTimeAsync(0)
    expect(off.done()).toBe(true)
  })

  it('settles a pending arrival that coalescing displaces', async () => {
    vi.useFakeTimers()
    const { cursor, executeScript } = setup()
    let release!: (value: unknown) => void
    executeScript.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const run = new AbortController()
    cursor.begin(run.signal)
    cursor.show(1, { kind: 'move', x: 1, y: 1 }, run.signal) // Occupies the delivery slot.
    const displaced = track(cursor.showAndWait(1, { kind: 'move', x: 2, y: 2 }, run.signal))
    cursor.show(1, { kind: 'click', x: 3, y: 3 }, run.signal) // Replaces the queued entry.
    await vi.advanceTimersByTimeAsync(0)
    expect(displaced.done()).toBe(true) // Not swallowed with the entry.
    release([{ result: 0 }])
    await vi.advanceTimersByTimeAsync(0)
  })
})

describe('estimateTabStripX', () => {
  const tabs = [
    { index: 0, pinned: true }, { index: 1, pinned: false }, { index: 2, pinned: false },
    { index: 3, pinned: false }, { index: 4, pinned: false },
  ]

  it('centres each tab of a 1280px window with one pinned tab', () => {
    // strip 1160 − 40 pinned = 1120 over 4 tabs = 280, clamped to 240.
    expect(estimateTabStripX({ windowWidth: 1280, tabs, targetIndex: 0 })).toBe(20)
    expect(estimateTabStripX({ windowWidth: 1280, tabs, targetIndex: 1 })).toBe(160)
    expect(estimateTabStripX({ windowWidth: 1280, tabs, targetIndex: 4 })).toBe(880)
  })

  it('clamps narrow tabs to 66px and gives up on narrow windows or unknown tabs', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ index, pinned: false }))
    // (900 − 120) / 30 = 26 → clamped to 66.
    expect(estimateTabStripX({ windowWidth: 900, tabs: many, targetIndex: 2 })).toBe(66 * 2 + 33)
    expect(estimateTabStripX({ windowWidth: 480, tabs, targetIndex: 1 })).toBeUndefined()
    expect(estimateTabStripX({ windowWidth: 1280, tabs, targetIndex: 9 })).toBeUndefined()
  })
})
