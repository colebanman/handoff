import type { TranscriptItem } from './types'

/** Settle one agent's scope; separately running child agents keep their state. */
export function settleTranscriptScope(items: TranscriptItem[], reason = 'Agent ended before this operation completed.'): TranscriptItem[] {
  return items.map((item) => {
    if ((item.kind === 'text' || item.kind === 'reasoning') && item.streaming) return { ...item, streaming: false }
    if (item.kind === 'compaction' && item.status === 'running') return { ...item, status: 'cancelled' }
    if (item.kind === 'tool' && item.status === 'running') return { ...item, status: 'error', output: item.output ?? reason }
    return item
  })
}
