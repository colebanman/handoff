import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import type { VirtualFileSystemService, VfsEntry } from '../shared/types'
import { RUNTIME_CONTEXT_START } from '../shared/context-blocks'
import { DEFAULT_STICKY_META, formatSticky, STICKIES_DIR, type StickyRecord, type StickyRevisionLog } from '../shared/stickies'
import { RuntimeContextDelivery } from './runtime-context'
import { stickyContext, type StickySnapshot } from './stickies-context'

const base: StickyRecord = {
  ...DEFAULT_STICKY_META, id: 'todo', path: `${STICKIES_DIR}/todo.md`, title: 'Today',
  body: '- [ ] a\n- [ ] b', revision: 1, updatedAt: 1,
}
const log = (entries: Array<Partial<StickyRevisionLog['entries'][number]> & { revision: number; body: string }>): StickyRevisionLog => ({
  revision: entries.at(-1)!.revision,
  entries: entries.map((entry) => ({ by: 'agent', at: 0, ...entry })),
})
const snap = (record: StickyRecord, entries?: StickyRevisionLog): StickySnapshot => ({ record, log: entries })

describe('stickyContext', () => {
  it('delivers an open sticky in full once, then nothing while unchanged', () => {
    const first = stickyContext([snap(base)], new Map())
    expect(first.fragments).toHaveLength(1)
    expect(first.fragments[0]).toMatch(/^<sticky id="todo" [^>]*revision="1"/)
    expect(stickyContext([snap(base)], first.delivered).fragments).toEqual([])
  })

  it('turns a user tick into a tiny diff instead of resending the note', () => {
    const known = new Map([['todo', 1 as const]])
    const ticked = { ...base, body: '- [ ] a\n- [x] b', revision: 2 }
    const history = log([{ revision: 1, body: base.body }, { revision: 2, by: 'user', body: ticked.body }])
    const result = stickyContext([snap(ticked, history)], known)
    expect(result.fragments).toEqual(['<sticky-user-edit sticky="todo" from="1" revision="2">\n-2: - [ ] b\n+2: - [x] b\n</sticky-user-edit>'])
    expect(result.delivered.get('todo')).toBe(2)
  })

  it('coalesces several user edits since the last delivery into one diff', () => {
    const known = new Map([['todo', 1 as const]])
    const final = { ...base, body: '- [x] a\n- [x] b\n- [ ] c', revision: 4 }
    const history = log([
      { revision: 1, body: base.body }, { revision: 2, by: 'user', body: '- [x] a\n- [ ] b' },
      { revision: 3, by: 'user', body: '- [x] a\n- [x] b' }, { revision: 4, by: 'user', body: final.body },
    ])
    const [fragment] = stickyContext([snap(final, history)], known).fragments
    expect(fragment).toContain('<sticky-user-edit sticky="todo" from="1" revision="4">')
    expect(fragment).toContain('+1: - [x] a')
    expect(fragment).toContain('+3: - [ ] c')
  })

  it('stays silent for edits this chat made itself, but announces other chats', () => {
    const known = new Map([['todo', 1 as const]])
    const edited = { ...base, body: '- [ ] a\n- [ ] b\n- [ ] c', revision: 2 }
    const history = log([{ revision: 1, body: base.body }, { revision: 2, by: 'agent', chatId: 'chat-1', body: edited.body }])
    const own = stickyContext([snap(edited, history)], known, 'chat-1')
    expect(own.fragments).toEqual([])
    expect(own.delivered.get('todo')).toBe(2)
    const other = stickyContext([snap(edited, history)], known, 'chat-2')
    expect(other.fragments[0]).toContain('<sticky-update sticky="todo" from="1" revision="2" by="agent">')
    const mixed = stickyContext([snap(edited, log([{ revision: 1, body: base.body }, { revision: 2, by: 'user', body: edited.body }]))], known, 'chat-1')
    expect(mixed.fragments[0]).toContain('<sticky-user-edit')
  })

  it('resends the full body when the diff base is gone or the change is large', () => {
    const known = new Map([['todo', 1 as const]])
    const rewritten = { ...base, body: Array.from({ length: 40 }, (_, i) => `- [ ] item ${i}`).join('\n'), revision: 2 }
    const big = stickyContext([snap(rewritten, log([{ revision: 1, body: base.body }, { revision: 2, by: 'user', body: rewritten.body }]))], known)
    expect(big.fragments[0]).toMatch(/^<sticky id="todo" [^>]*revision="2"/)
    const noBase = stickyContext([snap({ ...base, revision: 9 }, log([{ revision: 9, body: base.body }]))], known)
    expect(noBase.fragments[0]).toMatch(/^<sticky id="todo" [^>]*revision="9"/)
  })

  it('reports closing and deletion once, and redelivers in full when reopened', () => {
    const known = new Map([['todo', 2 as const]])
    const closed = stickyContext([snap({ ...base, open: false, revision: 2 })], known)
    expect(closed.fragments).toEqual(['<sticky id="todo" revision="2" state="closed" />'])
    expect(stickyContext([snap({ ...base, open: false, revision: 2 })], closed.delivered).fragments).toEqual([])
    expect(stickyContext([], known).fragments).toEqual(['<sticky id="todo" revision="2" state="closed" />'])
    const reopened = stickyContext([snap({ ...base, revision: 2 })], closed.delivered)
    expect(reopened.fragments[0]).toMatch(/^<sticky id="todo" /)
    // Never-delivered closed stickies are simply absent.
    expect(stickyContext([snap({ ...base, open: false })], new Map()).fragments).toEqual([])
  })
})

