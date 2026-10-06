import type { Element, ElementContent, Root, RootContent } from 'hast'

function textOf(node: Element | ElementContent): string {
  if (node.type === 'text') return node.value
  if ('children' in node) return node.children.map(textOf).join('')
  return ''
}

/** Preserve column headings as labels when a markdown table becomes row cards. */
export default function rehypeTableLabels(): (tree: Root) => void {
  return (tree) => {
    const visit = (node: Root | RootContent | ElementContent): void => {
      if (!('children' in node)) return
      for (const child of node.children) {
        if (child.type === 'element' && child.tagName === 'table') {
          const head = child.children.find((part): part is Element => part.type === 'element' && part.tagName === 'thead')
          const headerRow = head?.children.find((part): part is Element => part.type === 'element' && part.tagName === 'tr')
          const labels = headerRow?.children
            .filter((part): part is Element => part.type === 'element' && part.tagName === 'th')
            .map((cell) => textOf(cell).trim()) ?? []
          for (const body of child.children) {
            if (body.type !== 'element' || body.tagName !== 'tbody') continue
            for (const row of body.children) {
              if (row.type !== 'element' || row.tagName !== 'tr') continue
              let column = 0
              for (const cell of row.children) {
                if (cell.type !== 'element' || cell.tagName !== 'td') continue
                cell.properties['data-label'] = labels[column] ?? ''
                column += 1
              }
            }
          }
        }
        visit(child)
      }
    }
    visit(tree)
  }
}
