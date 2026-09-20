import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATIONS_STORAGE_KEY, type AutomationRecord } from '../shared/automations'
import { DEFAULT_SETTINGS, type ChatRecord } from '../shared/types'
import type { ExecutionSnapshot, SerializableRunOptions } from '../shared/execution-protocol'

let local: Record<string, unknown>
let alarms: Map<string, { when: number }>
let onAlarm: ((alarm: { name: string; scheduledTime: number }) => void) | undefined
let startTurn: ReturnType<typeof vi.fn<(options: SerializableRunOptions) => Promise<{ runId: string }>>>
let finishListener: ((snapshot: ExecutionSnapshot) => void) | undefined
let running: Set<string>

const LA = 'America/Los_Angeles'

function stored(): AutomationRecord[] {
  return (local[AUTOMATIONS_STORAGE_KEY] as AutomationRecord[] | undefined) ?? []
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-11T14:00:00.000Z')) // Fri 07:00 PDT
  local = { settings: { ...DEFAULT_SETTINGS } }
  alarms = new Map()
  running = new Set()
  onAlarm = undefined
  finishListener = undefined
  startTurn = vi.fn(async () => ({ runId: `run-${startTurn.mock.calls.length}` }))
  vi.stubGlobal('chrome', {
    runtime: { getURL: (p: string) => `chrome-extension://ext/${p}` },
    alarms: {
      onAlarm: { addListener: (fn: typeof onAlarm) => { onAlarm = fn } },
      create: vi.fn(async (name: string, info: { when: number }) => { alarms.set(name, info) }),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
      get: vi.fn(async (name: string) => {
        const alarm = alarms.get(name)
        return alarm ? { name, scheduledTime: alarm.when } : undefined
      }),
    },
    notifications: { create: vi.fn(async () => 'n') },
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[] | null) => {
          if (keys === null) return structuredClone(local)
          const list = Array.isArray(keys) ? keys : [keys]
          return structuredClone(Object.fromEntries(list.filter((key) => key in local).map((key) => [key, local[key]])))
        }),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(local, structuredClone(values)) }),
        remove: vi.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete local[key] }),
      },
    },
  })
})

async function host() {
  const { createAutomationHost } = await import('./automation-host')
  return createAutomationHost({
    startTurn,
    isChatRunning: (chatId) => running.has(chatId),
    onExecutionFinished: (listener) => {
      finishListener = listener
      return () => undefined
    },
  })
}

const chat: ChatRecord = {
  id: 'chat-1',
  title: 'Canvas',
  createdAt: 1,
  updatedAt: 1,
  modelId: DEFAULT_SETTINGS.modelId,
  messages: [{ role: 'user', content: 'earlier' }],
  transcript: [{ kind: 'user', id: 'u0', text: 'earlier', at: 1 }],
  checkpoints: [],
}

