/**
 * Automations — prompts that run on a schedule ("every weekday at 8, refresh
 * the assignments artifact"). Records live in chrome.storage.local; the
 * service worker arms one `chrome.alarms` alarm per enabled automation and
 * starts the turn itself through the execution host, so runs happen with the
 * side panel closed. Missed runs (Chrome closed, laptop asleep) fire once on
 * the next start — never once per missed occurrence.
 *
 * This module is pure: schedule parsing, time-zone math, next-run
 * computation, and human descriptions. Storage and alarms live in
 * src/storage/automations.ts and src/background/automation-host.ts.
 */

import type { JsonValue } from './rpc'

export const AUTOMATIONS_STORAGE_KEY = 'automations:v1'
export const AUTOMATION_ALARM_PREFIX = 'automation:'
/** Below this, a repeating automation is almost certainly a mistake (and a bill). */
export const AUTOMATION_MIN_INTERVAL_MS = 5 * 60 * 1000
/** Step checkpoints a scheduled run auto-continues through before stopping. */
export const AUTOMATION_AUTO_CONTINUE_STEPS = 3
export const AUTOMATION_MAX_COUNT = 50

export type AutomationSchedule =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'daily'; at: string }
  | { kind: 'weekly'; days: number[]; at: string }
  | { kind: 'monthly'; day: number; at: string }
  | { kind: 'once'; at: number }

export type AutomationChatMode = 'existing' | 'new'
export type AutomationRunStatus = 'running' | 'done' | 'error' | 'skipped'

export interface AutomationRecord {
  id: string
  title: string
  prompt: string
  schedule: AutomationSchedule
  /** IANA zone the wall-clock times are interpreted in. */
  timeZone: string
  chat: { mode: AutomationChatMode; chatId?: string }
  enabled: boolean
  createdAt: number
  updatedAt: number
  /** Chat the automation was created from (the default "existing" target). */
  createdInChatId?: string
  nextRunAt?: number
  lastRunAt?: number
  lastStatus?: AutomationRunStatus
  lastError?: string
  /** Chat the last run wrote into (differs per run for mode 'new'). */
  lastChatId?: string
  runCount: number
  runningRunId?: string
}

/** Model/user-facing input; forgiving on purpose (see parseScheduleInput). */
export interface AutomationInput {
  title?: string
  prompt: string
  schedule: JsonValue
  timeZone?: string
  /** 'this' | 'existing' | 'new' | a chat id. Default: the chat that created it. */
  chat?: string
  enabled?: boolean
}

export type AutomationPatch = Partial<AutomationInput>

export interface AutomationService {
  list(): Promise<AutomationRecord[]>
  get(id: string): Promise<AutomationRecord | undefined>
  create(input: AutomationInput, ctx: { chatId?: string }): Promise<AutomationRecord>
  update(id: string, patch: AutomationPatch, ctx: { chatId?: string }): Promise<AutomationRecord>
  remove(id: string): Promise<boolean>
  /** Start a run immediately (does not move the schedule). */
  runNow(id: string): Promise<{ runId: string; chatId: string } | { skipped: string }>
}

export type AutomationRuntimeMessage =
  | { target: 'background'; type: 'automation.command'; command: 'run' | 'enable' | 'disable' | 'delete'; id: string }

/* ------------------------------------------------------------------ */
/* Time-zone math (no libraries: Intl does the heavy lifting)          */
/* ------------------------------------------------------------------ */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = partsFormatters.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    })
    partsFormatters.set(tz, fmt)
  }
  return fmt
}

export function zonedParts(ms: number, tz: string): ZonedParts {
  const out: Record<string, string> = {}
  for (const part of formatterFor(tz).formatToParts(new Date(ms))) out[part.type] = part.value
  const hour = Number(out.hour)
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: Math.max(0, WEEKDAYS.indexOf((out.weekday ?? 'Sun').slice(0, 3).toLowerCase() as (typeof WEEKDAYS)[number])),
  }
}

