import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import type { VirtualFileSystemService, VfsEntry } from '../shared/types'
import { RUNTIME_CONTEXT_START } from '../shared/context-blocks'
import { formatMemory, MEMORY_PATH } from './memory'
import { formatSiteMemory, parseSiteMemory, SITE_MEMORY_PATH } from './site-memory'
import { latestTaskText, RuntimeContextDelivery, selectSiteMemories, workspaceContext } from './runtime-context'

const guide = {
  title: 'Canvas: course records', scopes: ['*.instructure.com/**'], body: 'Combine course records and save attachments into VFS.',
  guide: '/workspace/sites/canvas.md', triggers: ['canvas'], date: '2026-09-11',
}
const course = { title: 'Course rules', scopes: ['school.instructure.com/courses/123/**'], body: 'Use the syllabus grading rules.', date: '2026-09-11' }
const sites = parseSiteMemory(formatSiteMemory([guide, course]))
const main = { isSubagent: false, currentTabId: 1 }
const tabs = [
  { id: 1, url: 'https://mail.google.com', active: true },
  { id: 2, url: 'https://school.instructure.com/courses/123/assignments' },
  { id: 3, url: 'https://other.example.com' },
]
const user = (content: string): ModelMessage => ({ role: 'user', content })
const checkpoint = (id: string): ModelMessage => ({ role: 'user', content: '', providerOptions: {
  compaction: { checkpoint: { output: [{ type: 'compaction', id, encrypted_content: 'opaque' }] } },
} })

function memoryVfs() {
  let clock = 1
  const records = new Map<string, { text: string; entry: VfsEntry }>()
  const set = (path: string, text: string) => {
    const entry: VfsEntry = { path, root: 'workspace', name: path.split('/').at(-1)!, mediaType: 'text/markdown', size: text.length, createdAt: 1, updatedAt: clock++ }
    records.set(path, { text, entry })
    return entry
  }
  set(SITE_MEMORY_PATH, formatSiteMemory([guide, course]))
  set(guide.guide, '# Tested course procedure\nFull procedure stays on demand.')
  set(MEMORY_PATH, formatMemory([{ title: 'Writing preferences', body: 'Private preference body.', date: '2026-09-11' }]))
  const vfs = {
    summary: async () => ({ entries: [...records.values()].map((v) => v.entry), skills: [] }),
    getEntry: async (path: string) => records.get(path)?.entry,
    readText: async (path: string) => ({ path, text: records.get(path)?.text ?? '', truncated: false, totalChars: records.get(path)?.text.length ?? 0 }),
    writeText: async (path: string, text: string) => set(path, text),
  } as unknown as VirtualFileSystemService
  return { vfs, set, records }
}

