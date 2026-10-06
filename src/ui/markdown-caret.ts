/**
 * Rehype plugin that places the streaming caret INSIDE the text, at the end of
 * its last line — the last paragraph, list item, heading or table cell —
 * instead of after the last block, where it sat alone on a line of its own
 * under the prose.
 *
 * The caret is an `<i>`: react-markdown keys children by tag and position
 * (`span-3`), so a span caret would trade keys with each word appended in
 * front of it. Nothing else here renders `<i>` (emphasis is `<em>`), so the
 * caret keeps one key and one DOM node while words stream in before it.
 */
import type { Element, ElementContent, Root } from 'hast'

/**
 * Elements the caret descends into to reach the last line. Anything else stops
 * the descent and the caret follows it: a word span, a link (a caret inside
 * <a> would be part of the link), a code block.
 */
const CONTAINERS = new Set([
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'strong', 'em', 'del',
])

function caret(): Element {
  return {
    type: 'element',
    tagName: 'i',
    properties: { className: ['assistant__caret'], ariaHidden: 'true' },
    children: [],
  }
}

function lastElement(children: ElementContent[]): Element | undefined {
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i]!
    if (child.type === 'element') return child
    // Trailing text means the caret belongs right here, after it.
    if (child.type === 'text' && child.value.trim()) return undefined
  }
  return undefined
}

export default function rehypeStreamCaret(): (tree: Root) => void {
  return (tree: Root): void => {
    let host: Root | Element = tree
    for (;;) {
      const next = lastElement(host.children as ElementContent[])
      if (!next || !CONTAINERS.has(next.tagName)) break
      host = next
    }
    host.children.push(caret())
  }
}