function stickyVfs(files: Record<string, string>) {
  let clock = 1
  const records = new Map<string, { text: string; entry: VfsEntry }>()
  const set = (path: string, text: string) => {
    const entry: VfsEntry = { path, root: 'workspace', name: path.split('/').at(-1)!, mediaType: 'text/markdown', size: text.length, createdAt: 1, updatedAt: clock++ }
    records.set(path, { text, entry })
  }
  for (const [path, text] of Object.entries(files)) set(path, text)
  const vfs = {
    summary: async () => ({ entries: [...records.values()].map((v) => v.entry), skills: [] }),
    getEntry: async (path: string) => records.get(path)?.entry,
    readText: async (path: string) => ({ path, text: records.get(path)?.text ?? '', truncated: false, totalChars: 0 }),
  } as unknown as VirtualFileSystemService
  return { vfs, set }
}

describe('RuntimeContextDelivery stickies', () => {
  const user = (content: string): ModelMessage => ({ role: 'user', content })
  const options = { isSubagent: false, currentTabId: 1, chatId: 'chat-1' }

  it('puts open stickies in the harness context and omits closed ones', async () => {
    const { vfs } = stickyVfs({
      [`${STICKIES_DIR}/todo.md`]: formatSticky({ ...DEFAULT_STICKY_META, title: 'Today' }, '- [ ] a'),
      [`${STICKIES_DIR}/later.md`]: formatSticky({ ...DEFAULT_STICKY_META, open: false }, 'not now'),
    })
    const delivery = new RuntimeContextDelivery([])
    const message = await delivery.next(vfs, [user('hi')], [], options)
    const text = message?.content as string
    expect(text.startsWith(RUNTIME_CONTEXT_START)).toBe(true)
    expect(text).toContain('<stickies>\n<sticky id="todo" path="/workspace/stickies/todo.md" revision="1" title="Today" pages="all" position="top-right">\n- [ ] a\n</sticky>\n</stickies>')
    const section = /<stickies>[\s\S]*<\/stickies>/.exec(text)![0]
    expect(section).not.toContain('not now')
    expect(section).not.toContain('later')
    // Stable state: no stickies section on the next step.
    const again = await delivery.next(vfs, [user('hi'), message!, user('more')], [], options)
    expect((again?.content as string | undefined) ?? '').not.toContain('<stickies>')
  })

  it('is skipped for subagents and restores delivered revisions from history', async () => {
    const { vfs } = stickyVfs({ [`${STICKIES_DIR}/todo.md`]: formatSticky(DEFAULT_STICKY_META, '- [ ] a') })
    const sub = await new RuntimeContextDelivery([]).next(vfs, [user('task')], [], { isSubagent: true, currentTabId: 1, allowedTabIds: [1] })
    expect((sub?.content as string | undefined) ?? '').not.toContain('<stickies>')
    const history = [user('hi'), user(`${RUNTIME_CONTEXT_START}<stickies>\n<sticky id="todo" path="/workspace/stickies/todo.md" revision="1" title="todo" pages="all" position="top-right">\n- [ ] a\n</sticky>\n</stickies>\n</context>`)]
    const resumed = await new RuntimeContextDelivery(history).next(vfs, history, [], options)
    expect((resumed?.content as string | undefined) ?? '').not.toContain('<stickies>')
  })
})
