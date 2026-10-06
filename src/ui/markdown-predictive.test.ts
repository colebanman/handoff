import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it, vi } from 'vitest'
import remarkPredictiveMarkdown from './markdown-predictive'
import { splitMarkdownBlocks } from './markdown-blocks'
import { AssistantMessage } from './components/items'

vi.mock('./store', () => ({ openMemoryFile: vi.fn() }))

function render(text: string, streaming = true): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    children: text, remarkPlugins: streaming ? [remarkGfm, remarkPredictiveMarkdown] : [remarkGfm],
  }))
}

describe('predictive inline markdown', () => {
  it.each([
    ['**Hi there', '<strong>Hi there</strong>'],
    ['__Hi there', '<strong>Hi there</strong>'],
    ['*Hi there', '<em>Hi there</em>'],
    ['_Hi there', '<em>Hi there</em>'],
    ['***Hi there', '<em><strong>Hi there</strong></em>'],
    ['~~Hi there', '<del>Hi there</del>'],
    ['`Hi there', '<code>Hi there</code>'],
    ['``a ` b', '<code>a ` b</code>'],
    ['**Hi*', '<strong>Hi</strong>'],
    ['**bold _nested', '<strong>bold <em>nested</em></strong>'],
    ['**bold *nested', '<strong>bold <em>nested</em></strong>'],
    ['**bold ~~strike', '<strong>bold <del>strike</del></strong>'],
    ['~~strike **bold', '<del>strike <strong>bold</strong></del>'],
    ['**bold *nested* end', '<strong>bold <em>nested</em> end</strong>'],
    ['***Hi*', '<em><strong>Hi</strong></em>'],
    ['***Hi**', '<em><strong>Hi</strong></em>'],
    ['*a **b ~~c `d', '<em>a <strong>b <del>c <code>d</code></del></strong></em>'],
    ['**hello snake_case', '<strong>hello snake_case</strong>'],
    ['~~hello snake_case', '<del>hello snake_case</del>'],
    ['**cost 2 * 3', '<strong>cost 2 * 3</strong>'],
    ['**bold `code', '<strong>bold <code>code</code></strong>'],
    ['~~strike `code', '<del>strike <code>code</code></del>'],
    ['## **Hi', '<h2><strong>Hi</strong></h2>'],
    ['> **Hi', '<strong>Hi</strong>'],
    ['- **Hi', '<li><strong>Hi</strong></li>'],
    ['**Hi \nthere ', '<strong>Hi\nthere</strong>'],
  ])('formats %j before its closing marker arrives', (source, expected) => {
    expect(render(source)).toContain(expected)
  })

  it.each([
    'snake_case', 'foo__bar', '2 * 3', '20~25', '$25 and $$50',
    '\\**literal', '\\_literal', '`**literal`', '**finished** and plain',
    '```md\n**literal', '~~~md\n**literal', '    **literal',
    '```md\n| A | B |\n| -', '> ```md\n> **literal',
    '- ```md\n  **literal', '**earlier\n\nplain', '**ended\n\n',
    '# Heading', '> Quote', '1. First', '---', 'Heading\n===',
    '[link](https://example.com)', '![alt](https://example.com/image.png)',
    '- > quoted text', 'Use <custom',
  ])('preserves literal or already complete markdown: %j', (source) => {
    expect(render(source)).toBe(render(source, false))
  })

  it('does not let code or escaped delimiters affect outer formatting', () => {
    expect(render('**hello \\* world')).toContain('<strong>hello * world</strong>')
    expect(render('**hello `**` world')).toContain('<strong>hello <code>**</code> world</strong>')
  })

  it.each(['*', '**', '***', '_', '__', '___', '~~', '`', '``'])('holds formatting through every closing character of %j', (marker) => {
    const finished = `${marker}Hello${marker}`
    for (let i = marker.length + 1; i <= finished.length; i++) {
      const html = render(finished.slice(0, i))
      expect(html, finished.slice(0, i)).not.toMatch(/[~*_`]/)
      expect(html).not.toMatch(/^<p>[^<]/)
    }
  })

  it.each(['[Read more', '[Read more](', '[Read more](https://exam', '[Read more](https://example.com "Title'])('keeps unfinished links inert: %j', (source) => {
    expect(render(source)).toBe('<p>Read more</p>')
  })

  it.each(['![Preview', '![Preview](', '![Preview](https://exam'])('does not fetch an incomplete image: %j', (source) => {
    expect(render(source)).toBe('<p>Preview</p>')
  })

  it.each(['- [', '- [ ', '- [x', '- [x]', '- [ ]'])('predicts a task checkbox: %j', (source) => {
    const html = render(source)
    expect(html).toContain('type="checkbox"')
    expect(html.includes('checked=""')).toBe(source.includes('x'))
  })
})

describe('predictive tables', () => {
  it.each(['| Name', '| Name | Age |', '| Name | Age |\n', '| Name | Age |\n|', '| Name | Age |\n| --', '| Name | Age |\n| --- | :', '| Name | Age |\n| --- | :--'])('renders an unfinished table: %j', (source) => {
    const html = render(source)
    expect(html).toContain('<table>')
    expect(html).toContain('<th>Name</th>')
    expect(html).not.toContain('<td>')
  })

  it('keeps table shape through every character of the separator', () => {
    const header = '| Name | Age |\n'
    const separator = '| :--- | ---: |'
    for (let i = 0; i <= separator.length; i++) {
      const html = render(header + separator.slice(0, i))
      expect(html, separator.slice(0, i)).toContain('<table>')
      expect(html.match(/<th(?:>| )/g)).toHaveLength(2)
      expect(html).not.toContain('<td>')
    }
    expect(render(header + separator)).toContain('text-align:right')
  })

  it('predicts formatting inside the active table cell', () => {
    expect(render('| Name | **Age')).toContain('<th><strong>Age</strong></th>')
    expect(render('| Name | Age |\n| --- | --- |\n| Jo | **42')).toContain('<td><strong>42</strong></td>')
  })

  it('counts escaped pipes correctly, including code spans', () => {
    const html = render('| `a\\|b` | c |\n| -')
    expect(html.match(/<th>/g)).toHaveLength(2)
    expect(html).toContain('<code>a|b</code>')
  })

  it.each(['> | Name | Age |\n> | --', '- | Name | Age |\n  | --'])('supports container tables: %j', (source) => {
    expect(render(source)).toContain('<table>')
  })

  it('waits for a separator when there is no leading pipe', () => {
    expect(render('Name | Age')).not.toContain('<table>')
    expect(render('Name | Age\n--- |')).toContain('<table>')
  })

  it.each(['a \\| b', '| A | B |\nordinary prose', '| A | B |\n| - | - | -', '| A | B |\n\n'])('rejects ambiguous or incompatible rows: %j', (source) => {
    expect(render(source)).toBe(render(source, false))
  })
})

describe('streaming integration', () => {
  it('enables prediction only while the assistant is streaming', () => {
    const source = '**Hi there'
    const live = renderToStaticMarkup(createElement(AssistantMessage, { text: source, streaming: true }))
    const done = renderToStaticMarkup(createElement(AssistantMessage, { text: source, streaming: false }))
    expect(live).toContain('<strong>')
    expect(done).toContain('**Hi there')
    expect(done).not.toContain('<strong>')
  })

  it('does not repair earlier blocks or a block sealed by a blank line', () => {
    for (const text of ['**earlier\n\nplain', '**earlier\n\n']) {
      const html = renderToStaticMarkup(createElement(AssistantMessage, { text, streaming: true }))
      expect(html).not.toContain('<strong>')
    }
  })

  it('keeps code fences together and requires a real closing fence', () => {
    const source = '```md\n```not-a-close\n\n**literal\n```\n\nNext'
    const blocks = splitMarkdownBlocks(source)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toContain('\n\n**literal')
    expect(render(blocks[0]!)).toBe(render(blocks[0]!, false))
  })

  it('retains loose lists and definitions across block boundaries', () => {
    expect(splitMarkdownBlocks('- One\n  continued\n\n- Two')).toHaveLength(1)
    const reference = '[Example][id]\n\n[id]: https://example.com'
    expect(splitMarkdownBlocks(reference)).toEqual([reference])
    expect(renderToStaticMarkup(createElement(AssistantMessage, { text: reference, streaming: false }))).toContain('href="https://example.com"')
  })

  it('settles completed formatting to exactly the normal renderer', () => {
    const source = '# **Heading**\n\n**Bold** and *italic* with `code`.\n\n| Name | Age |\n| :--- | ---: |\n| Jo | **42** |'
    expect(render(source)).toBe(render(source, false))
  })
})