/** Zone offset at `ms`, in ms (positive east of UTC). */
export function zoneOffsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** Instant for a wall-clock time in `tz`; DST gaps resolve forward, overlaps pick the first. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const offset = zoneOffsetMs(guess, tz)
  let result = guess - offset
  const offsetAtResult = zoneOffsetMs(result, tz)
  if (offsetAtResult !== offset) result = guess - offsetAtResult
  return result
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

function parseHm(at: string): { hour: number; minute: number } {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(at)
  if (!m) throw new Error(`bad time ${JSON.stringify(at)}`)
  return { hour: Number(m[1]), minute: Number(m[2] ?? '0') }
}

/**
 * Next instant the schedule fires strictly after `fromMs`. `lastRunAt` anchors
 * interval schedules. Returns undefined for a spent one-off.
 */
export function nextRunAt(schedule: AutomationSchedule, tz: string, fromMs: number, lastRunAt?: number): number | undefined {
  switch (schedule.kind) {
    case 'interval': {
      const base = lastRunAt ?? fromMs
      const next = base + schedule.everyMs
      return next > fromMs ? next : fromMs + 30_000
    }
    case 'once':
      return schedule.at > fromMs ? schedule.at : undefined
    case 'daily': {
      const { hour, minute } = parseHm(schedule.at)
      const now = zonedParts(fromMs, tz)
      for (let offset = 0; offset <= 2; offset++) {
        const d = addDays(now.year, now.month, now.day, offset)
        const candidate = zonedToUtc(d.year, d.month, d.day, hour, minute, tz)
        if (candidate > fromMs) return candidate
      }
      return undefined
    }
    case 'weekly': {
      const { hour, minute } = parseHm(schedule.at)
      const days = new Set(schedule.days)
      const now = zonedParts(fromMs, tz)
      for (let offset = 0; offset <= 8; offset++) {
        const d = addDays(now.year, now.month, now.day, offset)
        const weekday = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()
        if (!days.has(weekday)) continue
        const candidate = zonedToUtc(d.year, d.month, d.day, hour, minute, tz)
        if (candidate > fromMs) return candidate
      }
      return undefined
    }
    case 'monthly': {
      const { hour, minute } = parseHm(schedule.at)
      const now = zonedParts(fromMs, tz)
      for (let offset = 0; offset <= 2; offset++) {
        const monthIndex = now.month - 1 + offset
        const year = now.year + Math.floor(monthIndex / 12)
        const month = (monthIndex % 12) + 1
        const day = Math.min(schedule.day, daysInMonth(year, month))
        const candidate = zonedToUtc(year, month, day, hour, minute, tz)
        if (candidate > fromMs) return candidate
      }
      return undefined
    }
  }
}

/* ------------------------------------------------------------------ */
/* Input parsing (what the model writes)                               */
/* ------------------------------------------------------------------ */

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)\s*$/i

export function parseDurationMs(raw: string): number {
  const m = DURATION_RE.exec(raw)
  if (!m) throw new Error(`could not read duration ${JSON.stringify(raw)} — use "30m", "2h", "1d", or "1w"`)
  const n = Number(m[1])
  const unit = m[2]!.toLowerCase()
  const factor = unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : unit.startsWith('d') ? 86_400_000 : 7 * 86_400_000
  return Math.round(n * factor)
}

