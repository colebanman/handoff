import { describe, expect, it, vi } from 'vitest'
import { guardFormActions } from './form-gate'
import type { CdpService } from '../shared/types'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

describe('form action exclusion', () => {
  it('excludes raw commands, snapshots and other fills while allowing another tab', async () => {
    const work = deferred()
    const service = guardFormActions({ fill: vi.fn(() => work.promise), send: vi.fn(), snapshot: vi.fn(), click: vi.fn(), select: vi.fn() } as unknown as CdpService)
    const fill = service.fill(1, [{ ref: 'e1', select: 'No' }])
    for (const operation of [() => service.send(1, 'Runtime.evaluate'), () => service.snapshot(1), () => service.click(1, 'e1'),
      () => service.fill(1, []), () => service.select(1, 'e2', 'Yes')]) await expect(operation()).rejects.toThrow('in-flight')
    await service.click(2, 'e1')
    work.resolve(); await fill
    await service.click(1, 'e1')
  })

  it('refuses a fill while an earlier ordinary action is still running', async () => {
    const work = deferred()
    const service = guardFormActions({ click: vi.fn(() => work.promise), fill: vi.fn() } as unknown as CdpService)
    const click = service.click(1, 'e1')
    await expect(service.fill(1, [{ ref: 'e1', text: 'a' }])).rejects.toThrow('in-flight')
    work.resolve(); await click
    await service.fill(1, [{ ref: 'e1', text: 'a' }])
  })

  it('releases after failure and internal calls do not acquire a second lease', async () => {
    const raw = { send: vi.fn(), async fill() { await this.send(); throw new Error('failed') } }
    const service = guardFormActions(raw as unknown as CdpService)
    await expect(service.fill(1, [])).rejects.toThrow('failed')
    await service.send(1, 'DOM.getDocument')
    expect(raw.send).toHaveBeenCalledTimes(2)
  })
})
