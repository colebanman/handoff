import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildTools, type BuildToolsArgs } from './tools'
import type { FormField } from '../shared/form-fill'

function harness() {
  const controller = new AbortController()
  const cdp = {
    fill: vi.fn(async (_id, fields: FormField[]) => ({ ok: true, fields: fields.map(({ ref }) => ({ ref, status: 'verified' })) })),
    waitForLoad: vi.fn().mockResolvedValue(true),
    snapshot: vi.fn().mockResolvedValue({ tabId: 7, title: 'Form', url: 'https://example.test', text: 'Form values' }),
  }
  const tools = buildTools({
    cdp: cdp as unknown as BuildToolsArgs['cdp'],
    sandbox: {} as BuildToolsArgs['sandbox'], vfs: {} as BuildToolsArgs['vfs'],
    ctx: { agentId: 'test', currentTabId: 7, allowedTabIds: [7] },
    emit: vi.fn(), spawnSubagent: vi.fn(), tasks: {} as BuildToolsArgs['tasks'],
    signal: controller.signal, sandboxSessionId: 'form-test',
  })
  const run = (fields: FormField[] = [{ ref: 'e1', text: 'Alice' }, { ref: 'e2', select: 'No' }], tabId = 7) =>
    tools.browser_fill!.execute!({ fields, tabId }, { toolCallId: 'fill', messages: [] })
  return { cdp, tools, controller, run }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('verified multi-field fill tool', () => {
  it('uses the shared mixed-field driver and snapshots once without a fixed delay/load wait', async () => {
    const h = harness()
    const fields = [{ ref: 'e1', text: 'Alice' }, { ref: 'e2', select: 'No' }, { ref: 'e3', checked: false }]
    const result = await h.run(fields)
    expect(result).toContain('Verified 3/3 fields')
    expect(h.cdp.fill).toHaveBeenCalledWith(7, fields, h.controller.signal)
    expect(h.cdp.waitForLoad).not.toHaveBeenCalled()
    expect(h.cdp.snapshot).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves partial progress and never retries', async () => {
    const h = harness()
    h.cdp.fill.mockResolvedValueOnce({ ok: false, fields: [
      { ref: 'e1', status: 'verified' }, { ref: 'e2', status: 'uncertain' }, { ref: 'e3', status: 'unattempted' },
    ], stopped: 'Option missing' } as never)
    const result = await h.run()
    expect(result).toContain('Error: Form fill stopped.')
    expect(result).toContain('e2: uncertain')
    expect(result).toContain('e3: unattempted')
    expect(result).toContain('No actions were replayed')
    expect(h.cdp.fill).toHaveBeenCalledTimes(1)
  })

  it('does not snapshot after cancellation', async () => {
    const h = harness()
    h.cdp.fill.mockImplementationOnce(async () => { h.controller.abort(); throw new DOMException('Cancelled', 'AbortError') })
    await expect(h.run()).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.cdp.snapshot).not.toHaveBeenCalled()
  })

  it('reports snapshot failure without repeating verified writes', async () => {
    const h = harness()
    h.cdp.snapshot.mockRejectedValue(new Error('renderer unavailable'))
    expect(await h.run()).toContain('Automatic snapshot failed')
    expect(h.cdp.fill).toHaveBeenCalledTimes(1)
  })

  it('rejects out-of-scope tabs before filling', async () => {
    const h = harness()
    expect(await h.run(undefined, 8)).toContain('out of this subagent')
    expect(h.cdp.fill).not.toHaveBeenCalled()
  })

  it('accepts compatible text calls and rejects ambiguous intentions and duplicate refs', () => {
    const { tools } = harness()
    const schema = tools.browser_fill!.inputSchema as z.ZodType
    expect(schema.safeParse({ fields: [{ ref: 'e1', text: '', clear: false }] }).success).toBe(true)
    for (const fields of [[], [{ ref: 'e1', text: 'a', select: 'Yes' }], [{ ref: 'e1', checked: false, clear: true }],
      [{ ref: 'e1', text: 'a' }, { ref: 'e1', select: 'No' }]]) expect(schema.safeParse({ fields }).success).toBe(false)
  })
})
