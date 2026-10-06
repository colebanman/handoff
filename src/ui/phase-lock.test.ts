import { describe, expect, it, vi } from 'vitest'
import { installPhaseLock } from './phase-lock'

/** Minimal stand-ins: the module only touches the event, the element's style/dataset and getComputedStyle. */
function setup(computed: { animationName: string; animationDuration: string; animationDelay: string }) {
  const listeners: Array<(e: unknown) => void> = []
  const doc = {
    addEventListener: (_: string, fn: (e: unknown) => void) => listeners.push(fn),
    removeEventListener: vi.fn(),
  } as unknown as Document
  class FakeElement {
    style: Record<string, string> = {}
    dataset: Record<string, string> = {}
  }
  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('getComputedStyle', () => computed)
  installPhaseLock(doc)
  const el = new FakeElement()
  const fire = (animationName: string): void => listeners.forEach((fn) => fn({ animationName, target: el }))
  return { el, fire }
}

describe('phase lock', () => {
  it('shifts a loop onto the shared clock', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_300)
    const { el, fire } = setup({ animationName: 'shine', animationDuration: '2s', animationDelay: '0s' })
    fire('shine')
    // 10_300 mod 2_000 = 300ms into the shared cycle.
    expect(el.style.animationDelay).toBe('-300ms')
  })

  it('keeps an authored stagger and never compounds it on restart', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(5_000)
    const { el, fire } = setup({ animationName: 'spin', animationDuration: '1.2s', animationDelay: '0.15s' })
    fire('spin')
    expect(el.style.animationDelay).toBe(`${150 - (5_000 % 1_200)}ms`)
    now.mockReturnValue(6_000)
    fire('spin')
    expect(el.style.animationDelay).toBe(`${150 - (6_000 % 1_200)}ms`)
  })

  it('leaves one-shot animations alone', () => {
    const { el, fire } = setup({ animationName: 'fade-in', animationDuration: '320ms', animationDelay: '0s' })
    fire('fade-in')
    expect(el.style.animationDelay).toBeUndefined()
  })
})
