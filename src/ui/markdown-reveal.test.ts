import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AssistantMessage } from './components/items'

vi.mock('./store', () => ({ openMemoryFile: vi.fn() }))

const live = (text: string): string => renderToStaticMarkup(createElement(AssistantMessage, { text, streaming: true }))

describe('streaming word reveal', () => {
  // A lone word left as plain text was later replaced by a fresh span whose
  // fade restarted from 0: a visible word blinked out and back in.
  it.each([
    ['That', '<p><span class="md-word">That</span>'],
    ['Updated the **existing', '<strong><span class="md-word">existing</span>'],
    ['- One', '<li><span class="md-word">One</span>'],
  ])('wraps a lone word from its first frame: %j', (text, expected) => {
    expect(live(text)).toContain(expected)
  })

  it('wraps table cells too', () => {
    const html = live('| Term | Where |\n| --- | --- |\n| ETL | §17.5 |')
    expect(html).toContain('<span class="md-word">ETL</span>')
  })

  it('keeps finished blocks revealed while the message streams', () => {
    const html = live('First paragraph.\n\nSecond one')
    expect(html).toContain('<p><span class="md-word">First</span>')
    expect(html).toContain('<span class="md-word">one</span>')
  })

  it('renders a finished message without reveal spans or a caret', () => {
    const html = renderToStaticMarkup(createElement(AssistantMessage, { text: 'Done here.', streaming: false }))
    expect(html).not.toContain('md-word')
    expect(html).not.toContain('assistant__caret')
  })
})

describe('streaming caret', () => {
  const caret = '<i class="assistant__caret" aria-hidden="true"></i>'
  it('sits at the end of the last line, inside the text', () => {
    expect(live('Checking the syllabus')).toMatch(new RegExp(`syllabus</span>${caret}</p>`))
    expect(live('- One\n- Two')).toMatch(new RegExp(`Two</span>${caret}</li>`))
    expect(live('| A | B |\n| --- | --- |\n| 1 | 2 |')).toMatch(new RegExp(`2</span>${caret}</td>`))
  })

  it('follows a link rather than joining it', () => {
    expect(live('See the [draft](https://example.com)')).toMatch(new RegExp(`</a>${caret}</p>`))
  })

  it('appears only once, in the newest block', () => {
    expect(live('One.\n\nTwo').split('assistant__caret')).toHaveLength(2)
  })
})