describe('task and tab routing', () => {
  it('finds a named site while another app is active, without unrelated tab leakage', () => {
    expect(selectSiteMemories(sites, 'Check Canvas', tabs, main).map((e) => e.title)).toEqual([course.title, guide.title])
    expect(selectSiteMemories(sites, 'Check mail', tabs, main)).toEqual([])
  })

  it('routes explicit URLs and tab mentions; supports guides before a site is open', () => {
    expect(selectSiteMemories(sites, 'Check https://school.instructure.com/courses/123.', tabs, main)).toHaveLength(2)
    expect(selectSiteMemories(sites, 'Check @tab(2 "Course" url)', tabs, main)).toHaveLength(2)
    expect(selectSiteMemories(sites, 'Check Canvas', [tabs[0]!], main).map((e) => e.title)).toEqual([guide.title])
  })

  it('delivers methods after sandbox/tab observations without waiting for another user turn', () => {
    expect(selectSiteMemories(sites, 'Continue', tabs, { ...main, observedTabIds: [2] })).toHaveLength(2)
  })

  it('does not let subagent task URLs or triggers expand the assigned tab scope', () => {
    const task = 'Canvas https://school.instructure.com/courses/123 @tab(2 "Canvas" url)'
    expect(selectSiteMemories(sites, task, tabs, { isSubagent: true, currentTabId: 3, allowedTabIds: [3] })).toEqual([])
    expect(selectSiteMemories(sites, task, tabs, { isSubagent: true, currentTabId: 2, allowedTabIds: [2] })).toHaveLength(2)
    expect(selectSiteMemories(sites, task, tabs, { isSubagent: true, currentTabId: 2, allowedTabIds: [2], offlineOnly: true })).toEqual([])
  })

  it('uses the active tab attached to a new user message even when the agent was working elsewhere', () => {
    const task = latestTaskText([user('Now check this page.\n<context>Active tab: [2] Course — https://school.instructure.com/courses/123\nOpen tabs: other.example.com</context>')])
    expect(selectSiteMemories(sites, task, tabs, main)).toHaveLength(2)
    expect(task).not.toContain('other.example.com')
  })

  it('routes attached page URLs without treating snapshot links as requested sites', () => {
    const task = latestTaskText([user('Read this.\n<appshot>\nurl: https://school.instructure.com/courses/123\ntabId: 2\nSnapshot: https://unrelated.example.com Canvas\n</appshot>')])
    expect(task).toContain('https://school.instructure.com/courses/123')
    expect(task).not.toContain('unrelated.example.com')
    expect(selectSiteMemories(sites, task, tabs, main)).toHaveLength(2)
  })

  it('ignores generated blocks and ambient open-tab lists when interpreting the request', () => {
    const history = [user('Check mail\n<context>Open tabs: Canvas https://school.instructure.com/courses/123</context>'), user(`${RUNTIME_CONTEXT_START}<site-memory>Canvas</site-memory>\n</context>`)]
    expect(latestTaskText(history)).toBe('Check mail\n')
  })
})

