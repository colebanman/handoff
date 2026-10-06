import remend, { INCOMPLETE_IMAGE_PLACEHOLDER, type RemendOptions } from 'remend'
import type { Nodes, Paragraph, Root, TableCell, Heading } from 'mdast'
import type { Processor } from 'unified'

type InlineBlock = Paragraph | Heading | TableCell

// Math is handled by its parser and must never be repaired as Markdown.
// Do not reinterpret comparisons, ranges, or setext headings.
const LITERAL_OPTIONS: RemendOptions = {
  bold: false, boldItalic: false, italic: false, strikethrough: false,
  inlineCode: false, links: false, images: false, katex: false,
  inlineKatex: false, singleTilde: false, comparisonOperators: false,
  htmlTags: false, setextHeadings: false,
}

/** Follow only the active branch, never backtrack into an earlier block. */
function tail(node: Nodes): InlineBlock | undefined {
  if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') return node
  if (node.type === 'root' || node.type === 'blockquote' || node.type === 'list' ||
      node.type === 'listItem' || node.type === 'table' || node.type === 'tableRow') {
    const last = node.children.at(-1)
    return last ? tail(last) : undefined
  }
}

/** GFM requires even code-span pipes to be escaped when they belong to a cell. */
function cells(line: string): string[] {
  const result: string[] = []
  let start = 0
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue }
    if (line[i] !== '|') continue
    result.push(line.slice(start, i).trim())
    start = i + 1
  }
  result.push(line.slice(start).trim())
  if (line.trimStart().startsWith('|')) result.shift()
  if (result.length > 1 && result.at(-1) === '' && line.trimEnd().endsWith('|')) result.pop()
  return result
}

/**
 * A leading pipe is our early table signal. Without it, wait for evidence of
 * the separator row, since ordinary prose can contain `a | b`. Synthesize the
 * separator at the header's current width; never invent header/cell contents.
 */
function predictTable(tree: Root, source: string): string {
  const block = tail(tree)
  if (block?.type !== 'paragraph' || !block.position) return source
  const start = block.position.start.offset!
  const end = block.position.end.offset!
  if (/\n[ \t]*\n/.test(source.slice(end))) return source
  const lines = source.slice(start, end).split('\n')
  if (lines.length > 2) return source
  const header = lines[0]!
  const columns = cells(header)
  if (!columns.some(Boolean)) return source
  // Continue the enclosing quote/list when inserting the synthetic row.
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  const prefix = source.slice(lineStart, start)
    .replace(/(?:[-+*]|\d{1,9}[.)])(?=[ \t])/g, (marker) => ' '.repeat(marker.length))
  const separator = lines[1]?.replace(/^[ \t]*(?:>[ \t]*)*/, '')
  if (!header.trimStart().startsWith('|') &&
      !(columns.length > 1 && separator && /[-:]/.test(separator))) return source
  if (separator !== undefined && !/^[\s|:-]*$/.test(separator)) return source
  const partial = separator ? cells(separator) : []
  if (partial.length > columns.length || partial.some((cell) => !/^:?-*:?$/.test(cell))) return source
  const row = columns.map((_, i) => {
    const cell = partial[i] ?? ''
    return `${cell.startsWith(':') ? ':' : ''}---${cell.length > 1 && cell.endsWith(':') ? ':' : ''}`
  }).join(' | ')
  return `${source.slice(0, start)}${header}\n${prefix}| ${row} |${source.slice(end)}`
}

