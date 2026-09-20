/**
 * Automations scheduler (service worker). One `chrome.alarms` alarm per
 * enabled automation, re-armed after every run from the schedule's next
 * occurrence in its own time zone. When an alarm fires, this host builds the
 * turn itself — loads the chat, appends the scheduled prompt as a user
 * message badged with its source, and starts it through the execution host —
 * so runs happen with the side panel closed. The chat is saved to history
 * right away (it surfaces at the top) and again with the model's reply.
 *
 * Missed occurrences run once, as catch-up, on the next service-worker start.
 * A run never piles onto a chat with a live turn: it waits a couple of minutes
 * and tries again.
 */

import type { ChatRecord, ChatCheckpoint, TranscriptItem } from '../shared/types'
import { pinnedSettingsForModel } from '../shared/types'
import type { ExecutionSnapshot, SerializableRunOptions } from '../shared/execution-protocol'
import {
  AUTOMATION_ALARM_PREFIX,
  AUTOMATION_AUTO_CONTINUE_STEPS,
  AUTOMATION_MAX_COUNT,
  automationRunMessage,
  defaultTimeZone,
  deriveAutomationTitle,
  isValidTimeZone,
  nextRunAt,
  parseChatTarget,
  parseScheduleInput,
  type AutomationInput,
  type AutomationPatch,
  type AutomationRecord,
  type AutomationRuntimeMessage,
  type AutomationService,
} from '../shared/automations'
import { loadAutomations, mutateAutomations } from '../storage/automations'
import { loadSettings } from '../storage/settings'
import { getChat, newChat, saveChat } from '../storage/chats'
import { formatError } from '../shared/errors'
import { uid } from '../shared/ids'

/** Fired this long after the scheduled instant counts as catch-up (browser was closed). */
const LATE_RUN_MS = 90_000
const BUSY_RETRY_MS = 2 * 60 * 1000
const CATCH_UP_STAGGER_MS = 4_000

export interface AutomationHostDeps {
  startTurn(options: SerializableRunOptions): Promise<{ runId: string }>
  isChatRunning(chatId: string): boolean
  onExecutionFinished(listener: (snapshot: ExecutionSnapshot) => void): () => void
}

export interface AutomationHost extends AutomationService {
  /** Re-arm alarms, clear stale run markers, run whatever was missed. */
  reconcile(): Promise<void>
  handleRuntimeMessage(message: Partial<AutomationRuntimeMessage>): Promise<unknown> | undefined
}

