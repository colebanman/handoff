import { expect, it } from 'vitest'
import type { Root } from 'hast'
import rehypeTableLabels from './markdown-tables'

it('adds each markdown heading to its matching data cell', () => {
  const tree: Root = { type: 'root', children: [{ type: 'element', tagName: 'table', properties: {}, children: [
    { type: 'element', tagName: 'thead', properties: {}, children: [{ type: 'element', tagName: 'tr', properties: {}, children: [
      { type: 'element', tagName: 'th', properties: {}, children: [{ type: 'text', value: 'Rank' }] },
      { type: 'element', tagName: 'th', properties: {}, children: [{ type: 'text', value: 'Why it fits' }] },
    ] }] },
    { type: 'element', tagName: 'tbody', properties: {}, children: [{ type: 'element', tagName: 'tr', properties: {}, children: [
      { type: 'element', tagName: 'td', properties: {}, children: [{ type: 'text', value: '1' }] },
      { type: 'element', tagName: 'td', properties: {}, children: [{ type: 'text', value: 'Relevant experience' }] },
    ] }] },
  ] }] }
  rehypeTableLabels()(tree)
  const table = tree.children[0]!
  if (table.type !== 'element') throw new Error('missing table')
  const body = table.children[1]!
  if (body.type !== 'element') throw new Error('missing body')
  const row = body.children[0]!
  if (row.type !== 'element') throw new Error('missing row')
  expect(row.children.filter((cell) => cell.type === 'element').map((cell) => cell.properties['data-label']))
    .toEqual(['Rank', 'Why it fits'])
})
