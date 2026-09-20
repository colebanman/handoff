import { afterEach, describe, expect, it, vi } from 'vitest'
import { CdpServiceImpl } from '../cdp/service'
import { buildTools, type BuildToolsArgs } from '../agent/tools'
import { captureTabShot } from '../ui/tabshot'
import { createBackgroundRuntimeServices } from './runtime-services'
import type { OffscreenRuntimeMessage } from '../shared/execution-protocol'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function setup() {
  let detach!: (source: { tabId: number }, reason: string) => void
  vi.stubGlobal('chrome', {
    debugger: {
      onDetach: { addListener: (fn: typeof detach) => { detach = fn } },
      onEvent: { addListener: vi.fn() },
    },
    tabs: { query: vi.fn(async () => []) },
    runtime: { sendMessage: vi.fn() },
  })
  const cdp = new CdpServiceImpl()
  vi.spyOn(cdp, 'attach').mockResolvedValue()
  vi.spyOn(cdp, 'evalInPage').mockResolvedValue({ url: 'https://example.com', title: 'Example' })
  vi.spyOn(cdp, 'waitForLoad').mockResolvedValue(true)
  const send = vi.spyOn(cdp, 'send').mockImplementation(async (_tabId, method) => {
    if (method === 'Page.captureScreenshot') return { data: 'cG5n' }
    if (method === 'Accessibility.getFullAXTree') return { nodes: [
      { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['button'] },
      { nodeId: 'button', role: { value: 'button' }, name: { value: 'Open details' }, backendDOMNodeId: 42 },
    ] }
    if (method === 'DOM.getContentQuads') return { quads: [[10, 20, 30, 20, 30, 40, 10, 40]] }
    return {}
  })
  const services = createBackgroundRuntimeServices(cdp, async () => {})
  // Exercise the UI request through the same routing/envelope as background/index.
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message: unknown) => {
    try { return { ok: true, value: await services.handleMessage(message as Partial<OffscreenRuntimeMessage>) } }
    catch (error) { return { ok: false, error: (error as Error).message } }
  })
  const tools = buildTools({
    cdp, sandbox: {} as BuildToolsArgs['sandbox'], vfs: {} as BuildToolsArgs['vfs'],
    ctx: { agentId: 'main', currentTabId: 7 }, emit: vi.fn(), spawnSubagent: vi.fn(),
    tasks: {} as BuildToolsArgs['tasks'], signal: new AbortController().signal,
    sandboxSessionId: 'tabshot-test',
  })
  const click = (ref: string) => tools.browser_click!.execute!(
    { tabId: 7, ref }, { toolCallId: 'click', messages: [] },
  )
  return { cdp, send, click, detach: () => detach({ tabId: 7 }, 'target_closed') }
}

describe('TabShot capture and agent interactions share refs', () => {
  it('clicks a ref from the attached tree without an initial browser_snapshot', async () => {
    const { cdp, send, click } = setup()
    const snapshot = vi.spyOn(cdp, 'snapshot')
    const captured = await captureTabShot(7)
    const ref = /\[(e[a-z0-9]+-\d+)\] button "Open details"/.exec(captured.snapshot!.text)![1]!
    const commandsBeforeLabel = send.mock.calls.length
    expect(cdp.describeRef(7, ref)).toEqual({ role: 'button', name: 'Open details' })
    expect(send.mock.calls).toHaveLength(commandsBeforeLabel)

    const result = await click(ref)

    expect(result).toContain(`Clicked ${ref} in tab 7.`)
    expect(result).toContain(`[${ref}] button "Open details"`)
    expect(send).toHaveBeenCalledWith(7, 'DOM.getContentQuads', { backendNodeId: 42 }, expect.any(AbortSignal))
    const methods = send.mock.calls.map((call) => call[1])
    // Only capture's tree precedes the click. The second tree is post-action feedback.
    expect(methods.slice(0, methods.indexOf('Input.dispatchMouseEvent')).filter((m) => m === 'Accessibility.getFullAXTree')).toHaveLength(1)
    expect(snapshot).toHaveBeenCalledTimes(2)
  })

  it('returns replacement refs after detach without replaying the expired click', async () => {
    const { cdp, send, click, detach } = setup()
    const captured = await captureTabShot(7)
    const ref = /\[(e[a-z0-9]+-\d+)\]/.exec(captured.snapshot!.text)![1]!
    detach()
    expect(cdp.describeRef(7, ref)).toBeUndefined()
    send.mockClear()

    const result = await click(ref)

    expect(result).toContain('Select a new ref from the replacement snapshot')
    expect(result).toMatch(/\[e[a-z0-9]+-\d+\] button "Open details"/)
    expect(result).not.toContain(`[${ref}] button`)
    expect(send.mock.calls.some((call) => call[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('invalidates refs immediately on document navigation, even if backend IDs are reused', async () => {
    const { cdp } = setup()
    const first = await cdp.snapshot(7)
    const ref = /\[(e[a-z0-9]+-\d+)\]/.exec(first.text)![1]!
    const listener = vi.mocked(chrome.debugger.onEvent.addListener).mock.calls[0]![0]
    listener({ tabId: 7 }, 'Page.frameNavigated', { frame: { id: 'main' } })
    expect(cdp.describeRef(7, ref)).toBeUndefined()
    const second = await cdp.snapshot(7)
    expect(second.text).not.toContain(`[${ref}]`)
  })

  it('keeps the screenshot when the page cannot provide an accessibility tree', async () => {
    const { cdp } = setup()
    vi.spyOn(cdp, 'snapshot').mockRejectedValue(new Error('Tree unavailable'))
    expect(await captureTabShot(7)).toEqual({ shot: { base64: 'cG5n', mediaType: 'image/png' } })
  })

  it('surfaces capture failures to the composer', async () => {
    const { cdp } = setup()
    vi.spyOn(cdp, 'screenshot').mockRejectedValue(new Error('Tab closed'))
    await expect(captureTabShot(7)).rejects.toThrow('Tab closed')
  })
})
