import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { describe, expect, it, vi } from 'vitest'
import { MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS } from './markdown-plugins'
import { AssistantMessage } from './components/items'
import { splitMarkdownBlocks } from './markdown-blocks'

vi.mock('./store', () => ({ openMemoryFile: vi.fn() }))

const render = (children: string): string => renderToStaticMarkup(createElement(ReactMarkdown, {
  children, remarkPlugins: MARKDOWN_REMARK_PLUGINS, rehypePlugins: MARKDOWN_REHYPE_PLUGINS,
}))
const chat = (text: string, streaming = false): string => renderToStaticMarkup(createElement(AssistantMessage, { text, streaming }))

describe('Markdown math', () => {
  it.each([
    '$x^2 + y_1$', String.raw`\(x^2 + y_1\)`,
    String.raw`A $\frac{1}{2}$ and \(\sqrt{2}\).`,
    String.raw`**Bold $x_1$** and [a $y^2$ link](https://example.com).`,
    '- $x_1$\n- $x_2$', '> $x_1$',
    '| Value |\n| --- |\n| $x_1$ |',
    String.raw`$\text{cost: \$5}$`,
  ])('renders accessible inline math: %j', (source) => {
    const html = render(source)
    expect(html).toContain('class="katex"')
    expect(html).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML"')
    expect(html).not.toContain('katex-error')
  })

  it.each([
    '$$x^2$$', '$$\nx^2\n$$', '$$\nx^2\n\n+ y^2\n$$',
    String.raw`\[x^2\]`, '\\[\nx^2\n\\]', '\\[\nx^2\n\n+ y^2\n\\]',
    '```math\nx^2\n```',
    '$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$',
    '> \\[\n> x^2\n> \\]', '- \\[\n  x^2\n  \\]',
    String.raw`Here \[x^2\] is the result.`, String.raw`\[x^2\] is the result.`,
  ])('renders display math: %j', (source) => {
    const html = render(source)
    expect(html).toContain('class="katex-display"')
    expect(html).toContain('tabindex="0" role="region" aria-label="Equation"')
    expect(html).not.toContain('katex-error')
    expect(html).not.toContain('<pre>')
  })

  it.each([
    'Costs $5 and $10.', 'From $19.99 to $29.99', '$100',
    String.raw`Escaped \$x\$ and \\(x\\).`,
    '`$x$` and `\\(x\\)`', '```latex\n$x$\n\\[x\\]\n```',
    '    $x$\n    \\[x\\]', '[link](https://example.com/$x$)',
    'Costs $5 and $10. Code: `$x_1$`.',
  ])('preserves currency, escaped delimiters and code: %j', (source) => {
    expect(render(source)).not.toContain('class="katex')
  })

  it('does not swallow a later equation after a price', () => {
    const html = render('Pay $5 to solve $x^2$.')
    expect(html).toContain('Pay $5 to solve ')
    expect(html).toContain('class="katex"')
  })

  it('keeps malformed input readable and renders later equations', () => {
    const html = render(String.raw`Bad $\frac{$ but good $x^2$.`)
    expect(html).toContain('katex-error')
    expect(html).toContain('\\frac{')
    expect(html).toContain('class="katex"')
  })

  it.each([
    String.raw`$\href{javascript:alert(1)}{click}$`,
    String.raw`$\includegraphics{https://example.com/tracker.png}$`,
    String.raw`$\htmlClass{injected}{x}$`,
  ])('does not trust HTML, links or remote media in TeX: %j', (source) => {
    const html = render(source)
    expect(html).not.toMatch(/<(?:a|img|script)\b/)
    expect(html).not.toContain('class="injected"')
  })

  it('bounds recursive macros and keeps definitions local to each equation', () => {
    expect(render(String.raw`$\def\foo{\foo}\foo$`)).toContain('katex-error')
    const html = render(String.raw`$\gdef\custom{X}\custom$ and $\custom$`)
    expect(html).toContain('class="katex"')
    expect(html).toContain('\\custom')
  })
})

describe('streaming math integration', () => {
  it.each(['$$\nx^2\n\n+ y^2\n$$', '\\[\nx^2\n\n+ y^2\n\\]'])('keeps a multiline equation in one block: %j', (equation) => {
    const source = `Before.\n\n${equation}\n\nAfter.`
    const blocks = splitMarkdownBlocks(source)
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toContain(equation)
    expect(chat(source)).toContain('class="katex-display"')
  })

  it('never injects reveal spans or a caret inside math', () => {
    const html = chat('$x_1 + y^2$', true)
    expect(html).toContain(render('$x_1 + y^2$').replace('<p>', '').replace('</p>', ''))
    expect(html).not.toContain('md-word')
    expect(html.match(/assistant__caret/g)).toHaveLength(1)
    expect(html).toContain('</span><i class="assistant__caret"')
  })

  it('retains display math after predictive reparsing', () => {
    expect(chat(String.raw`Here \[x^2\] and **bold`, true)).toContain('class="katex-display"')
  })

  it.each(['$x_1 + y_2', String.raw`\(x_1 + y_2`, String.raw`\[x_1 + y_2`])('does not predict emphasis inside unfinished math: %j', (source) => {
    expect(chat(source, true)).not.toMatch(/<(?:em|strong)>/)
  })

  it('renders safely through every character of a streaming equation', () => {
    const source = String.raw`The result is $\frac{x_1}{\sqrt{2}}$.

\[
\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
\]`
    for (let length = 1; length <= source.length; length++) {
      expect(() => chat(source.slice(0, length), true), source.slice(0, length)).not.toThrow()
    }
    expect(chat(source)).not.toContain('katex-error')
  })

  it('keeps table labels free of duplicate HTML and MathML content', () => {
    expect(chat('| $x_1$ |\n| --- |\n| 2 |')).toContain('data-label="x_1"')
  })
})