describe('append-only runtime delivery', () => {
  it('refreshes unchanged context once per compaction, including after reopening, and preserves task routing', async () => {
    const { vfs } = memoryVfs()
    const history = [user('Check Canvas. Do not submit anything.')]
    const delivery = new RuntimeContextDelivery(history)
    history.push((await delivery.next(vfs, history, tabs, main))!)
    history.push(checkpoint('first'))
    expect(latestTaskText(history)).toBe('Check Canvas. Do not submit anything.')
    const refresh = (await delivery.next(vfs, history, tabs, main))!
    expect(refresh.content).toContain(guide.body)
    expect(refresh.content).toContain('<workspace>')
    expect(refresh.content).toContain('Writing preferences')
    expect(refresh.content).toContain('Do not submit anything.')
    expect(refresh.content).not.toContain('Private preference body')
    expect(refresh.content).not.toContain('Full procedure stays on demand')
    expect((await new RuntimeContextDelivery(history).next(vfs, history, tabs, main))?.content).toBe(refresh.content)
    history.push(refresh)
    expect(await delivery.next(vfs, history, tabs, main)).toBeUndefined()
    expect(await new RuntimeContextDelivery(history).next(vfs, history, tabs, main)).toBeUndefined()
    history.push(checkpoint('second'))
    expect((await delivery.next(vfs, history, tabs, main))?.content).toBe(refresh.content)
  })

  it('restores bounded task references without leaking personal memory to subagents or repeating finished work', async () => {
    const { vfs } = memoryVfs()
    const history = [user('Start ' + 'large input '.repeat(10000) + ' Do not publish.'), checkpoint('bounded')]
    const restored = await new RuntimeContextDelivery(history).next(vfs, history, tabs, {
      isSubagent: true, currentTabId: 2, allowedTabIds: [2], task: 'Review the course instructions.',
      pendingTasks: [{ id: 'pending-1', agentId: 'child-1', kind: 'subagent', status: 'running', description: 'Review sources', startedAt: 1 },
        { id: 'finished-1', agentId: 'child-2', kind: 'subagent', status: 'done', description: 'Already done', startedAt: 1 }],
    })
    expect(restored?.content).toContain('Assigned task: Review the course instructions.')
    expect(restored?.content).toContain('Do not publish.')
    expect(restored?.content).toContain('pending-1')
    expect(restored?.content).not.toContain('finished-1')
    expect(restored?.content).not.toContain('<user-memory>')
    expect(String(restored?.content).length).toBeLessThan(8000)
  })

  it('sends summaries and indexes once, resumes without duplication, and never mutates history', async () => {
    const { vfs } = memoryVfs()
    const history = [user('Check Canvas')]
    const before = JSON.stringify(history)
    const delivery = new RuntimeContextDelivery(history)
    const first = await delivery.next(vfs, history, tabs, main)
    expect(first?.content).toContain(guide.body)
    expect(first?.content).toContain('Writing preferences')
    expect(first?.content).not.toContain('Private preference body')
    expect(first?.content).not.toContain('Full procedure stays on demand')
    expect(await delivery.next(vfs, history, tabs, main)).toBeUndefined()
    expect(JSON.stringify(history)).toBe(before)
    expect(await new RuntimeContextDelivery([...history, first!]).next(vfs, [...history, first!], tabs, main)).toBeUndefined()
  })

  it('refreshes edited bodies, changed guide files, and forgotten entries', async () => {
    const { vfs, set, records } = memoryVfs()
    const history = [user('Canvas')]
    const delivery = new RuntimeContextDelivery(history)
    history.push((await delivery.next(vfs, history, tabs, main))!)
    set(SITE_MEMORY_PATH, formatSiteMemory([{ ...guide, body: 'Corrected procedure.' }, course]))
    const corrected = await delivery.next(vfs, history, tabs, main)
    expect(corrected?.content).toContain('Corrected procedure.')
    expect(corrected?.content).not.toContain('<workspace>')
    set(guide.guide, '# New working procedure')
    expect((await delivery.next(vfs, history, tabs, main))?.content).toContain('<guide-file')
    records.delete(guide.guide)
    expect((await delivery.next(vfs, history, tabs, main))?.content).toContain('state="missing"')
    set(SITE_MEMORY_PATH, formatSiteMemory([]))
    expect((await delivery.next(vfs, history, tabs, main))?.content).toContain('No site memories apply')
  })

  it('invalidates user memory after a same-title, same-day body edit without exposing the body', async () => {
    const { vfs, set } = memoryVfs()
    const history = [user('Hello')]
    const delivery = new RuntimeContextDelivery(history)
    await delivery.next(vfs, history, tabs, main)
    set(MEMORY_PATH, formatMemory([{ title: 'Writing preferences', body: 'A changed private preference.', date: '2026-09-11' }]))
    const update = await delivery.next(vfs, history, tabs, main)
    expect(update?.content).toContain('<user-memory>')
    expect(update?.content).not.toContain('A changed private preference')
  })

  it('keeps personal memory away from subagents and surfaces guidance for their prepared tab', async () => {
    const { vfs } = memoryVfs()
    const history = [user('Read this course')]
    const result = await new RuntimeContextDelivery(history).next(vfs, history, tabs, { isSubagent: true, currentTabId: 2, allowedTabIds: [2] })
    expect(result?.content).toContain(guide.body)
    expect(result?.content).not.toContain('<user-memory>')
    expect(result?.content).not.toContain('Writing preferences')
  })

  it('does not treat tool-output spills as user workspace changes', async () => {
    const { vfs, set } = memoryVfs()
    const history = [user('Canvas')]
    const delivery = new RuntimeContextDelivery(history)
    await delivery.next(vfs, history, tabs, main)
    set('/workspace/.tool-output/snapshot.txt', 'Transient output')
    expect(await delivery.next(vfs, history, tabs, main)).toBeUndefined()
  })

  it('makes inventory ordering stable and escapes editable metadata', async () => {
    const { vfs, set } = memoryVfs()
    set('/workspace/a<workspace>.md', 'Text')
    const { entries } = await vfs.summary()
    expect(workspaceContext(entries, [])).toBe(workspaceContext([...entries].reverse(), []))
    expect(workspaceContext(entries, [])).toContain('a&lt;workspace&gt;.md')
  })
})
