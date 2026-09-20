import { isRuntimeContextText, RUNTIME_CONTEXT_START } from './context-blocks'

const REPL_BLOCK = /<repl-extensions>[\s\S]*?<\/repl-extensions>/g
export function replContextMessage(block: string): string {
  return `${RUNTIME_CONTEXT_START}${block}\n</context>`
}

/** Works on both SDK messages and Responses wire items. Opaque compaction is
 * not evidence that callable docs survived. Keep one exact, readable inventory. */
export function reconcileReplContext<T extends { role?: unknown; content?: unknown }>(
  items: T[], block: string | undefined, make: (text: string) => T,
): T[] {
  if (!block) return items
  const texts = items.map((item) => {
    if (item.role !== 'user') return ''
    const content = item.content
    const text = typeof content === 'string' ? content : Array.isArray(content) && content.every((p) => typeof p?.text === 'string')
      ? content.map((p) => p.text).join('\n') : ''
    return isRuntimeContextText(text) ? text : ''
  })
  let keep = -1
  texts.forEach((text, i) => { if ([...text.matchAll(REPL_BLOCK)].at(-1)?.[0] === block) keep = i })
  // An older identical block is superseded by any later different inventory.
  if (texts.some((text, i) => i > keep && /<repl-extensions>/.test(text))) keep = -1
  let changed = false
  const result = items.flatMap((item, i) => {
    const text = texts[i]!
    if (i === keep || !text.includes('<repl-extensions>')) return [item]
    changed = true
    const replaced = text.replace(REPL_BLOCK, '').replace(/\n{3,}/g, '\n\n')
    if (replaced.replace(RUNTIME_CONTEXT_START, '').replace(/\s*<\/context>$/, '').trim() === '') return []
    const content = typeof item.content === 'string' ? replaced : [{ ...(item.content as any[])[0], text: replaced }]
    return [{ ...item, content }]
  })
  if (keep < 0) { result.push(make(replContextMessage(block))); changed = true }
  return changed ? result : items
}
