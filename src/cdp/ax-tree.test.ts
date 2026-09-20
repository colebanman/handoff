import { describe, expect, it } from 'vitest'
import { buildSnapshot, SnapshotReferences, type SendFn } from './ax-tree'
import { parseBrowserSnapshot } from '../shared/browser-snapshot'

function source(nodes: object[]): SendFn {
  return (async (method: string) => method === 'Accessibility.getFullAXTree' ? { nodes } : {}) as SendFn
}
const node = (id: number, name: string, extra = {}) => ({ nodeId: String(id), backendDOMNodeId: id, role: { value: 'button' }, name: { value: name }, ...extra })
const root = (children: number[], id = 1) => node(id, 'Page', { role: { value: 'RootWebArea' }, childIds: children.map(String) })
const header = { tabId: 7, url: 'https://example.test', title: 'Page' }

describe('stable live browser refs', () => {
  it('preserves refs across inserts/reordering/state edits and expires removed refs', async () => {
    const refs = new SnapshotReferences()
    const a = await buildSnapshot(source([root([2, 3]), node(2, 'Continue'), node(3, 'Continue')]), header, refs)
    const ref2 = [...a.refMap].find(([, backend]) => backend === 2)![0]
    const b = await buildSnapshot(source([root([4, 3, 2]), node(4, 'New'), node(2, 'Submit'), node(3, 'Continue')]), header, refs)
    expect(b.refMap.get(ref2)).toBe(2)
    expect(b.refDescriptions.get(ref2)?.name).toBe('Submit')
    expect(new Set(b.refMap.keys()).size).toBe(3)
    const c = await buildSnapshot(source([root([3]), node(3, 'Continue')]), header, refs)
    expect(c.refMap.has(ref2)).toBe(false)
    const d = await buildSnapshot(source([root([2, 3]), node(2, 'New node'), node(3, 'Continue')]), header, refs)
    expect(d.refMap.has(ref2)).toBe(false)
  })

  it('changes the namespace on document replacement and new debugger sessions', async () => {
    const refs = new SnapshotReferences()
    const a = await buildSnapshot(source([root([2]), node(2, 'Go')]), header, refs)
    const b = await buildSnapshot(source([root([2], 100), node(2, 'Go')]), header, refs)
    const c = await buildSnapshot(source([root([2], 100), node(2, 'Go')]), header, new SnapshotReferences())
    expect([...b.refMap.keys()]).not.toEqual([...a.refMap.keys()])
    expect([...c.refMap.keys()]).not.toEqual([...b.refMap.keys()])
  })

  it('indexes context nodes without making them actionable and observes semantic states', async () => {
    const snapshot = await buildSnapshot(source([root([2, 3]), node(2, 'Form', { role: { value: 'form' }, childIds: ['4'] }),
      node(4, 'Email', { role: { value: 'textbox' }, value: { value: 'user@example.test' }, properties: [
        { name: 'focused', value: { value: true } }, { name: 'invalid', value: { value: 'true' } },
      ] }), node(3, 'Required', { role: { value: 'alert' } })]), header)
    const parsed = parseBrowserSnapshot(snapshot.text)!.snapshot
    expect(parsed.lines).toHaveLength(3)
    expect(snapshot.refMap.size).toBe(1)
    expect(parsed.lines[0]).toMatch(/^\[n/)
    expect(parsed.lines[1]).toContain('[focused] [invalid=true]')
  })
})
