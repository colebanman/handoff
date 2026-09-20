import { describe, expect, it } from 'vitest'
import { applyBrowserSnapshotDelta, diffBrowserSnapshot, parseBrowserSnapshot, parseBrowserSnapshotDelta,
  renderBrowserSnapshot, renderBrowserSnapshotDelta, type BrowserSnapshot } from './browser-snapshot'

const page = (lines: string[], revision = 1): BrowserSnapshot => ({ tabId: 7, document: 'abc', revision, header: 'URL https://example.test | title Application | tab 7', lines })
function roundTrip(before: BrowserSnapshot, after: BrowserSnapshot) {
  const text = renderBrowserSnapshotDelta(diffBrowserSnapshot(before, after))
  const decoded = parseBrowserSnapshotDelta(text)!
  expect(decoded).toBeDefined()
  expect(applyBrowserSnapshotDelta(before, decoded)).toEqual(after)
  return text
}

describe('lossless semantic snapshot patches', () => {
  it('keeps field and form context while changing values and enabled states', () => {
    const before = page(['[nabc-1] form "Application"', '  [eabc-2] textbox "Email" value=""', '  [eabc-3] button "Continue" [disabled]'])
    const text = roundTrip(before, page(['[nabc-1] form "Application"', '  [eabc-2] textbox "Email" value="a@example.test"', '  [eabc-3] button "Continue"'], 2))
    expect(text).toContain('Context: [nabc-1] form "Application"')
    expect(text).toContain('Changed:   [eabc-3] button "Continue"')
  })

  it('reconstructs inserts, removals, reorderings and hierarchy changes with duplicate labels', () => {
    const before = page(['[nabc-1] heading "Cart"', '  [eabc-2] button "Remove"', '  [eabc-3] button "Remove"', '[eabc-4] button "Checkout"'])
    const after = page(['[nabc-5] dialog "Confirm" [modal]', '  [eabc-4] button "Checkout"', '  [eabc-3] button "Remove"', '[nabc-1] heading "Cart"'], 2)
    const text = roundTrip(before, after)
    expect(text).toContain('Remove: [eabc-2]')
    expect(text).toContain('Place after [start]')
  })

  it('round-trips no changes, empty trees, multiline metadata and page text resembling syntax', () => {
    const initial = page(['[nabc-1] text "Changed: Remove: [eabc-2]"'])
    roundTrip(initial, { ...initial, revision: 2 })
    roundTrip(initial, { ...initial, revision: 2, header: 'URL /b\nTabs:\n  tab 8: Other' })
    roundTrip(initial, page([], 2))
    roundTrip(page([]), initial)
    expect(parseBrowserSnapshot(renderBrowserSnapshot(initial))?.snapshot).toEqual(initial)
    expect(parseBrowserSnapshot(renderBrowserSnapshot(page([])))?.snapshot).toEqual(page([]))
    expect(parseBrowserSnapshot(renderBrowserSnapshot(initial).slice(0, -10))).toBeUndefined()
  })

  it('rejects wrong baselines and duplicate node identities', () => {
    const first = page(['[eabc-1] button "Go"'])
    const delta = diffBrowserSnapshot(first, { ...first, revision: 2 })
    expect(() => applyBrowserSnapshotDelta({ ...first, document: 'different' }, delta)).toThrow('baseline mismatch')
    expect(() => applyBrowserSnapshotDelta({ ...first, revision: 9 }, delta)).toThrow('baseline mismatch')
    expect(parseBrowserSnapshot(renderBrowserSnapshot(page([first.lines[0]!, first.lines[0]!])))).toBeUndefined()
  })

  it('reconstructs 200 deterministic transitions mixing additions, removals, moves and edits', () => {
    let current = page(Array.from({ length: 30 }, (_, i) => `[eabc-${i + 1}] button "Same label"`))
    let seed = 789
    const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max }
    for (let i = 0; i < 200; i++) {
      const lines = [...current.lines]
      const at = random(lines.length || 1)
      if (i % 4 === 0) lines.splice(at, 0, `[eabc-${100 + i}] textbox "New" value="${i}"`)
      else if (i % 4 === 1) lines.splice(at, 1)
      else if (i % 4 === 2 && lines.length) lines.splice(random(lines.length), 0, lines.splice(at, 1)[0]!)
      else if (lines[at]) lines[at] += ' [checked]'
      const next = page(lines, i + 2)
      roundTrip(current, next)
      current = next
    }
  })
})