/** "08:00", "8", "8am", "8:30 pm", "20:15" → "HH:MM" (24h). */
export function parseClockTime(raw: string | number): string {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0 || raw > 23) throw new Error(`bad hour ${raw}`)
    return `${String(raw).padStart(2, '0')}:00`
  }
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(raw)
  if (!m) throw new Error(`could not read time ${JSON.stringify(raw)} — use "08:00", "8am", or "20:15"`)
  let hour = Number(m[1])
  const minute = Number(m[2] ?? '0')
  const meridiem = m[3]?.toLowerCase().replace(/\./g, '')
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  if (hour > 23 || minute > 59) throw new Error(`time out of range: ${raw}`)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function parseWeekday(raw: string | number): number {
  if (typeof raw === 'number') {
    if (raw >= 0 && raw <= 6) return raw
    throw new Error(`bad weekday ${raw} (0 = Sunday … 6 = Saturday)`)
  }
  const key = raw.trim().slice(0, 3).toLowerCase()
  const index = WEEKDAYS.indexOf(key as (typeof WEEKDAYS)[number])
  if (index < 0) throw new Error(`bad weekday ${JSON.stringify(raw)}`)
  return index
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, JsonValue>) : undefined
}

function readAt(value: JsonValue | undefined, fallback = '09:00'): string {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' || typeof value === 'number') return parseClockTime(value)
  const record = asRecord(value)
  if (record && (typeof record.at === 'string' || typeof record.at === 'number')) return parseClockTime(record.at)
  throw new Error(`could not read a time from ${JSON.stringify(value)}`)
}

/**
 * Accepts:
 *   { every: "30m" | "2h" | "1d" | "1w" }
 *   { daily: "08:00" } | { daily: { at: "8am" } }
 *   { weekdays: "09:00" }
 *   { weekly: { on: ["mon","wed"], at: "09:00" } }
 *   { monthly: { day: 1, at: "09:00" } }
 *   { once: "2026-09-12T08:00" }   (wall clock in the zone, or ISO with offset)
 *   plus optional timeZone (IANA); shorthand strings "every 30m", "daily 08:00",
 *   "weekdays 9am", "weekly mon,wed 09:00", "monthly 1 09:00".
 */
export function parseScheduleInput(input: JsonValue, defaultTz: string): { schedule: AutomationSchedule; timeZone: string } {
  if (typeof input === 'string') return parseScheduleInput(shorthandToObject(input), defaultTz)
  const record = asRecord(input)
  if (!record) throw new Error('schedule must be an object like { daily: "08:00" } or { every: "2h" }')
  const tzRaw = typeof record.timeZone === 'string' ? record.timeZone.trim() : typeof record.tz === 'string' ? record.tz.trim() : ''
  const timeZone = tzRaw || defaultTz
  if (!isValidTimeZone(timeZone)) throw new Error(`unknown time zone ${JSON.stringify(timeZone)} — use an IANA name like "America/Los_Angeles"`)

  let schedule: AutomationSchedule | undefined
  if (record.every !== undefined && record.every !== null) {
    const everyMs = typeof record.every === 'number' ? record.every * 60_000 : parseDurationMs(String(record.every))
    if (everyMs < AUTOMATION_MIN_INTERVAL_MS) {
      throw new Error(`the minimum repeat interval is ${AUTOMATION_MIN_INTERVAL_MS / 60_000} minutes`)
    }
    // "every 1d at 08:00" is a daily schedule in disguise.
    if (everyMs === 86_400_000 && record.at !== undefined) schedule = { kind: 'daily', at: readAt(record.at) }
    else schedule = { kind: 'interval', everyMs }
  } else if (record.daily !== undefined) {
    schedule = { kind: 'daily', at: readAt(record.daily) }
  } else if (record.weekdays !== undefined) {
    schedule = { kind: 'weekly', days: [1, 2, 3, 4, 5], at: readAt(record.weekdays) }
  } else if (record.weekends !== undefined) {
    schedule = { kind: 'weekly', days: [0, 6], at: readAt(record.weekends) }
  } else if (record.weekly !== undefined) {
    const weekly = asRecord(record.weekly)
    const onRaw = weekly?.on ?? weekly?.days ?? record.on ?? record.days
    const list = Array.isArray(onRaw) ? onRaw : typeof onRaw === 'string' ? onRaw.split(/[,\s]+/).filter(Boolean) : []
    const days = [...new Set(list.map((d) => parseWeekday(d as string | number)))].sort()
    if (days.length === 0) throw new Error('weekly schedules need days, e.g. { weekly: { on: ["mon", "thu"], at: "09:00" } }')
    schedule = { kind: 'weekly', days, at: readAt(weekly ?? record.weekly) }
  } else if (record.monthly !== undefined) {
    const monthly = asRecord(record.monthly)
    const day = Number(monthly?.day ?? monthly?.on ?? record.day ?? 1)
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('monthly schedules need a day of month 1–31')
    schedule = { kind: 'monthly', day, at: readAt(monthly ?? record.monthly) }
  } else if (record.once !== undefined || record.at !== undefined) {
    const raw = record.once ?? record.at
    if (typeof raw !== 'string' && typeof raw !== 'number') throw new Error('once needs a date-time string')
    const at = parseInstant(raw, timeZone)
    if (at <= Date.now()) throw new Error(`${new Date(at).toISOString()} is in the past`)
    schedule = { kind: 'once', at }
  }
  if (!schedule) {
    throw new Error('schedule needs one of: every, daily, weekdays, weekly, monthly, once (e.g. { daily: "08:00" })')
  }
  return { schedule, timeZone }
}

