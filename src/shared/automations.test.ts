import { describe, expect, it } from 'vitest'
import {
  describeSchedule,
  nextRunAt,
  parseChatTarget,
  parseClockTime,
  parseDurationMs,
  parseInstant,
  parseScheduleInput,
  zonedParts,
  zonedToUtc,
  zoneOffsetMs,
} from './automations'

const LA = 'America/Los_Angeles'
const NY = 'America/New_York'

describe('time-zone math', () => {
  it('converts wall-clock times in a zone to instants, including across DST', () => {
    // 2026-07-15 08:00 PDT = 15:00Z ; 2026-01-15 08:00 PST = 16:00Z
    expect(new Date(zonedToUtc(2026, 7, 15, 8, 0, LA)).toISOString()).toBe('2026-07-15T15:00:00.000Z')
    expect(new Date(zonedToUtc(2026, 1, 15, 8, 0, LA)).toISOString()).toBe('2026-01-15T16:00:00.000Z')
    expect(zoneOffsetMs(Date.UTC(2026, 6, 15), LA)).toBe(-7 * 3_600_000)
    const parts = zonedParts(Date.UTC(2026, 6, 15, 15, 30), LA)
    expect(parts).toMatchObject({ year: 2026, month: 7, day: 15, hour: 8, minute: 30, weekday: 3 })
  })
})

describe('nextRunAt', () => {
  it('daily: today if the time is still ahead, otherwise tomorrow, in the zone', () => {
    const from = zonedToUtc(2026, 9, 11, 7, 0, LA)
    expect(nextRunAt({ kind: 'daily', at: '08:00' }, LA, from)).toBe(zonedToUtc(2026, 9, 11, 8, 0, LA))
    const later = zonedToUtc(2026, 9, 11, 9, 0, LA)
    expect(nextRunAt({ kind: 'daily', at: '08:00' }, LA, later)).toBe(zonedToUtc(2026, 9, 12, 8, 0, LA))
    // 07:00 in LA is already 10:00 in New York, so New York's 08:00 is tomorrow.
    expect(nextRunAt({ kind: 'daily', at: '08:00' }, NY, from)).toBe(zonedToUtc(2026, 9, 12, 8, 0, NY))
  })

  it('weekly picks the next listed weekday; weekdays skip the weekend', () => {
    // 2026-09-11 is a Friday.
    const friday = zonedToUtc(2026, 9, 11, 10, 0, LA)
    expect(nextRunAt({ kind: 'weekly', days: [1, 2, 3, 4, 5], at: '09:00' }, LA, friday)).toBe(zonedToUtc(2026, 9, 14, 9, 0, LA))
    expect(nextRunAt({ kind: 'weekly', days: [5], at: '18:00' }, LA, friday)).toBe(zonedToUtc(2026, 9, 11, 18, 0, LA))
  })

  it('monthly clamps to the month length and rolls over the year', () => {
    const from = zonedToUtc(2026, 2, 10, 12, 0, LA)
    expect(nextRunAt({ kind: 'monthly', day: 31, at: '09:00' }, LA, from)).toBe(zonedToUtc(2026, 2, 28, 9, 0, LA))
    const december = zonedToUtc(2026, 12, 20, 12, 0, LA)
    expect(nextRunAt({ kind: 'monthly', day: 1, at: '09:00' }, LA, december)).toBe(zonedToUtc(2027, 1, 1, 9, 0, LA))
  })

  it('interval anchors on the last run and catches up soon when overdue; once is spent after firing', () => {
    const now = 1_000_000_000
    expect(nextRunAt({ kind: 'interval', everyMs: 3_600_000 }, LA, now)).toBe(now + 3_600_000)
    expect(nextRunAt({ kind: 'interval', everyMs: 3_600_000 }, LA, now, now - 2 * 3_600_000)).toBe(now + 30_000)
    expect(nextRunAt({ kind: 'once', at: now + 5 }, LA, now)).toBe(now + 5)
    expect(nextRunAt({ kind: 'once', at: now - 5 }, LA, now)).toBeUndefined()
  })
})

