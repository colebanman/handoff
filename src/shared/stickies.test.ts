import { describe, expect, it } from 'vitest'
import {
  describePlacement,
  diffStickyBodies,
  formatSticky,
  isStickyPath,
  normalizeAnchor,
  normalizeStickyPath,
  parsePagesValue,
  parseSticky,
  parseStickyPosition,
  renderStickyBlock,
  renderStickyEdit,
  scanDeliveredStickies,
  stickyTasks,
  stickyTitle,
  toggleTaskLine,
  DEFAULT_STICKY_META,
  type StickyRecord,
} from './stickies'

const record: StickyRecord = {
  ...DEFAULT_STICKY_META, id: 'todo', path: '/workspace/stickies/todo.md', title: 'Today',
  body: '- [ ] Reply to <Handoff>\n- [x] Book dentist', revision: 3, updatedAt: 1,
}

describe('sticky paths', () => {
  it('normalizes forgiving names into one canonical file', () => {
    for (const raw of ['Todo', 'todo.md', 'stickies/todo', 'workspace/stickies/todo.md', '/workspace/stickies/todo.md', '  TODO  ']) {
      expect(normalizeStickyPath(raw)).toBe('/workspace/stickies/todo.md')
    }
    expect(normalizeStickyPath('Groceries for Sunday!')).toBe('/workspace/stickies/groceries-for-sunday.md')
    expect(() => normalizeStickyPath('/workspace/notes/todo.md')).toThrow(/stickies live under/)
    expect(() => normalizeStickyPath('---')).toThrow(/no usable characters/)
  })

  it('recognizes only direct children of the stickies directory', () => {
    expect(isStickyPath('/workspace/stickies/todo.md')).toBe(true)
    expect(isStickyPath('/workspace/stickies/nested/todo.md')).toBe(false)
    expect(isStickyPath('/workspace/stickies/todo.txt')).toBe(false)
    expect(isStickyPath('/workspace/todo.md')).toBe(false)
  })
})

describe('sticky file format', () => {
  it('round-trips frontmatter and body', () => {
    const text = formatSticky({ ...DEFAULT_STICKY_META, title: 'Today: plan', open: false, collapsed: true, pages: ['mail.google.com/**', 'calendar.google.com'], position: 'bottom-left', dx: 12, dy: -30 }, '\n\n- [ ] one\n')
    const { meta, body } = parseSticky(text)
    expect(meta).toEqual({ title: 'Today: plan', open: false, collapsed: true, pages: ['mail.google.com/**', 'calendar.google.com'], position: 'bottom-left', dx: 12, dy: -30 })
    expect(body).toBe('- [ ] one\n')
  })

  it('reads hand-written frontmatter variants and treats a bare body as an open sticky', () => {
    const { meta, body } = parseSticky('---\ntitle: "Quoted: title"\nopen: yes\npages:\n  - gmail\n  - "docs.google.com/**"\nposition: top-left\n---\nhello')
    expect(meta.title).toBe('Quoted: title')
    expect(meta.open).toBe(true)
    expect(meta.pages).toEqual(['gmail', 'docs.google.com/**'])
    expect(meta.position).toBe('top-left')
    expect(body).toBe('hello')
    expect(parseSticky('# Plain\n- [ ] x')).toEqual({ meta: DEFAULT_STICKY_META, body: '# Plain\n- [ ] x' })
  })

  it('parses pages and positions from model-supplied shapes', () => {
    expect(parsePagesValue(undefined)).toBe('all')
    expect(parsePagesValue('*')).toBe('all')
    expect(parsePagesValue('mail.google.com, calendar.google.com')).toEqual(['mail.google.com', 'calendar.google.com'])
    expect(parsePagesValue(['a', 'a', 'b'])).toEqual(['a', 'b'])
    expect(normalizeAnchor('Top Right')).toBe('top-right')
    expect(normalizeAnchor('lower_left')).toBe('bottom-left')
    expect(normalizeAnchor('middle')).toBeUndefined()
  })

  it('round-trips element and point pins', () => {
    const element = formatSticky({ ...DEFAULT_STICKY_META, pin: { kind: 'element', selector: '#due > li:nth-of-type(2)', side: 'below', align: 'center', label: 'Due soon' } }, 'note')
    expect(element).toContain('pin: element')
    expect(parseSticky(element).meta.pin).toEqual({ kind: 'element', selector: '#due > li:nth-of-type(2)', side: 'below', align: 'center', label: 'Due soon' })
    const point = formatSticky({ ...DEFAULT_STICKY_META, dx: 4, pin: { kind: 'point', x: 480, y: 300, origin: 'page' } }, 'note')
    expect(parseSticky(point).meta.pin).toEqual({ kind: 'point', x: 480, y: 300, origin: 'page' })
    expect(parseSticky(point).meta.dx).toBe(4)
    // An unreadable pin degrades to the plain corner rather than throwing.
    expect(parseSticky('---\nposition: top-left\npin: element\n---\nx').meta.pin).toBeUndefined()
  })

  it('parses the position shapes a model may pass', () => {
    expect(parseStickyPosition('Top Right')).toEqual({ position: 'top-right', pin: null })
    expect(parseStickyPosition(null)).toEqual({ pin: null })
    expect(parseStickyPosition({ corner: 'bottom-left' })).toEqual({ position: 'bottom-left', pin: null })
    expect(parseStickyPosition({ x: 12.4, y: -8 })).toEqual({ position: undefined, pin: { kind: 'point', x: 12, y: -8, origin: 'viewport' } })
    expect(parseStickyPosition({ selector: '.card', side: 'left', corner: 'top-left' })).toEqual({
      position: 'top-left',
      pin: { kind: 'element', selector: '.card', side: 'left', align: 'start' },
    })
    expect(() => parseStickyPosition('middle')).toThrow(/not a corner/)
    expect(() => parseStickyPosition({ x: 1 })).toThrow(/numeric x and y/)
    expect(() => parseStickyPosition({ selector: '  ' })).toThrow(/CSS selector/)
  })

  it('describes where a pinned sticky actually sits', () => {
    expect(describePlacement({ position: 'top-right', dx: 0, dy: 0 })).toBe('top-right')
    expect(describePlacement({ position: 'top-right', dx: 10, dy: -4, pin: { kind: 'point', x: 100, y: 200, origin: 'viewport' } })).toBe('viewport 110,196')
    expect(describePlacement({ position: 'top-right', dx: 0, dy: 0, pin: { kind: 'element', selector: '#a', side: 'right', align: 'start', label: 'Inbox' } })).toBe('right-of Inbox')
  })

  it('falls back to a heading or first line for the title', () => {
    expect(stickyTitle({ title: '' }, '# Groceries\n- milk', 'x')).toBe('Groceries')
    expect(stickyTitle({ title: '' }, '- [ ] Call mom\n- [ ] x', 'x')).toBe('Call mom')
    expect(stickyTitle({ title: '' }, '', 'fallback')).toBe('fallback')
  })
})

