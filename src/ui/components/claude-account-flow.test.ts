import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccountStatus, ClaudeSignInOptions } from '../../agent/anthropic-oauth'
import { ClaudeAccountFlow, focusClaudeSignInTab } from './claude-account-flow'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup() {
  const actions = {
    getStatus: vi.fn<() => Promise<ClaudeAccountStatus>>().mockResolvedValue({ connected: false }),
    signIn: vi.fn<(options: ClaudeSignInOptions) => Promise<ClaudeAccountStatus>>(),
    signOut: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onConnected: vi.fn<(status: ClaudeAccountStatus) => Promise<void>>().mockResolvedValue(undefined),
    onDisconnected: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
  return { actions, flow: new ClaudeAccountFlow(actions) }
}

afterEach(() => vi.unstubAllGlobals())

describe('Claude account flow', () => {
  it('shows token exchange separately and returns a 429 failure to a retryable sign-in state', async () => {
    const { flow, actions } = setup()
    await flow.refresh()
    const token = deferred<ClaudeAccountStatus>()
    actions.signIn.mockImplementation((options) => {
      options.onAuthTab?.(7)
      options.onPhaseChange?.('waiting-browser')
      return token.promise
    })
    const login = flow.start()
    expect(flow.snapshot()).toMatchObject({ phase: 'waiting-browser', authTabId: 7 })
    actions.signIn.mock.calls[0]![0].onPhaseChange?.('exchanging-token')
    expect(flow.snapshot().phase).toBe('exchanging-token')
    token.reject(new Error('Claude sign-in request failed (429). Please try again.'))
    await login
    expect(flow.snapshot()).toMatchObject({ phase: 'idle', status: { connected: false }, error: expect.stringContaining('429') })
    expect(flow.snapshot().authTabId).toBeUndefined()
    actions.signIn.mockResolvedValueOnce({ connected: true })
    await flow.start()
    expect(flow.snapshot()).toMatchObject({ phase: 'idle', status: { connected: true } })
    expect(flow.snapshot().error).toBeUndefined()
  })

  it('ignores a stale disconnected storage read after a successful sign-in', async () => {
    const { flow, actions } = setup()
    const stale = deferred<ClaudeAccountStatus>()
    actions.getStatus.mockReturnValueOnce(stale.promise)
    const refresh = flow.refresh()
    actions.signIn.mockResolvedValueOnce({ connected: true, email: 'new@example.test' })
    await flow.start()
    stale.resolve({ connected: false })
    await refresh
    expect(flow.snapshot().status).toEqual({ connected: true, email: 'new@example.test' })
    expect(actions.onDisconnected).not.toHaveBeenCalled()
    expect(actions.onConnected).toHaveBeenCalledTimes(1)
  })

  it('cannot reconnect from a stale storage read that finishes after disconnect', async () => {
    const { flow, actions } = setup()
    actions.getStatus.mockResolvedValueOnce({ connected: true })
    await flow.refresh()
    const stale = deferred<ClaudeAccountStatus>()
    actions.getStatus.mockReturnValueOnce(stale.promise)
    const refresh = flow.refresh()
    await flow.disconnect()
    stale.resolve({ connected: true })
    await refresh
    expect(flow.snapshot().status?.connected).toBe(false)
    expect(actions.onConnected).toHaveBeenCalledTimes(1)
    expect(actions.onDisconnected).toHaveBeenCalledTimes(1)
  })

  it('reconciles external storage changes after an in-progress connected callback', async () => {
    const { flow, actions } = setup()
    actions.getStatus.mockResolvedValueOnce({ connected: true })
    const callback = deferred<void>()
    actions.onConnected.mockReturnValueOnce(callback.promise)
    const refresh = flow.refresh()
    await Promise.resolve()
    expect(flow.snapshot().phase).toBe('exchanging-token')
    await flow.refresh() // Simulates a sign-out storage event from another panel.
    callback.resolve(undefined)
    await refresh
    await Promise.resolve()
    expect(flow.snapshot().status?.connected).toBe(false)
    expect(actions.onDisconnected).toHaveBeenCalledTimes(1)
  })

  it('does not let a cancelled attempt end or report errors on a newer login', async () => {
    const { flow, actions } = setup()
    const old = deferred<ClaudeAccountStatus>()
    const current = deferred<ClaudeAccountStatus>()
    actions.signIn.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const first = flow.start()
    const firstSignal = actions.signIn.mock.calls[0]![0].signal!
    const second = flow.start()
    actions.signIn.mock.calls[1]![0].onPhaseChange?.('waiting-browser')
    old.reject(new Error('Old attempt failed'))
    await first
    expect(firstSignal.aborted).toBe(true)
    expect(flow.snapshot().phase).toBe('waiting-browser')
    expect(flow.snapshot().error).toBeUndefined()
    current.resolve({ connected: true })
    await second
    expect(actions.onConnected).toHaveBeenCalledTimes(1)
  })

  it('does not treat a settings callback failure as a disconnected account', async () => {
    const { flow, actions } = setup()
    actions.signIn.mockResolvedValueOnce({ connected: true })
    actions.onConnected.mockRejectedValueOnce(new Error('Could not save settings'))
    await flow.start()
    expect(flow.snapshot()).toMatchObject({ status: { connected: true }, phase: 'idle', error: 'Could not save settings' })
    expect(actions.onDisconnected).not.toHaveBeenCalled()
  })

  it('does not invoke connection callbacks after the component unmounts', async () => {
    const { flow, actions } = setup()
    const token = deferred<ClaudeAccountStatus>()
    actions.signIn.mockReturnValueOnce(token.promise)
    const login = flow.start()
    flow.dispose()
    token.resolve({ connected: true })
    await login
    expect(actions.onConnected).not.toHaveBeenCalled()
  })

  it('returns to idle during effect cleanup so effect replay can refresh the account', async () => {
    const { flow, actions } = setup()
    const token = deferred<ClaudeAccountStatus>()
    actions.signIn.mockImplementationOnce((options) => {
      options.onAuthTab?.(7)
      options.onPhaseChange?.('waiting-browser')
      return token.promise
    })
    const login = flow.start()
    await flow.refresh() // Deferred storage read during the in-progress login.
    flow.dispose()
    flow.activate()
    await flow.refresh()
    expect(flow.snapshot()).toMatchObject({ phase: 'idle', status: { connected: false } })
    expect(flow.snapshot().authTabId).toBeUndefined()
    expect(actions.getStatus).toHaveBeenCalledTimes(1)
    token.reject(new Error('Cancelled old attempt'))
    await login
    expect(flow.snapshot().error).toBeUndefined()
  })

  it('reports a connected account once across repeated fresh storage events', async () => {
    const { flow, actions } = setup()
    actions.getStatus.mockResolvedValue({ connected: true })
    await flow.refresh()
    await flow.refresh()
    expect(actions.onConnected).toHaveBeenCalledTimes(1)
    expect(flow.snapshot().phase).toBe('idle')
  })
})

it('opens the original observed auth tab without creating an unobserved replacement', async () => {
  const create = vi.fn()
  const updateTab = vi.fn().mockResolvedValue({ id: 7, windowId: 9 })
  const updateWindow = vi.fn().mockResolvedValue({ id: 9 })
  vi.stubGlobal('chrome', { tabs: { create, update: updateTab }, windows: { update: updateWindow } })
  await focusClaudeSignInTab(7)
  expect(updateTab).toHaveBeenCalledWith(7, { active: true })
  expect(updateWindow).toHaveBeenCalledWith(9, { focused: true })
  expect(create).not.toHaveBeenCalled()
})