describe('schedule input parsing', () => {
  it('accepts the documented object forms', () => {
    expect(parseScheduleInput({ daily: '8am' }, LA)).toEqual({ schedule: { kind: 'daily', at: '08:00' }, timeZone: LA })
    expect(parseScheduleInput({ weekdays: '9:30 pm' }, LA).schedule).toEqual({ kind: 'weekly', days: [1, 2, 3, 4, 5], at: '21:30' })
    expect(parseScheduleInput({ weekly: { on: ['Thursday', 'mon'], at: '18:00' } }, LA).schedule).toEqual({ kind: 'weekly', days: [1, 4], at: '18:00' })
    expect(parseScheduleInput({ monthly: { day: 1, at: 9 } }, LA).schedule).toEqual({ kind: 'monthly', day: 1, at: '09:00' })
    expect(parseScheduleInput({ every: '2h' }, LA).schedule).toEqual({ kind: 'interval', everyMs: 7_200_000 })
    expect(parseScheduleInput({ every: '1d', at: '07:00' }, LA).schedule).toEqual({ kind: 'daily', at: '07:00' })
    expect(parseScheduleInput({ daily: '08:00', timeZone: NY }, LA).timeZone).toBe(NY)
  })

  it('accepts shorthand strings', () => {
    expect(parseScheduleInput('every 30m', LA).schedule).toEqual({ kind: 'interval', everyMs: 1_800_000 })
    expect(parseScheduleInput('daily 08:00', LA).schedule).toEqual({ kind: 'daily', at: '08:00' })
    expect(parseScheduleInput('weekdays at 9am', LA).schedule).toEqual({ kind: 'weekly', days: [1, 2, 3, 4, 5], at: '09:00' })
    expect(parseScheduleInput('weekly mon,wed 09:00', LA).schedule).toEqual({ kind: 'weekly', days: [1, 3], at: '09:00' })
  })

  it('rejects too-frequent intervals, bad zones, past one-offs, and nonsense', () => {
    expect(() => parseScheduleInput({ every: '1m' }, LA)).toThrow(/minimum repeat interval/)
    expect(() => parseScheduleInput({ daily: '08:00', timeZone: 'Mars/Olympus' }, LA)).toThrow(/unknown time zone/)
    expect(() => parseScheduleInput({ once: '2000-01-01T08:00' }, LA)).toThrow(/in the past/)
    expect(() => parseScheduleInput({ cadence: 'sometimes' }, LA)).toThrow(/schedule needs one of/)
    expect(() => parseScheduleInput('whenever', LA)).toThrow(/could not read schedule/)
  })

  it('parses durations, clock times, and instants', () => {
    expect(parseDurationMs('1w')).toBe(7 * 86_400_000)
    expect(parseClockTime('12am')).toBe('00:00')
    expect(parseClockTime('12pm')).toBe('12:00')
    expect(parseClockTime(20)).toBe('20:00')
    expect(parseInstant('2026-09-12T08:00', LA)).toBe(zonedToUtc(2026, 9, 12, 8, 0, LA))
    expect(parseInstant('2026-09-12T08:00:00Z', LA)).toBe(Date.UTC(2026, 8, 12, 8))
  })
})

describe('chat targets and descriptions', () => {
  it('defaults to the creating chat, honours new, keeps a previous target on "this"', () => {
    expect(parseChatTarget(undefined, 'chat-1')).toEqual({ mode: 'existing', chatId: 'chat-1' })
    expect(parseChatTarget('new', 'chat-1')).toEqual({ mode: 'new' })
    expect(parseChatTarget('this', 'chat-2', { mode: 'existing', chatId: 'chat-1' })).toEqual({ mode: 'existing', chatId: 'chat-1' })
    expect(parseChatTarget('chat-9', 'chat-1')).toEqual({ mode: 'existing', chatId: 'chat-9' })
    expect(parseChatTarget(undefined, undefined)).toEqual({ mode: 'new' })
  })

  it('describes schedules for people', () => {
    expect(describeSchedule({ kind: 'weekly', days: [1, 2, 3, 4, 5], at: '09:00' }, LA)).toBe(`Every weekday at 09:00 (${LA})`)
    expect(describeSchedule({ kind: 'weekly', days: [1, 4], at: '18:00' }, LA)).toBe(`Every Mon, Thu at 18:00 (${LA})`)
    expect(describeSchedule({ kind: 'interval', everyMs: 7_200_000 }, LA)).toBe('Every 2 hours')
    expect(describeSchedule({ kind: 'interval', everyMs: 86_400_000 }, LA)).toBe('Every day')
  })
})