export function createAutomationHost(deps: AutomationHostDeps): AutomationHost {
  const starting = new Set<string>()

  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith(AUTOMATION_ALARM_PREFIX)) return
    const id = alarm.name.slice(AUTOMATION_ALARM_PREFIX.length)
    const late = Date.now() - alarm.scheduledTime > LATE_RUN_MS
    void runAutomation(id, late ? 'catch-up' : 'scheduled').catch((err) => {
      console.error('[handoff] automation run failed', err)
    })
  })

  deps.onExecutionFinished((snapshot) => void recordOutcome(snapshot))

  /* ---------------- alarms ---------------- */

  function alarmName(id: string): string {
    return `${AUTOMATION_ALARM_PREFIX}${id}`
  }

  async function armAlarm(record: AutomationRecord): Promise<void> {
    const name = alarmName(record.id)
    if (!record.enabled || record.nextRunAt === undefined) {
      await chrome.alarms.clear(name).catch(() => {})
      return
    }
    await chrome.alarms.create(name, { when: Math.max(record.nextRunAt, Date.now() + 1_000) })
  }

  async function armRetry(record: AutomationRecord): Promise<void> {
    await chrome.alarms.create(alarmName(record.id), { when: Date.now() + BUSY_RETRY_MS })
  }

  function withNextRun(record: AutomationRecord, from: number): AutomationRecord {
    const next = record.enabled ? nextRunAt(record.schedule, record.timeZone, from, record.lastRunAt) : undefined
    const spent = record.schedule.kind === 'once' && next === undefined && record.runCount > 0
    return { ...record, nextRunAt: next, enabled: spent ? false : record.enabled }
  }

  /* ---------------- running ---------------- */

  async function runAutomation(id: string, reason: 'scheduled' | 'catch-up' | 'manual'): Promise<{ runId: string; chatId: string } | { skipped: string }> {
    if (starting.has(id)) return { skipped: 'already starting' }
    starting.add(id)
    try {
      const record = (await loadAutomations()).find((entry) => entry.id === id)
      if (!record) return { skipped: 'automation no longer exists' }
      if (!record.enabled && reason !== 'manual') return { skipped: 'disabled' }
      if (record.runningRunId) return { skipped: 'a run is already in progress' }

      const settings = await loadSettings()
      const now = Date.now()
      let chat: ChatRecord | undefined
      if (record.chat.mode === 'existing' && record.chat.chatId) chat = await getChat(record.chat.chatId)
      if (!chat) {
        chat = {
          ...newChat(settings.modelId),
          title: record.title,
          origin: { kind: 'automation', client: 'automation', label: record.title, at: now },
        }
      }
      if (deps.isChatRunning(chat.id)) {
        if (reason === 'manual') return { skipped: `chat ${chat.id} is busy — try again when its turn finishes` }
        await armRetry(record)
        return { skipped: 'chat busy; retrying in 2 minutes' }
      }

      const userItem: Extract<TranscriptItem, { kind: 'user' }> = {
        kind: 'user',
        id: uid('u'),
        text: record.prompt,
        at: now,
        source: { kind: 'automation', id: record.id, title: record.title },
      }
      const checkpoint: ChatCheckpoint = {
        id: uid('cp'),
        userItemId: userItem.id,
        userText: record.prompt,
        at: now,
        transcriptIndexBefore: chat.transcript.length,
        messageCountBefore: chat.messages.length,
      }
      const messages = [...chat.messages, { role: 'user', content: automationRunMessage(record, now, reason) }]
      const chatSettings = chat.modelId && chat.modelId !== settings.modelId ? pinnedSettingsForModel(chat.modelId, settings, { pinEndpoint: true }) : settings
      const lifecycleRecord: ChatRecord = {
        ...chat,
        modelId: chatSettings.modelId,
        transcript: [...chat.transcript, userItem],
        checkpoints: [...(chat.checkpoints ?? []), checkpoint],
        updatedAt: now,
      }
      // Visible in history immediately, even if no panel ever opens for this run.
      await saveChat(lifecycleRecord, `⏰ ${record.title}`)

      const { runId } = await deps.startTurn({
        chatId: chat.id,
        messages,
        settings: chatSettings,
        record: lifecycleRecord,
        capabilities: { askUser: false, autoContinueSteps: AUTOMATION_AUTO_CONTINUE_STEPS },
      })

      const updated = await mutateAutomations((list) =>
        list.map((entry) =>
          entry.id === id
            ? withNextRun(
                {
                  ...entry,
                  runningRunId: runId,
                  lastRunAt: now,
                  lastStatus: 'running',
                  lastError: undefined,
                  lastChatId: chat!.id,
                  runCount: entry.runCount + 1,
                  updatedAt: now,
                },
                now,
              )
            : entry,
        ),
      )
      const current = updated.find((entry) => entry.id === id)
      if (current) await armAlarm(current)
      return { runId, chatId: chat.id }
    } finally {
      starting.delete(id)
    }
  }

  async function recordOutcome(snapshot: ExecutionSnapshot): Promise<void> {
    const list = await loadAutomations()
    const record = list.find((entry) => entry.runningRunId === snapshot.runId)
    if (!record) return
    const ok = snapshot.status === 'done'
    const error = ok ? undefined : snapshot.error ?? (snapshot.status === 'cancelled' ? 'cancelled' : snapshot.status)
    await mutateAutomations((entries) =>
      entries.map((entry) =>
        entry.id === record.id
          ? { ...entry, runningRunId: undefined, lastStatus: ok ? 'done' : 'error', lastError: error, updatedAt: Date.now() }
          : entry,
      ),
    )
    // The execution host's record carries the model's reply; make history current.
    try {
      const reply = lastMainReply(snapshot.record.transcript)
      await saveChat(snapshot.record, reply ? reply.slice(0, 80) : `⏰ ${record.title}`)
    } catch (err) {
      console.error('[handoff] automation save chat', err)
    }
    await notify(record, ok, ok ? lastMainReply(snapshot.record.transcript) : error ?? 'failed')
  }

  async function notify(record: AutomationRecord, ok: boolean, body: string): Promise<void> {
    try {
      const settings = await loadSettings()
      if (settings.notifyOnLongTurn === false || !chrome.notifications?.create) return
      await chrome.notifications.create(`automation-${record.id}-${Date.now()}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon.svg'),
        title: ok ? `Automation finished: ${record.title}` : `Automation failed: ${record.title}`,
        message: body.replace(/\s+/g, ' ').trim().slice(0, 200) || (ok ? 'Done.' : 'Failed.'),
        silent: true,
      })
    } catch {
      /* notifications are best-effort */
    }
  }

  /* ---------------- reconcile on start ---------------- */

  async function reconcile(): Promise<void> {
    const now = Date.now()
    const list = await mutateAutomations((entries) =>
      entries.map((entry) => {
        let next = entry
        // A run marker the execution host no longer knows about means the
        // worker restarted mid-turn.
        if (next.runningRunId) {
          next = { ...next, runningRunId: undefined, lastStatus: 'error', lastError: 'interrupted: the browser or extension restarted during the run' }
        }
        if (next.enabled && next.nextRunAt === undefined) next = withNextRun(next, now)
        return next
      }),
    )
    const due: AutomationRecord[] = []
    for (const record of list) {
      if (!record.enabled || record.nextRunAt === undefined) {
        await chrome.alarms.clear(alarmName(record.id)).catch(() => {})
        continue
      }
      if (record.nextRunAt <= now) {
        due.push(record)
        continue
      }
      const existing = await chrome.alarms.get(alarmName(record.id)).catch(() => undefined)
      if (!existing || Math.abs(existing.scheduledTime - record.nextRunAt) > 1_000) await armAlarm(record)
    }
    // Missed while closed: run each once, staggered so they do not all start at once.
    due.sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
    for (const [index, record] of due.entries()) {
      setTimeout(() => {
        void runAutomation(record.id, 'catch-up').catch((err) => console.error('[handoff] automation catch-up', err))
      }, CATCH_UP_STAGGER_MS * (index + 1))
    }
  }

  /* ---------------- service ---------------- */

  function requireRecord(list: AutomationRecord[], id: string): AutomationRecord {
    const record = list.find((entry) => entry.id === id)
    if (!record) throw new Error(`no automation with id ${id} — api.automations.list() shows the existing ones`)
    return record
  }

  const host: AutomationHost = {
    reconcile,
    list: () => loadAutomations(),
    get: async (id) => (await loadAutomations()).find((entry) => entry.id === id),

    async create(input, ctx) {
      const prompt = (input.prompt ?? '').trim()
      if (!prompt) throw new Error('automations need a prompt: what should run each time')
      const zone = input.timeZone?.trim() || defaultTimeZone()
      if (!isValidTimeZone(zone)) throw new Error(`unknown time zone ${JSON.stringify(zone)}`)
      const parsed = parseScheduleInput(input.schedule, zone)
      const now = Date.now()
      const record: AutomationRecord = withNextRun(
        {
          id: uid('auto'),
          title: input.title?.trim() || deriveAutomationTitle(prompt),
          prompt,
          schedule: parsed.schedule,
          timeZone: parsed.timeZone,
          chat: parseChatTarget(input.chat, ctx.chatId),
          enabled: input.enabled !== false,
          createdAt: now,
          updatedAt: now,
          createdInChatId: ctx.chatId,
          runCount: 0,
        },
        now,
      )
      await mutateAutomations((list) => {
        if (list.length >= AUTOMATION_MAX_COUNT) throw new Error(`at most ${AUTOMATION_MAX_COUNT} automations — delete one first`)
        return [...list, record]
      })
      await armAlarm(record)
      return record
    },

    async update(id, patch, ctx) {
      let updated: AutomationRecord | undefined
      await mutateAutomations((list) => {
        const record = requireRecord(list, id)
        let next: AutomationRecord = { ...record }
        if (patch.prompt !== undefined) {
          const prompt = patch.prompt.trim()
          if (!prompt) throw new Error('prompt cannot be empty')
          next.prompt = prompt
        }
        if (patch.title !== undefined) next.title = patch.title.trim() || deriveAutomationTitle(next.prompt)
        if (patch.timeZone !== undefined) {
          const zone = patch.timeZone.trim()
          if (!isValidTimeZone(zone)) throw new Error(`unknown time zone ${JSON.stringify(zone)}`)
          next.timeZone = zone
        }
        if (patch.schedule !== undefined) {
          const parsed = parseScheduleInput(patch.schedule, next.timeZone)
          next.schedule = parsed.schedule
          next.timeZone = parsed.timeZone
          next.runCount = next.schedule.kind === 'once' ? 0 : next.runCount
        }
        if (patch.chat !== undefined) next.chat = parseChatTarget(patch.chat, ctx.chatId, record.chat)
        if (patch.enabled !== undefined) next.enabled = patch.enabled
        next.updatedAt = Date.now()
        next = withNextRun({ ...next, lastRunAt: patch.schedule !== undefined ? undefined : next.lastRunAt }, Date.now())
        updated = next
        return list.map((entry) => (entry.id === id ? next : entry))
      })
      if (!updated) throw new Error(`no automation with id ${id}`)
      await armAlarm(updated)
      return updated
    },

    async remove(id) {
      let removed = false
      await mutateAutomations((list) => {
        const next = list.filter((entry) => entry.id !== id)
        removed = next.length !== list.length
        return next
      })
      await chrome.alarms.clear(alarmName(id)).catch(() => {})
      return removed
    },

    runNow: (id) => runAutomation(id, 'manual'),

    handleRuntimeMessage(message) {
      if (message.target !== 'background' || message.type !== 'automation.command' || !message.id) return undefined
      const id = message.id
      switch (message.command) {
        case 'run':
          return runAutomation(id, 'manual')
        case 'delete':
          return host.remove(id)
        case 'enable':
        case 'disable':
          return host.update(id, { enabled: message.command === 'enable' }, {}).catch((err) => ({ error: formatError(err) }))
        default:
          return undefined
      }
    },
  }

  return host
}

function lastMainReply(transcript: TranscriptItem[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const item = transcript[i]
    if (item?.kind === 'text' && item.agentId === 'main' && item.text.trim()) return item.text.trim()
  }
  return ''
}
