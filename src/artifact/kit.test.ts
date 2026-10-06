import { beforeAll, describe, expect, it } from 'vitest'
import kitJs from './kit.js?raw'

interface Kit {
  markdown: (src: string) => string
  tone: (text: string) => string
  inline: (text: string) => string
}

let kit: Kit

beforeAll(() => {
  // kit.js only needs these at load time; rendering helpers are pure strings.
  const scope = {
    HTMLElement: class {},
    customElements: { get: () => undefined, define: () => undefined },
    document: { readyState: 'complete', addEventListener: () => undefined },
  } as Record<string, unknown>
  scope.window = scope
  new Function('window', 'HTMLElement', 'customElements', 'document', kitJs)(scope, scope.HTMLElement, scope.customElements, scope.document)
  kit = scope.AiKit as Kit
})

describe('kit markdown', () => {
  it('renders tables as kit tables with alignment and numeric columns', () => {
    const html = kit.markdown('| Item | Cost | Note |\n|-|-|:-:|\n| **A** | $1,200 | ok |\n| B | 30% | x |')
    expect(html).toContain('<div class="table-wrap"><table class="table">')
    expect(html).toContain('<td class="num">$1,200</td>')
    expect(html).toContain('<td class="center">ok</td>')
    expect(html).toContain('<td><strong>A</strong></td>')
  })

  it('nests lists by indentation and makes task items persistent checkboxes', () => {
    const html = kit.markdown('- one\n  - child\n- [x] done\n- [ ] todo')
    expect(html).toMatch(/<li>one\n?<ul><li>child<\/li><\/ul><\/li>/)
    expect(html).toContain('class="task checked"')
    expect(html.match(/data-task="/g)).toHaveLength(2)
  })

  it('expands directives into components, including nested ones', () => {
    const html = kit.markdown([
      '::: grid 2',
      '::: card Plan | This week',
      'Body **text**',
      ':::',
      '::: warning Heads up',
      'Careful.',
      ':::',
      ':::',
      '::: details How this was built {open}',
      '- a',
      ':::',
    ].join('\n'))
    expect(html).toContain('<div class="grid cols-2">')
    expect(html).toContain('<div class="card-title">Plan</div><div class="card-description">This week</div>')
    expect(html).toContain('callout tone-warning')
    expect(html).toContain('<details class="disclosure" open><summary>How this was built</summary>')
  })

  it('splits cards, tabs, and accordions on headings', () => {
    const cards = kit.markdown('::: cards\n### [Job A](https://a.com)\n:badge[Remote] Example City\n### Job B\nText\n:::')
    expect(cards.match(/card card-item/g)).toHaveLength(2)
    expect(cards).toContain('<a href="https://a.com"')
    const tabs = kit.markdown('::: tabs\n## Week 1\nx\n## Week 2\ny\n:::')
    expect(tabs).toContain('<ai-tab name="t0" label="Week 1">')
    const acc = kit.markdown('::: accordion\n### Q1\nA1\n### Q2\nA2\n:::')
    expect(acc.match(/<details/g)).toHaveLength(2)
  })

  it('renders stats, bars, kv, steps, timeline, and sources compactly', () => {
    expect(kit.markdown('::: stats\nDue | 7 | +2 | this week\nOverdue | 1\n:::')).toContain('<div class="stat-value">7</div>')
    expect(kit.markdown('::: bars\nQuiz 1 | 18/20\nQuiz 2 | 9/20\n:::')).toContain('width:90.0%')
    expect(kit.markdown('::: kv\nOwner: Dana\n**Due:** Fri\n:::')).toContain('<dt>Due</dt><dd>Fri</dd>')
    const steps = kit.markdown('::: steps\n- [x] **Draft** — write it\n- **Submit**\n:::')
    expect(steps).toContain('<ol class="steps"><li class="done">')
    expect(steps).toContain('<div class="step-title">Draft</div>')
    expect(kit.markdown('::: timeline\n- **9:00** Standup\n:::')).toContain('<div class="tl-time">9:00</div>')
    expect(kit.markdown('::: sources\n- [Case](https://docs.google.com/x)\n:::')).toContain('<aside class="sources"><div class="sources-title">Sources</div>')
  })

  it('supports GitHub alerts, inline badges with inferred tone, and raw HTML blocks', () => {
    expect(kit.markdown('> [!TIP] Shortcut\n> Use it')).toContain('callout tone-success')
    expect(kit.inline(':badge[Overdue] :badge-brand[New] :kbd[⌘K] ==hi==')).toBe(
      '<span class="badge badge-destructive">Overdue</span> <span class="badge badge-brand">New</span> <kbd>⌘K</kbd> <mark>hi</mark>',
    )
    expect(kit.markdown('<ai-stat label="A" value="1"></ai-stat>\n\ntext')).toContain('<ai-stat label="A" value="1"></ai-stat>')
    expect(kit.tone('Submitted')).toBe('success')
    expect(kit.tone('Due Oct 3')).toBe('')
  })

  it('escapes text and keeps link URLs intact through emphasis rules', () => {
    const html = kit.inline('a <script> & [x](https://e.com/a_b_c) *em* snake_case_word')
    expect(html).toContain('&lt;script&gt; &amp;')
    expect(html).toContain('href="https://e.com/a_b_c"')
    expect(html).toContain('<em>em</em>')
    expect(html).toContain('snake_case_word')
  })

  it('wraps unknown directives as a titled card instead of dropping content', () => {
    const html = kit.markdown('::: mystery Title\nbody\n:::')
    expect(html).toContain('<div class="card-title">Title</div>')
    expect(html).toContain('<p>body</p>')
  })
})