/** Protect already parsed opaque spans and escaped punctuation from repair. */
function completeInline(block: InlineBlock, source: string): { start: number; end: number; text: string } | undefined {
  const start = block.children[0]?.position?.start.offset
  const end = block.children.at(-1)?.position?.end.offset
  if (start === undefined || end === undefined) return
  let text = source.slice(start, end)
  let token = 'PREDICTIVEMARKDOWN'
  while (text.includes(token)) token += 'X'
  const originals: string[] = []
  const mask = (value: string): string => `${token}${originals.push(value) - 1}END`
  const spans: Array<{ start: number; end: number }> = []
  function collect(node: Nodes): void {
    if (['inlineCode', 'inlineMath', 'math', 'link', 'image', 'html', 'linkReference', 'imageReference', 'footnoteReference',
      'strong', 'emphasis', 'delete'].includes(node.type)) {
      if (node.position) spans.push({ start: node.position.start.offset!, end: node.position.end.offset! })
    } else if ('children' in node) node.children.forEach(collect)
  }
  block.children.forEach(collect)
  for (const span of spans.reverse()) {
    text = text.slice(0, span.start - start) + mask(source.slice(span.start, span.end)) + text.slice(span.end - start)
  }
  // An unfinished equation is still text in the syntax tree. Leave its TeX
  // alone until the closing delimiter arrives (underscores are not italics).
  if (/(?<!\\)\$(?!\d)|\\[([]/.test(text)) return
  text = text.replace(/\\(?:[*_~`]+|[!\[\]\\])/g, mask)
  // Delimiters surrounded by whitespace cannot open or close emphasis.
  text = text.replace(/(?<=\s)[*_~]+(?=\s)/g, mask)
  // A trailing escape belongs to the next streamed character. It must not
  // escape a synthetic closing delimiter in this frame.
  if (text.endsWith('\\')) text = text.slice(0, -1)
  // Closing code first matters for **bold `code: emphasis must close OUTSIDE
  // the code span, not become literal asterisks inside it.
  text = remend(text, { ...LITERAL_OPTIONS, inlineCode: true })
  text = remend(text, {
    ...LITERAL_OPTIONS, links: true, images: true, linkMode: 'text-only',
  })
  // Close the innermost pending style first, then reparse and protect it on
  // the next pass. A fixed handler order misnests **bold ~~strike (and the
  // reverse), or mistakes a completed inner emphasis for the outer closer.
  const tried = new Set<string>()
  for (const [marker] of [...text.matchAll(/\*{1,3}|_{1,3}|~~/g)].reverse()) {
    const option = marker[0] === '_' ? 'italic' : marker === '~~' ? 'strikethrough'
      : marker.length === 3 ? 'boldItalic' : marker.length === 2 ? 'bold' : 'italic'
    if (tried.has(option)) continue
    tried.add(option)
    const completed = remend(text, { ...LITERAL_OPTIONS, [option]: true })
    // Word-internal underscores and multiplication signs can be later than
    // the real opener. An inert marker must not suppress outer completion.
    if (completed !== text) { text = completed; break }
  }
  text = text.replace(new RegExp(`${token}(\\d+)END`, 'g'), (_, index: string) => originals[Number(index)]!)
  return text === source.slice(start, end) ? undefined : { start, end, text }
}

/** Checkboxes need a list-item context; `[x` in prose is just an open link. */
function predictTask(tree: Root): boolean {
  let node: Nodes = tree
  let item: Extract<Nodes, { type: 'listItem' }> | undefined
  while ('children' in node && node.children.length) {
    if (node.type === 'listItem') item = node
    if (node.type === 'paragraph') break
    node = node.children.at(-1)!
  }
  if (!item || item.children[0] !== node || node.type !== 'paragraph' || node.children.length !== 1) return false
  const child = node.children[0]!
  if (child.type !== 'text' || !/^\[(?:[ xX]\]?)?$/.test(child.value)) return false
  item.checked = /^\[[xX]/.test(child.value)
  node.children = []
  return true
}

function pendingImages(node: Nodes): void {
  if (!('children' in node)) return
  const children: Nodes[] = node.children
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!
    if (child.type === 'image' && child.url === INCOMPLETE_IMAGE_PLACEHOLDER) {
      // No broken image icon, empty src request, or request to a partial URL.
      children[i] = { type: 'text', value: child.alt ?? '' }
    } else pendingImages(child)
  }
}

/**
 * Opt-in, display-only streaming repair. Use the real parser's block boundaries
 * so prediction cannot spill into earlier paragraphs, code, or table cells.
 * Final messages always use the original Markdown without this plugin.
 */
export default function remarkPredictiveMarkdown(this: Processor) {
  const parser = this
  return (tree: Root, file: { value: unknown }): void => {
    let source = String(file.value)
    // An empty line seals the preceding inline block, even before the next
    // block has any text. The block splitter preserves this trailing boundary.
    if (/\n[ \t]*\n[\s]*$/.test(source)) return
    const tableSource = predictTable(tree, source)
    if (tableSource !== source) {
      source = tableSource
      tree.children = (parser.parse(source) as Root).children
    }
    if (predictTask(tree)) return
    // Bound reparsing for adversarial nesting; normal prose needs one pass.
    for (let depth = 0; depth < 8; depth++) {
      const block = tail(tree)
      const completion = block && completeInline(block, source)
      if (!completion) break
      source = source.slice(0, completion.start) + completion.text + source.slice(completion.end)
      tree.children = (parser.parse(source) as Root).children
    }
    pendingImages(tree)
  }
}
