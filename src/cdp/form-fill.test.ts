import { afterEach, describe, expect, it, vi } from 'vitest'
import { fillForm, type FormTransport } from './form-fill'

function harness() {
  const state = { kind: 'select', satisfied: true, changed: false }
  const inspect = vi.fn((method: string, _index?: number): unknown => method === 'prepare' ? { ...state, satisfied: false } : method === 'verify' ? state : { unconfirmed: [], changed: false })
  const send = vi.fn(async (method: string, params: any) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: `field-${params.backendNodeId}` } }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: params.objectId === 'option' ? 99 : 1 } }
    if (method === 'Runtime.callFunctionOn') {
      if (!params.arguments?.[0]?.value || Array.isArray(params.arguments[0].value)) return { result: { objectId: 'session' } }
      const action = params.arguments[0].value
      if (action === 'node' || action === 'option') return { result: { objectId: action === 'option' ? 'option' : 'field' } }
      return { result: { value: inspect(action, params.arguments[1].value) } }
    }
    return {}
  })
  const controller = new AbortController()
  const transport = { send, resolve: vi.fn(() => 1), click: vi.fn(), type: vi.fn() } as unknown as FormTransport
  return { state, inspect, send, transport, controller }
}
afterEach(() => vi.useRealTimers())

describe('form driver progress and cancellation', () => {
  it('verifies selections and rechecks before advancing without snapshots', async () => {
    const h = harness()
    const result = await fillForm(h.transport, [{ ref: 'e1', select: 'No' }, { ref: 'e2', checked: false }])
    expect(result).toEqual({ ok: true, fields: [{ ref: 'e1', status: 'verified' }, { ref: 'e2', status: 'verified' }] })
    expect(h.transport.click).toHaveBeenCalledTimes(3)
    expect(h.inspect.mock.calls.filter(c => c[0] === 'verify').length).toBe(2)
    expect(h.inspect.mock.calls.filter(c => c[0] === 'audit').length).toBe(2)
    expect(h.send.mock.calls.some(c => c[0] === 'Accessibility.getFullAXTree')).toBe(false)
    expect(h.send.mock.calls.at(-1)?.[0]).toBe('Runtime.releaseObjectGroup')
  })

  it('stops on unconfirmed values and never dispatches the next field or retries a click', async () => {
    vi.useFakeTimers()
    const h = harness(); h.state.satisfied = false
    const pending = fillForm(h.transport, [{ ref: 'e1', select: 'No' }, { ref: 'e2', text: 'a' }], undefined, 100)
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.fields.map(f => f.status)).toEqual(['uncertain', 'unattempted'])
    expect(h.transport.click).toHaveBeenCalledTimes(2)
    expect(h.transport.type).not.toHaveBeenCalled()
  })

  it('selects from an already-open dropdown without toggling it closed', async () => {
    const h = harness()
    h.inspect.mockImplementation(method => method === 'prepare' ? { kind: 'select', satisfied: false, expanded: true } :
      method === 'verify' ? h.state : { unconfirmed: [], changed: false })
    expect((await fillForm(h.transport, [{ ref: 'e1', select: 'No' }])).ok).toBe(true)
    expect(h.transport.click).toHaveBeenCalledExactlyOnceWith(99)
  })

  it('retains a confirmed value but stops before new dependent questions', async () => {
    const h = harness()
    h.inspect.mockImplementation(method => method === 'audit' ? { unconfirmed: [], changed: true } : { ...h.state, satisfied: method !== 'prepare' })
    const result = await fillForm(h.transport, [{ ref: 'e1', select: 'No' }, { ref: 'e2', select: 'Yes' }])
    expect(result.fields.map(f => f.status)).toEqual(['verified', 'unattempted'])
    expect(result.stopped).toContain('structure changed')
    expect(h.transport.click).toHaveBeenCalledTimes(2)
  })

  it('resolves every ref before any writes', async () => {
    const h = harness()
    vi.mocked(h.transport.resolve).mockImplementation(ref => { if (ref === 'bad') throw new Error('stale'); return 1 })
    const result = await fillForm(h.transport, [{ ref: 'e1', text: 'a' }, { ref: 'bad', text: 'b' }])
    expect(result.fields.every(f => f.status === 'unattempted')).toBe(true)
    expect(h.transport.type).not.toHaveBeenCalled()
  })

  it('only cleans up after cancellation, without verification or the next write', async () => {
    const h = harness()
    vi.mocked(h.transport.type).mockImplementation(async () => { h.controller.abort() })
    await expect(fillForm(h.transport, [{ ref: 'e1', text: 'a' }, { ref: 'e2', text: 'b' }], h.controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.transport.type).toHaveBeenCalledTimes(1)
    expect(h.inspect.mock.calls.filter(c => c[0] === 'verify')).toHaveLength(0)
    expect(h.send.mock.calls.at(-1)?.[0]).toBe('Runtime.releaseObjectGroup')
  })
})

describe('editable combobox selection', () => {
  it('does not backspace an empty query and clear the committed choice', async () => {
    const h = harness()
    h.inspect.mockImplementation(method => method === 'prepare' ? { kind: 'combobox', searchable: true, clearQuery: false, satisfied: false } :
      method === 'verify' ? h.state : { unconfirmed: [], changed: false })
    expect((await fillForm(h.transport, [{ ref: 'e1', select: 'No' }])).ok).toBe(true)
    expect(h.transport.type).toHaveBeenCalledExactlyOnceWith(1, 'No', false)
  })
  it('types the exact query then selects the owned option in the same call', async () => {
    const h = harness()
    h.inspect.mockImplementation(method => method === 'prepare' ? { kind: 'combobox', searchable: true, satisfied: false } :
      method === 'verify' ? h.state : { unconfirmed: [], changed: false })
    const result = await fillForm(h.transport, [{ ref: 'e1', select: 'No' }])
    expect(result.ok).toBe(true)
    expect(h.transport.type).toHaveBeenCalledExactlyOnceWith(1, 'No', true)
    expect(h.transport.click).toHaveBeenCalledExactlyOnceWith(99)
  })

  it('does not accept a typed query when committed-value verification fails', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.inspect.mockImplementation(method => method === 'prepare' ? { kind: 'combobox', searchable: true, satisfied: false } :
      method === 'verify' ? { satisfied: false } : { unconfirmed: [], changed: false })
    const pending = fillForm(h.transport, [{ ref: 'e1', select: 'No' }, { ref: 'e2', text: 'a' }], undefined, 100)
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.fields.map(f => f.status)).toEqual(['uncertain','unattempted'])
    expect(h.transport.type).toHaveBeenCalledTimes(1)
    expect(h.transport.click).toHaveBeenCalledTimes(1)
  })

  it('stops on cancellation during query entry before clicking an option', async () => {
    const h = harness()
    h.inspect.mockImplementation(method => method === 'prepare' ? { kind: 'combobox', searchable: true, satisfied: false } : h.state)
    vi.mocked(h.transport.type).mockImplementation(async () => { h.controller.abort() })
    await expect(fillForm(h.transport, [{ ref: 'e1', select: 'No' }], h.controller.signal)).rejects.toMatchObject({name:'AbortError'})
    expect(h.transport.click).not.toHaveBeenCalled()
  })
})
