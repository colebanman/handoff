/**
 * Rehype plugin that wraps every word of the assistant's answer in a
 * `<span class="md-word">` so each one can fade in as it streams — the calmer
 * cousin of the composer's ghost-text reveal.
 *
 * Why the animation is opacity-only (see `.md-word` in theme.css): the ghost
 * text transforms each character, which requires `display: inline-block`, which
 * makes every character its own break opportunity — the line breaker then
 * splits words mid-way ("F / inal"). The composer works around that with nowrap
 * word wrappers, but prose full of headings, links and list items can't afford
 * that kind of layout surgery. A pure opacity fade needs no `inline-block` at
 * all, so these spans stay `display: inline` and markdown wraps exactly as it
 * did before the plugin existed.
 *
 * Two rules make the rest of it cheap:
 *
 * - The whitespace BETWEEN words is left as ordinary text nodes rather than
 *   folded into the spans. Those runs remain the natural break opportunities,
 *   so wrapping is unchanged and no `white-space` tricks are needed.
 * - `pre` and `code` subtrees are skipped entirely. rehype-highlight has
 *   already tokenised them into its own spans; slicing those apart would
 *   corrupt the highlight markup and, for `pre`, break the mono layout. Links
 *   and every other inline element are fair game — they should reveal too.
 *
 * There is deliberately NO stagger. A CSS animation fires when its element is
 * inserted, so the reveal is paced by whatever inserts the words — and that is
 * the jitter buffer in reveal.ts, which hands them over on a steady clock
 * rather than in the clumps the provider delivers. An artificial per-word
 * delay here would run behind the text and desynchronise from the caret.
 *
 * Applied only to the LAST block while streaming (see MarkdownBlock in
 * items.tsx): that bounds the extra parse work to one paragraph and keeps
 * reopened chats plain — thousands of words fading at once is not a reveal,
 * it's a flash.
 */
import type { Element, ElementContent, Root, RootContent, Text } from 'hast'

/** Subtrees whose text belongs to rehype-highlight, not to us. */
const OPAQUE_TAGS = new Set(['pre', 'code'])

/** Splits into words and the whitespace runs between them, both preserved. */
const TOKENS = /(\s+)/

function word(value: string): Element {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['md-word'] },
    children: [{ type: 'text', value }],
  }
}

/**
 * Expands one text node into alternating word elements and whitespace text
 * nodes. Returns a single-node list unchanged when there is nothing to split
 * (pure whitespace, or a lone word) so the common case adds no garbage.
 */
function splitText(node: Text): Array<Element | Text> {
  if (node.value.trim() === '') return [node]
  const parts = node.value.split(TOKENS)
  const out: Array<Element | Text> = []
  for (const part of parts) {
    if (part === '') continue
    out.push(part.trim() === '' ? { type: 'text', value: part } : word(part))
  }
  return out
}

/**
 * Rewrites `children` in place. Hand-rolled rather than unist-util-visit,
 * which is only a transitive dependency here and would need adding for this.
 */
function walk(children: Array<RootContent | ElementContent>): void {
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    if (child.type === 'text') {
      const parts = splitText(child)
      if (parts.length !== 1) {
        children.splice(i, 1, ...parts)
        i += parts.length - 1
      }
      continue
    }
    if (child.type !== 'element') continue
    if (OPAQUE_TAGS.has(child.tagName)) continue
    walk(child.children)
  }
}

export default function rehypeMarkdownReveal(): (tree: Root) => void {
  return (tree: Root): void => {
    walk(tree.children)
  }
}
