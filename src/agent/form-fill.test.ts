import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildTools, type BuildToolsArgs } from './tools'

function harness() {
  const controller = new AbortController()
  const cdp = {
    type: vi.fn().mockResolvedValue(undefined),
    waitForLoad: vi.fn().mockResolvedValue(true),
    snapshot: vi.fn().mockResolvedValue({ tabId: 7, title: 'Form', url: 'https://example.test', text: '[e1] textbox Name: Alice\n[e2] textbox City: Boston' }),
  }
  const tools = buildTools({
    cdp: cdp as unknown as BuildToolsArgs['cdp'],
    sandbox: {} as BuildToolsArgs['sandbox'], vfs: {} as BuildToolsArgs['vfs'],
    ctx: { agentId: 'test', currentTabId: 7, allowedTabIds: [7] },
    emit: vi.fn(), spawnSubagent: vi.fn(), tasks: {} as BuildToolsArgs['tasks'],
    signal: controller.signal, sandboxSessionId: 'form-test',
  })
  const run = (fields = [{ ref: 'e1', text: 'Alice' }, { ref: 'e2', text: 'Boston' }], tabId = 7) =>
    tools.browser_fill!.execute!({ fields, tabId }, { toolCallId: 'fill', messages: [] })
  return { cdp, tools, controller, run }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('multi-field fill', () => {
  it('uses the existing typing path sequentially, then settles and snapshots just once', async () => {
    const h = harness()
    const order: string[] = []
    h.cdp.type.mockImplementation(async (_id, ref) => { order.push(ref) })
    h.cdp.snapshot.mockImplementation(async () => { order.push('snapshot'); return { tabId: 7, title: 'Form', url: '', text: 'Alice Boston' } })
    const result = h.run()
    await vi.runAllTimersAsync()
    expect(await result).toContain('Typing completed for 2/2 fields')
    expect(order).toEqual(['e1', 'e2', 'snapshot'])
    expect(h.cdp.type.mock.calls).toEqual([
      [7, 'e1', 'Alice', { clear: true, signal: h.controller.signal }],
      [7, 'e2', 'Boston', { clear: true, signal: h.controller.signal }],
    ])
    expect(h.cdp.waitForLoad).toHaveBeenCalledTimes(1)
    expect(h.cdp.snapshot).toHaveBeenCalledTimes(1)
    expect(await result).toContain('Fresh browser observation')
  })

  it('stops on a detached field, identifies partial progress, and never replays earlier fields', async () => {
    const h = harness()
    h.cdp.type.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('No node with given id'))
    const result = h.run([{ ref: 'e1', text: 'Alice' }, { ref: 'e2', text: 'Boston' }, { ref: 'e3', text: '02110' }])
    await vi.runAllTimersAsync()
    expect(await result).toContain('Typing completed for 1/3 fields')
    expect(await result).toContain('Stopped at e2')
    expect(await result).toContain('may be partially changed')
    expect(await result).toContain('Not attempted: e3')
    expect(h.cdp.type).toHaveBeenCalledTimes(2)
    expect(h.cdp.snapshot).toHaveBeenCalledTimes(1)
  })

  it('stops immediately after cancellation and does not snapshot or type the next field', async () => {
    const h = harness()
    h.cdp.type.mockImplementationOnce(async () => { h.controller.abort() })
    await expect(h.run()).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.cdp.type).toHaveBeenCalledTimes(1)
    expect(h.cdp.snapshot).not.toHaveBeenCalled()
  })

  it('preserves explicit append behavior and empty text', async () => {
    const h = harness()
    const run = h.tools.browser_fill!.execute!({ fields: [{ ref: 'e1', text: '', clear: false }] }, { toolCallId: 'fill', messages: [] })
    await vi.runAllTimersAsync()
    await run
    expect(h.cdp.type).toHaveBeenCalledWith(7, 'e1', '', { clear: false, signal: h.controller.signal })
  })

  it('reports snapshot failures without repeating the fill', async () => {
    const h = harness()
    h.cdp.snapshot.mockRejectedValue(new Error('renderer unavailable'))
    const result = h.run()
    await vi.runAllTimersAsync()
    expect(await result).toContain('Typing completed for 2/2 fields')
    expect(await result).toContain('Automatic snapshot failed')
    expect(h.cdp.type).toHaveBeenCalledTimes(2)
  })

  it('rejects out-of-scope tabs before any typing', async () => {
    const h = harness()
    expect(await h.run(undefined, 8)).toContain('out of this subagent')
    expect(h.cdp.type).not.toHaveBeenCalled()
  })

  it('rejects duplicate refs and empty batches at the tool boundary', () => {
    const { tools } = harness()
    const schema = tools.browser_fill!.inputSchema as z.ZodType
    expect(schema.safeParse({ fields: [] }).success).toBe(false)
    expect(schema.safeParse({ fields: [{ ref: 'e1', text: 'a' }, { ref: 'e1', text: 'b' }] }).success).toBe(false)
  })
})