describe('automation host', () => {
  it('creates a record with the next run in its zone and arms an alarm for it', async () => {
    const automations = await host()
    const record = await automations.create(
      { prompt: 'Update the week artifact from Canvas.', schedule: { weekdays: '08:00' }, timeZone: LA },
      { chatId: 'chat-1' },
    )
    expect(record.title).toBe('Update the week artifact from Canvas.')
    expect(record.chat).toEqual({ mode: 'existing', chatId: 'chat-1' })
    expect(new Date(record.nextRunAt!).toISOString()).toBe('2026-09-11T15:00:00.000Z')
    expect(alarms.get(`automation:${record.id}`)).toEqual({ when: record.nextRunAt })
    expect(stored()).toHaveLength(1)
  })

  it('runs in the existing chat with a badged user message, then records the outcome and reschedules', async () => {
    local['chat:chat-1'] = chat
    local['chat-ids'] = ['chat-1']
    const automations = await host()
    const record = await automations.create({ prompt: 'Refresh.', schedule: { daily: '08:00' }, timeZone: LA }, { chatId: 'chat-1' })

    vi.setSystemTime(new Date('2026-09-11T15:00:01.000Z'))
    onAlarm!({ name: `automation:${record.id}`, scheduledTime: record.nextRunAt! })
    await vi.advanceTimersByTimeAsync(10)

    expect(startTurn).toHaveBeenCalledTimes(1)
    const options = startTurn.mock.calls[0]![0]
    expect(options.chatId).toBe('chat-1')
    expect(options.messages).toHaveLength(2)
    expect(String((options.messages[1] as { content: string }).content)).toContain('<context source="automation">')
    expect(String((options.messages[1] as { content: string }).content)).toContain('This is a scheduled run.')
    const userItem = options.record.transcript.at(-1)
    expect(userItem).toMatchObject({ kind: 'user', text: 'Refresh.', source: { kind: 'automation', id: record.id, title: 'Refresh.' } })
    expect(options.capabilities).toEqual({ askUser: false, autoContinueSteps: 3 })

    let after = stored()[0]!
    expect(after.runningRunId).toBe('run-1')
    expect(after.runCount).toBe(1)
    expect(after.lastStatus).toBe('running')
    expect(new Date(after.nextRunAt!).toISOString()).toBe('2026-09-12T15:00:00.000Z')
    // The chat is already in history with the scheduled prompt appended.
    expect((local['chat:chat-1'] as ChatRecord).transcript).toHaveLength(2)

    finishListener!({
      runId: 'run-1',
      ownerId: 'host',
      chatId: 'chat-1',
      status: 'done',
      record: { ...options.record, transcript: [...options.record.transcript, { kind: 'text', id: 't1', agentId: 'main', text: 'Nothing new today.', streaming: false }] },
      startedAt: 1,
      updatedAt: 2,
      eventSeq: 3,
    })
    await vi.advanceTimersByTimeAsync(10)
    after = stored()[0]!
    expect(after.runningRunId).toBeUndefined()
    expect(after.lastStatus).toBe('done')
    expect((local['chat:chat-1'] as ChatRecord).transcript).toHaveLength(3)
    expect((globalThis as any).chrome.notifications.create).toHaveBeenCalled()
  })

  it('opens a fresh chat per run when asked, and waits when the target chat is busy', async () => {
    const automations = await host()
    const record = await automations.create({ prompt: 'Digest.', schedule: { every: '2h' }, chat: 'new' }, { chatId: 'chat-1' })
    expect(record.chat).toEqual({ mode: 'new' })

    const result = await automations.runNow(record.id)
    expect('runId' in result).toBe(true)
    const options = startTurn.mock.calls[0]![0]
    expect(options.chatId).not.toBe('chat-1')
    expect(options.record.origin).toMatchObject({ kind: 'automation', label: 'Digest.' })
    expect(options.record.title).toBe('Digest.')

    // A busy existing chat is retried later instead of double-running.
    local['chat:chat-1'] = chat
    running.add('chat-1')
    const second = await automations.create({ prompt: 'Check.', schedule: { daily: '20:00' }, timeZone: LA }, { chatId: 'chat-1' })
    const firedAt = Date.now()
    onAlarm!({ name: `automation:${second.id}`, scheduledTime: firedAt })
    await vi.advanceTimersByTimeAsync(10)
    expect(startTurn).toHaveBeenCalledTimes(1)
    const retry = alarms.get(`automation:${second.id}`)!.when
    expect(retry).toBeGreaterThanOrEqual(firedAt + 2 * 60 * 1000)
    expect(retry).toBeLessThanOrEqual(firedAt + 2 * 60 * 1000 + 20)
  })

  it('reconcile runs missed automations once as catch-up and clears stale run markers', async () => {
    local['chat:chat-1'] = chat
    const stale: AutomationRecord = {
      id: 'auto-old',
      title: 'Morning brief',
      prompt: 'Brief me.',
      schedule: { kind: 'daily', at: '06:00' },
      timeZone: LA,
      chat: { mode: 'existing', chatId: 'chat-1' },
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      nextRunAt: Date.now() - 3 * 3_600_000,
      runCount: 4,
      runningRunId: 'run-lost',
    }
    local[AUTOMATIONS_STORAGE_KEY] = [stale]
    const automations = await host()
    await automations.reconcile()
    expect(stored()[0]!.runningRunId).toBeUndefined()
    expect(stored()[0]!.lastError).toMatch(/interrupted/)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(String((startTurn.mock.calls[0]![0].messages[1] as { content: string }).content)).toContain('catch-up')
    // Rescheduled for tomorrow 06:00 PDT, not re-run for each missed day.
    expect(new Date(stored()[0]!.nextRunAt!).toISOString()).toBe('2026-09-12T13:00:00.000Z')
  })

  it('update re-parses the schedule and chat target; delete clears the alarm; once schedules retire after firing', async () => {
    const automations = await host()
    const record = await automations.create({ prompt: 'Ping.', schedule: { daily: '09:00' }, timeZone: LA }, { chatId: 'chat-1' })
    const updated = await automations.update(record.id, { schedule: { weekdays: '07:30' }, chat: 'new' }, { chatId: 'chat-1' })
    expect(updated.schedule).toEqual({ kind: 'weekly', days: [1, 2, 3, 4, 5], at: '07:30' })
    expect(updated.chat).toEqual({ mode: 'new' })
    expect(new Date(updated.nextRunAt!).toISOString()).toBe('2026-09-11T14:30:00.000Z')

    const paused = await automations.update(record.id, { enabled: false }, {})
    expect(paused.nextRunAt).toBeUndefined()
    expect(alarms.has(`automation:${record.id}`)).toBe(false)

    expect(await automations.remove(record.id)).toBe(true)
    expect(stored()).toHaveLength(0)

    const once = await automations.create({ prompt: 'Once.', schedule: { once: '2026-09-11T08:00' }, timeZone: LA }, { chatId: 'chat-1' })
    vi.setSystemTime(new Date('2026-09-11T15:00:00.500Z'))
    onAlarm!({ name: `automation:${once.id}`, scheduledTime: once.nextRunAt! })
    await vi.advanceTimersByTimeAsync(10)
    const spent = stored().find((entry) => entry.id === once.id)!
    expect(spent.enabled).toBe(false)
    expect(spent.nextRunAt).toBeUndefined()
  })
})
