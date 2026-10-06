import { describe, expect, it } from 'vitest'
import { codeActions, primaryAction } from './code-actions'

const kinds = (code: string): string[] => codeActions(code).map((a) => (a.target ? `${a.kind} ${a.target}` : a.kind))

describe('code → actions', () => {
  it('names the host a snippet fetches, including through a const', () => {
    expect(kinds(`const r = await api.fetch('https://www.school.example.edu/api/v1/courses'); return r.text`)).toEqual([
      'fetch school.example.edu',
    ])
    expect(kinds(`const url = \`https://docs.google.com/document/d/\${id}/export\`; return (await api.fetch(url)).status`)).toEqual([
      'fetch docs.google.com',
    ])
    expect(kinds(`await api.page.fetch(42,'https://school.instructure.com/api/v1/courses/1')`)).toEqual([
      'fetch school.instructure.com',
    ])
  })

  it('tells a write request from a read', () => {
    expect(kinds(`await api.fetch('https://api.example.com/items', { method: 'POST', body })`)).toEqual(['send api.example.com'])
  })

  it('falls back to a URL literal when the fetch argument is a loop variable', () => {
    expect(kinds(`const urls = ['https://a.edu/x', 'https://b.edu/y']; for (const u of urls) await api.fetch(u)`)).toEqual([
      'fetch a.edu',
    ])
  })

  it('names files by their base name, keeping the folder of generic names', () => {
    expect(kinds(`return api.fs.readText('/workspace/imports/Syllabus Fall.pdf')`)).toEqual(['read-file Syllabus Fall.pdf'])
    expect(kinds(`return api.fs.readText('/skills/repl-extensions/SKILL.md')`)).toEqual(['read-file repl-extensions/SKILL.md'])
    expect(kinds(`await api.fs.writeText('/workspace/notes.md', text)`)).toEqual(['write-file notes.md'])
  })

  it('never mistakes written text for a file name, or names a spilled tool result', () => {
    expect(kinds(`await api.fs.writeText(path, 'hello world')`)).toEqual(['write-file'])
    expect(kinds(`return api.fs.readText('/workspace/.tool-output/1789-7x7v-sandbox_exec.txt')`)).toEqual(['read-file'])
  })

  it('reads what a page script does', () => {
    expect(kinds(`return api.page.eval(tab, \`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Save and Continue').click()\`)`)).toEqual([
      'click “Save and Continue”',
    ])
    expect(kinds(`return api.page.eval(tab, \`({ text: document.body.innerText.slice(0, 500) })\`)`)).toEqual(['read-page'])
    expect(kinds(`await api.page.eval(tab, \`const x = document.querySelector('input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(x, 'COURSE 101'); x.dispatchEvent(new Event('input', {bubbles:true}))\`)`)).toEqual([
      'type “COURSE 101”',
    ])
    expect(kinds(`await api.page.eval(tab, 'location.href = "https://example.org/next"')`)).toEqual(['navigate example.org'])
  })

  it('ignores class names that only look like labels', () => {
    expect(kinds(`await api.page.eval(tab, \`[...document.querySelectorAll('a')].find(a => a.className.includes('primary')).click()\`)`)).toEqual([
      'click',
    ])
  })

  it('follows a page script stored on state earlier in the same snippet', () => {
    const code = `state.clickSave = \`document.querySelector('button.save').click()\`; for (const id of ids) await api.page.eval(id, state.clickSave)`
    expect(kinds(code)).toEqual(['click'])
  })

  it('translates raw CDP input and ignores plumbing', () => {
    expect(kinds(`await api.cdp(tab, 'Input.insertText', { text: 'hello there' })`)).toEqual(['type “hello there”'])
    expect(kinds(`await api.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' }); await api.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter' })`)).toEqual([
      'key Enter',
    ])
    expect(kinds(`const box = await api.cdp(tab, 'DOM.getBoxModel', { nodeId }); await api.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })`)).toEqual([
      'click',
    ])
    expect(kinds(`await api.cdp(tab, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true })`)).toEqual(['read-page'])
    expect(kinds(`await api.cdp(tab, 'Page.createIsolatedWorld', { frameId })`)).toEqual([])
  })

  it('covers browser data, tabs and apps', () => {
    expect(kinds(`return api.history.search({ text: 'bank statement', maxResults: 20 })`)).toEqual(['history “bank statement”'])
    expect(kinds(`await api.tabs.create({ url: 'https://calendar.google.com/r/week' })`)).toEqual(['tabs-open calendar.google.com'])
    expect(kinds(`return apps.canvas.getCourses({ term: 'fall' })`)).toEqual(['app canvas.getCourses'])
    expect(kinds(`await api.stickies.create({ name: 'todos', title: 'Today', content })`)).toEqual(['sticky “Today”'])
  })

  it('does not treat API hosts inside URLs as calls', () => {
    expect(kinds(`return (await api.fetch('https://api.github.com/repos/a/b')).text`)).toEqual(['fetch api.github.com'])
  })

  it('reads a snippet that is still streaming without naming half-typed values', () => {
    expect(kinds(`const r = await api.fetch('https://canv`)).toEqual(['fetch'])
    expect(kinds(`await api.page.eval(tab, \`document.querySelector('#go').cli`)).toEqual(['read-page'])
    expect(kinds(`await api.page.eval(tab, \`document.querySelector('#go').click()`)).toEqual(['click'])
  })

  it('survives regex and comment literals that contain quotes and brackets', () => {
    const code = `// don't stop here (\n const t = (await api.fetch('https://a.org/p')).text.match(/title="([^"]+)"/); return api.fs.writeText('/workspace/t.txt', t[1])`
    expect(kinds(code)).toEqual(['fetch a.org', 'write-file t.txt'])
  })

  it('picks the action that best names the snippet', () => {
    const acts = codeActions(`const s = await api.page.snapshot(tab); await api.page.click(tab, 'e12'); await new Promise(r => setTimeout(r, 500))`)
    expect(primaryAction(acts)?.kind).toBe('click')
  })
})