function shorthandToObject(text: string): Record<string, JsonValue> {
  const s = text.trim().toLowerCase()
  let m: RegExpExecArray | null
  if ((m = /^every\s+(\d+\s*[a-z]+)(?:\s+at\s+(.+))?$/.exec(s))) return m[2] ? { every: m[1]!, at: m[2] } : { every: m[1]! }
  if ((m = /^(?:daily|every\s*day)(?:\s+at)?\s+(.+)$/.exec(s))) return { daily: m[1]! }
  if ((m = /^weekdays(?:\s+at)?\s+(.+)$/.exec(s))) return { weekdays: m[1]! }
  if ((m = /^weekends(?:\s+at)?\s+(.+)$/.exec(s))) return { weekends: m[1]! }
  if ((m = /^(?:weekly|every)\s+([a-z,\s]+?)(?:\s+at)?\s+(\d.+)$/.exec(s))) return { weekly: { on: m[1]!.split(/[,\s]+/).filter(Boolean), at: m[2]! } }
  if ((m = /^monthly\s+(\d{1,2})(?:\s+at)?\s+(.+)$/.exec(s))) return { monthly: { day: Number(m[1]), at: m[2]! } }
  if ((m = /^(?:once|at|on)\s+(.+)$/.exec(s))) return { once: m[1]! }
  throw new Error(`could not read schedule ${JSON.stringify(text)} — try { daily: "08:00" }, { weekdays: "9am" }, { every: "2h" }, or { once: "2026-09-12T08:00" }`)
}

/** ISO with offset → as given; bare wall clock ("2026-09-12T08:00" / "2026-09-12 08:00") → in `tz`. */
export function parseInstant(raw: string | number, tz: string): number {
  if (typeof raw === 'number') return raw
  const text = raw.trim()
  const wall = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2}))?$/.exec(text)
  if (wall) {
    return zonedToUtc(Number(wall[1]), Number(wall[2]), Number(wall[3]), Number(wall[4] ?? '9'), Number(wall[5] ?? '0'), tz)
  }
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) throw new Error(`could not read date-time ${JSON.stringify(raw)}`)
  return parsed
}

/** 'this' | 'existing' | 'current' → the creating chat; 'new' → fresh chat per run; else a chat id. */
export function parseChatTarget(raw: string | undefined, ctxChatId: string | undefined, previous?: AutomationRecord['chat']): AutomationRecord['chat'] {
  const value = (raw ?? '').trim()
  if (!value) return previous ?? (ctxChatId ? { mode: 'existing', chatId: ctxChatId } : { mode: 'new' })
  if (value === 'new') return { mode: 'new' }
  if (value === 'this' || value === 'existing' || value === 'current' || value === 'same') {
    const chatId = previous?.chatId ?? ctxChatId
    if (!chatId) throw new Error('no current chat to attach the automation to — pass a chatId or chat: "new"')
    return { mode: 'existing', chatId }
  }
  return { mode: 'existing', chatId: value }
}

