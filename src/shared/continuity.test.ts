import { describe, expect, it } from 'vitest'
import { memoryContentSchema, memoryLife, memoryTime, subjectKey, type MemoryRecord } from './continuity'

const record = (patch: Partial<MemoryRecord> = {}): MemoryRecord => ({
  ...memoryContentSchema.parse({ subject: 'project.y.group', title: 'Project Y group', body: 'Assigned to group 5.', kind: 'project', useWhen: 'When working on Project Y.' }),
  id: 'group', revision: 1, createdAt: 0, updatedAt: 0, edited: false, sources: [], ...patch,
})

describe('memory time and lifecycle', () => {
  it('treats a date as an inclusive local day, with DST-aware exclusive end', () => {
    expect(memoryTime('2026-03-08', 'America/New_York')).toBe(Date.parse('2026-03-08T05:00:00Z'))
    expect(memoryTime('2026-03-08', 'America/New_York', true)).toBe(Date.parse('2026-03-09T04:00:00Z'))
    expect(memoryTime('2026-11-01', 'America/New_York', true)! - memoryTime('2026-11-01', 'America/New_York')!).toBe(25 * 3_600_000)
  })
  it('does not reinterpret offset timestamps or accept impossible dates', () => {
    expect(memoryTime('2026-10-07T00:30:00+09:00', 'America/New_York', true)).toBe(Date.parse('2026-10-06T15:30:00Z'))
    expect(memoryTime('2026-02-30', 'UTC')).toBeUndefined()
    expect(memoryTime('not a date')).toBeUndefined()
  })
  it('retires a flight at arrival, not at departure midnight or after a fixed TTL', () => {
    const flight = record({ kind: 'event', eventStart: '2026-10-05T23:00:00-07:00', eventEnd: '2026-10-06T07:00:00-04:00' })
    expect(memoryLife(flight, [flight], Date.parse('2026-10-06T10:00:00Z'))).toBe('active')
    expect(memoryLife(flight, [flight], Date.parse('2026-10-06T11:00:00Z'))).toBe('historical')
    expect(flight.state).toBe('active') // Eligibility is computed even when no worker/alarm ran.
  })
  it('inherits a project end while keeping a professor relationship independent', () => {
    const project = record({ id: 'project', subject: 'Project Y', validUntil: '2026-10-10' })
    const group = record({ expiresWith: 'project y' })
    const professor = record({ id: 'professor', subject: 'course.professor', kind: 'context' })
    const memories = [group, project, professor]
    const now = Date.parse('2026-10-11T00:00:00Z')
    expect(memoryLife(group, memories, now)).toBe('historical')
    expect(memoryLife(professor, memories, now)).toBe('active')
    expect(memoryLife(group, [group, { ...project, validUntil: '2026-10-20' }], now)).toBe('active')
  })
  it('marks review without making up completion and terminates dependency cycles', () => {
    const one = record({ reviewAt: '2026-10-01' })
    expect(memoryLife(one, [one], Date.parse('2026-10-02T00:00:00Z'))).toBe('review')
    const two = record({ id: 'other', subject: 'other', expiresWith: one.subject })
    expect(() => memoryLife({ ...one, expiresWith: two.subject }, [one, two])).not.toThrow()
  })
  it('matches durable identity without case/punctuation or legacy classification churn', () => {
    expect(subjectKey('[Current] Project Y — group')).toBe(subjectKey('[Stable] project y group'))
    expect(subjectKey('MÜNCHEN – résumé')).toBe('münchen résumé')
  })
})
