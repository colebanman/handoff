import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHost } from './memory-host'
import { MemoryDatabase } from '../storage/continuity'
import { DEFAULT_SETTINGS, type VirtualFileSystemService } from '../shared/types'
import { memoryContentSchema, type MemoryEvent } from '../shared/continuity'
import { memoryRuntime } from '../agent/continuity-context'
import type { observeMemory } from '../agent/memory-observer'

let clock = Date.parse('2026-10-06T12:00:00Z')
const hosts: ReturnType<typeof createMemoryHost>[] = []
function setup(infer: typeof observeMemory = async () => ({ patch: { upserts: [], forget: [] }, tokens: 100 })) {
  const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>()
  const stored: Record<string, unknown> = {}
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('chrome', {
    alarms: { create: vi.fn(async () => {}), onAlarm: { addListener: vi.fn(), removeListener: vi.fn() } },
    storage: { onChanged: { addListener: (fn: typeof listeners extends Set<infer T> ? T : never) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn) },
      local: { set: async (values: Record<string, unknown>) => {
        const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: stored[key], newValue: value }]))
        Object.assign(stored, values)
        for (const listener of listeners) listener(changes, 'local')
      } },
    },
  })
  const db = new MemoryDatabase(`host-test-${crypto.randomUUID()}`)
  let busy = false
  const host = createMemoryHost({ database: db, now: () => clock, infer, busy: () => busy,
    settings: async () => ({ ...DEFAULT_SETTINGS, provider: 'openai', openaiAuthMode: 'api-key', apiKey: 'test' }),
    chats: async () => [], chat: async () => undefined,
    vfs: { getEntry: async () => undefined } as unknown as VirtualFileSystemService,
  })
  hosts.push(host)
  const command = (payload: unknown) => host.handleRuntimeMessage({ target: 'background', type: 'memory.command', payload })!
  return { host, db, command, setBusy: (value: boolean) => { busy = value; host.activity() }, listeners }
}
const event = (text = 'Assigned to group 5.'): MemoryEvent => ({ id: 'source', parentId: 'chat:user', chatId: 'chat', itemId: 'user', origin: 'human', at: clock, label: 'Project Y', excerpt: text, text, pending: 1 })
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); vi.unstubAllGlobals() })

describe('background memory lifecycle', () => {
  it('serves prepared context synchronously and makes no inference call on inspection or foreground work', async () => {
    const infer = vi.fn<typeof observeMemory>(async () => ({ patch: { upserts: [], forget: [] }, tokens: 0 }))
    const { host, command, setBusy } = setup(infer)
    await host.ready
    expect(memoryRuntime()?.snapshot()).toBeDefined()
    await command({ command: 'list' })
    setBusy(true); await host.run()
    expect(infer).not.toHaveBeenCalled()
  })
  it('acknowledges an empty learning patch and does not invent memories', async () => {
    const infer = vi.fn<typeof observeMemory>(async () => ({ patch: { upserts: [], forget: [] }, tokens: 50 }))
    const { host, db } = setup(infer)
    await host.ready; await db.capture([event('Received an unimportant newsletter.')]); await host.run()
    expect(infer).toHaveBeenCalledTimes(1)
    expect(await db.snapshot()).toMatchObject({ records: [], pending: 0, state: { usedTokens: 50 } })
  })
  it('learns a dated project fact and keeps its source available for the inspector', async () => {
    const infer: typeof observeMemory = async (_settings, _state, input) => {
      const source = JSON.parse(input).events[0]
      return { tokens: 100, patch: { upserts: [{ ...memoryContentSchema.parse({ subject: 'project.y.group', title: 'Project Y group', body: 'Assigned to group 5.', kind: 'project', useWhen: 'When working on Project Y.', triggers: ['Project Y'], validUntil: '2026-10-20' }), evidenceIds: [source.id], quotes: { [source.id]: 'Assigned to group 5.' }, replaces: [] }], forget: [] } }
    }
    const { host, db } = setup(infer)
    await host.ready; await db.capture([event()]); await host.run()
    const record = (await db.snapshot()).records[0]!
    expect(record).toMatchObject({ body: 'Assigned to group 5.', validUntil: '2026-10-20' })
    expect(record.sources[0]?.excerpt).toBe('Assigned to group 5.')
    expect(memoryRuntime()?.snapshot()?.records[0]?.id).toBe(record.id)
  })
  it('keeps failed work pending, reports the error, and respects retry backoff', async () => {
    const infer = vi.fn<typeof observeMemory>(async () => { throw new Error('Selected model is unavailable') })
    const { host, db } = setup(infer)
    await host.ready; await db.capture([event()]); await host.run(); await host.run()
    expect(infer).toHaveBeenCalledTimes(1)
    expect(await db.snapshot()).toMatchObject({ pending: 1, state: { error: 'Selected model is unavailable' } })
  })
  it('aborts background inference when a foreground task starts, without losing pending evidence', async () => {
    const infer = vi.fn<typeof observeMemory>(async (_s, _m, _input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    const { host, db, setBusy } = setup(infer)
    await host.ready; await db.capture([event()])
    const job = host.run()
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(1))
    setBusy(true); await job
    expect((await db.snapshot()).pending).toBe(1)
    expect((await db.snapshot()).state.running).toBeUndefined()
  })
  it('does not learn conversations created during a learning pause after it resumes', async () => {
    const { host, command, db } = setup()
    await host.ready
    const config = (await db.snapshot()).state.config
    await command({ command: 'configure', config: { ...config, learning: false } })
    const excluded = { ...event(), at: clock + 500 }
    clock += 1_000
    await command({ command: 'configure', config: { ...config, learning: true } })
    expect(await db.capture([excluded])).toBe(0)
  })
})