export function deriveAutomationTitle(prompt: string): string {
  const firstLine = prompt.split('\n').map((line) => line.trim()).find(Boolean) ?? 'Automation'
  return firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine
}

/* ------------------------------------------------------------------ */
/* Descriptions                                                        */
/* ------------------------------------------------------------------ */

export function describeSchedule(schedule: AutomationSchedule, tz: string): string {
  switch (schedule.kind) {
    case 'interval': {
      const ms = schedule.everyMs
      const unit =
        ms % (7 * 86_400_000) === 0
          ? [ms / (7 * 86_400_000), 'week']
          : ms % 86_400_000 === 0
            ? [ms / 86_400_000, 'day']
            : ms % 3_600_000 === 0
              ? [ms / 3_600_000, 'hour']
              : [Math.round(ms / 60_000), 'minute']
      const [n, name] = unit as [number, string]
      return n === 1 ? `Every ${name}` : `Every ${n} ${name}s`
    }
    case 'daily':
      return `Every day at ${schedule.at} (${tz})`
    case 'weekly': {
      const days = [...schedule.days].sort()
      const label =
        days.join(',') === '1,2,3,4,5' ? 'weekday' : days.join(',') === '0,6' ? 'weekend day' : days.map((d) => WEEKDAY_LABELS[d]).join(', ')
      return `Every ${label} at ${schedule.at} (${tz})`
    }
    case 'monthly':
      return `Monthly on day ${schedule.day} at ${schedule.at} (${tz})`
    case 'once':
      return `Once on ${formatInZone(schedule.at, tz)}`
  }
}

export function formatInZone(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString()
  }
}

/** Compact, model-facing view of a record (what api.automations.* returns). */
export function summarizeAutomation(record: AutomationRecord): Record<string, JsonValue> {
  return {
    id: record.id,
    title: record.title,
    prompt: record.prompt,
    schedule: describeSchedule(record.schedule, record.timeZone),
    scheduleSpec: record.schedule as unknown as JsonValue,
    timeZone: record.timeZone,
    chat: record.chat.mode === 'new' ? 'new chat per run' : `existing chat ${record.chat.chatId ?? ''}`.trim(),
    chatId: record.chat.chatId ?? null,
    enabled: record.enabled,
    nextRunAt: record.nextRunAt ?? null,
    nextRun: record.nextRunAt ? formatInZone(record.nextRunAt, record.timeZone) : null,
    lastRun: record.lastRunAt ? formatInZone(record.lastRunAt, record.timeZone) : null,
    lastStatus: record.lastStatus ?? null,
    lastError: record.lastError ?? null,
    lastChatId: record.lastChatId ?? null,
    runCount: record.runCount,
  }
}

/** The user-role message a scheduled run sends, with what the model needs to know about the run. */
export function automationRunMessage(record: AutomationRecord, firedAt: number, reason: 'scheduled' | 'catch-up' | 'manual'): string {
  const when = formatInZone(firedAt, record.timeZone)
  const reasonText =
    reason === 'catch-up'
      ? 'This run was missed while the browser was closed and is running now, once, as catch-up.'
      : reason === 'manual'
        ? 'This run was started manually.'
        : 'This is a scheduled run.'
  return (
    `${record.prompt}\n\n<context source="automation">Automation "${record.title}" (id ${record.id}; ${describeSchedule(record.schedule, record.timeZone)}). ` +
    `Now: ${when}. ${reasonText} Run ${record.runCount + 1}. Nobody is necessarily watching: do the task end to end using the tools, ` +
    `do not ask questions, and finish with a brief summary of what changed (or that nothing changed). Update linked artifacts in place. ` +
    `Change the schedule with api.automations.update("${record.id}", {...}) if the user's instructions call for it.</context>`
  )
}
