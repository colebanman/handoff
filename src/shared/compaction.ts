import type { TranscriptItem } from './types'
import type { ModelMessage } from 'ai'

/** Internal replay metadata, not a user request or a memory entry. */
export function isCompactionCheckpoint(message: ModelMessage): boolean {
  return Boolean(message.providerOptions?.compaction?.checkpoint)
}

export function latestCompactionBoundary(messages: ModelMessage[]): { index: number; key: string } {
  for (let index = messages.length - 1; index >= 0; index--) {
    const saved = messages[index]!.providerOptions?.compaction?.checkpoint as
      { output?: Array<{ type?: string; id?: string }> } | undefined
    if (saved) {
      // Item IDs are public metadata; the encrypted contents stay opaque.
      const id = saved.output?.find((item) => item.type === 'compaction')?.id ?? 'legacy'
      return { index, key: `${index}:${id}` }
    }
  }
  return { index: -1, key: 'uncompacted' }
}

export function isCompacting(items: TranscriptItem[], agentId = 'main'): boolean {
  return items.some((item) =>
    (item.kind === 'compaction' && item.agentId === agentId && item.status === 'running') ||
    (item.kind === 'tool' && (
      isCompacting(item.childItems ?? [], agentId) ||
      item.workflow?.agents.some((agent) => isCompacting(agent.items ?? [], agentId))
    )))
}
