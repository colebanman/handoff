import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FULL_TAB_PATH } from '../shared/panel-view'
import { openFullTab } from './panel-view'

const url = `chrome-extension://test/${FULL_TAB_PATH}`
const query = vi.fn()
const create = vi.fn()
const update = vi.fn()
const remove = vi.fn()
const focus = vi.fn()
const prepare = vi.fn()
const options = vi.fn()

beforeEach(() => {
  query.mockReset().mockResolvedValue([])
  create.mockReset().mockResolvedValue({ id: 50, windowId: 2 })
  update.mockReset().mockResolvedValue({})
  remove.mockReset().mockResolvedValue(undefined)
  focus.mockReset().mockResolvedValue({})
  prepare.mockReset().mockResolvedValue({ ok: true })
  options.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, sendMessage: prepare },
    tabs: { query, create, update, remove },
    windows: { update: focus },
    sidePanel: { setOptions: options },
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('full-tab chat opening', () => {
  it('saves the owner before closing its document and restores sidebar availability', async () => {
    await openFullTab(2)
    expect(create).toHaveBeenCalledWith({ url, active: false, windowId: 2 })
    expect(prepare).toHaveBeenCalledWith({ target: 'ui', type: 'panel.prepare-tab' })
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(options.mock.invocationCallOrder[0]!)
    expect(options.mock.calls).toEqual([[{ enabled: false }], [{ enabled: true }]])
    expect(update).toHaveBeenCalledWith(50, { active: true })
    expect(focus).toHaveBeenCalledWith(2, { focused: true })
  })

  it('focuses an existing tab in another window without changing the sidebar', async () => {
    query.mockResolvedValue([{ id: 12, windowId: 4, url }])
    await openFullTab(2)
    expect(update).toHaveBeenCalledWith(12, { active: true })
    expect(focus).toHaveBeenCalledWith(4, { focused: true })
    expect(create).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(options).not.toHaveBeenCalled()
  })

  it('coalesces simultaneous clicks and recognizes pending tab navigation', async () => {
    await Promise.all([openFullTab(), openFullTab()])
    expect(create).toHaveBeenCalledTimes(1)
    query.mockResolvedValue([{ id: 50, windowId: 2, pendingUrl: url }])
    await openFullTab()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('opens when no sidebar is listening', async () => {
    prepare.mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'))
    await expect(openFullTab()).resolves.toBeUndefined()
    expect(update).toHaveBeenCalledWith(50, { active: true })
  })

  it('keeps the sidebar alive if saving the draft fails', async () => {
    prepare.mockResolvedValue({ ok: false, error: 'Storage quota exceeded' })
    await expect(openFullTab()).rejects.toThrow('Storage quota exceeded')
    expect(options).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith(50)
  })

  it('does not close the sidebar when the destination cannot be created', async () => {
    create.mockRejectedValue(new Error('Window closed'))
    await expect(openFullTab()).rejects.toThrow('Window closed')
    expect(options).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('restores sidebar availability after a failed close and allows retry', async () => {
    options.mockRejectedValueOnce(new Error('Close failed'))
    await expect(openFullTab()).rejects.toThrow('Close failed')
    expect(options).toHaveBeenLastCalledWith({ enabled: true })
    await expect(openFullTab()).resolves.toBeUndefined()
  })
})