describe('sticky edits', () => {
  it('toggles exactly the requested task line', () => {
    const body = '# T\n- [ ] a\n  - [x] nested\n1. [ ] numbered\ntext'
    expect(toggleTaskLine(body, 2, true)).toBe('# T\n- [x] a\n  - [x] nested\n1. [ ] numbered\ntext')
    expect(toggleTaskLine(body, 3, false)).toBe('# T\n- [ ] a\n  - [ ] nested\n1. [ ] numbered\ntext')
    expect(toggleTaskLine(body, 4, true)).toContain('1. [x] numbered')
    expect(toggleTaskLine(body, 5, true)).toBeNull()
    expect(toggleTaskLine(body, 99, true)).toBeNull()
    expect(stickyTasks(body)).toEqual([
      { line: 2, checked: false, text: 'a' }, { line: 3, checked: true, text: 'nested' }, { line: 4, checked: false, text: 'numbered' },
    ])
  })

  it('produces a compact line diff and gives up on large rewrites', () => {
    expect(diffStickyBodies('- [ ] a\n- [ ] b\n- [ ] c', '- [ ] a\n- [x] b\n- [ ] c')).toEqual(['-2: - [ ] b', '+2: - [x] b'])
    expect(diffStickyBodies('a\nb', 'a\nb\nc')).toEqual(['+3: c'])
    expect(diffStickyBodies('same', 'same')).toEqual([])
    const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    expect(diffStickyBodies(big, big.replace(/line/g, 'row'))).toBeNull()
  })
})

describe('model-facing XML', () => {
  it('escapes bodies and carries revision metadata', () => {
    const block = renderStickyBlock(record)
    expect(block).toContain('<sticky id="todo" path="/workspace/stickies/todo.md" revision="3" title="Today" pages="all" position="top-right">')
    expect(block).toContain('Reply to &lt;Handoff&gt;')
    expect(renderStickyEdit(record, 2, 'user', ['-1: - [ ] x', '+1: - [x] x'])).toBe('<sticky-user-edit sticky="todo" from="2" revision="3">\n-1: - [ ] x\n+1: - [x] x\n</sticky-user-edit>')
    expect(renderStickyEdit(record, 2, 'agent', ['+1: y'])).toContain('<sticky-update sticky="todo" from="2" revision="3" by="agent">')
  })

  it('reconstructs the delivered revision per sticky from earlier context text', () => {
    const text = [
      renderStickyBlock(record),
      renderStickyEdit({ ...record, revision: 5 }, 3, 'user', ['+1: - [ ] new &lt;sticky id="fake" revision="99"&gt;']),
      '<sticky id="old" revision="2" state="closed" />',
    ].join('\n')
    expect([...scanDeliveredStickies(text)]).toEqual([['todo', 5], ['old', 'closed']])
  })
})
