import type { ExecutionSnapshot } from './execution-protocol'
import type { ChatRecord } from './types'

/** A failed request may be replayed only when no tool could have run since the checkpoint. */
export function canResumeExecution(snapshot: ExecutionSnapshot): boolean {
  if (snapshot.status !== 'error' && snapshot.status !== 'interrupted') return false
  const length = snapshot.committedTranscriptLength
  if (length === undefined || length < 0 || length > snapshot.record.transcript.length) return false
  return !snapshot.record.transcript.slice(length).some((item) => item.kind === 'tool' || item.kind === 'memory')
}

export function isConnectionFailureMessage(message?: string): boolean {
  return !!message && /failed to fetch|fetch failed|network error|connection|socket hang up|ECONNRESET|ETIMEDOUT|model request stalled/i.test(message)
}

/** Keep committed model history and discard only the uncommitted UI tail. */
export function recordForResume(record: ChatRecord, committedTranscriptLength?: number): ChatRecord {
  if (committedTranscriptLength === undefined || committedTranscriptLength < 0 ||
      committedTranscriptLength > record.transcript.length) return record
  return { ...record, transcript: record.transcript.slice(0, committedTranscriptLength) }
}
