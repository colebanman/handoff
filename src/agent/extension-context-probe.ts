import type { Match } from '../shared/extension-matching'

/** Bundled read-only probe; selectors are data, never executable model code. */
export function probe(specs: Array<{ selector: string; text?: string; visible?: boolean; frame?: string }>): Record<string, Match> {
  const result: Record<string, Match> = {}
  const roots: Array<Document | ShadowRoot> = [document]
  // Bound shadow-root traversal; an enormous page must not monopolize discovery.
  let visited = 0
  for (let i = 0; i < roots.length && roots.length < 32; i++) {
    const walker = document.createTreeWalker(roots[i]!, NodeFilter.SHOW_ELEMENT)
    let node: Node | null
    while ((node = walker.nextNode()) && visited++ < 1500) {
      const shadow = (node as Element).shadowRoot
      if (shadow && roots.length < 32) roots.push(shadow)
    }
  }
  for (const spec of specs) {
    const key = JSON.stringify(spec)
    if (spec.frame !== 'any' && window !== window.top) continue
    try {
      result[key] = roots.some((root) => [...root.querySelectorAll(spec.selector)].slice(0, 100).some((el) =>
        (!spec.text || (el.textContent ?? '').includes(spec.text)) && (!spec.visible || el.getClientRects().length > 0)))
      if (!result[key] && visited >= 1500) result[key] = 'unknown'
    } catch { result[key] = 'unknown' }
  }
  return result
}
