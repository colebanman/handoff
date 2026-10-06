/** Identity belongs to the activity, not its position in a mutable transcript. */
export interface ActivityIdentity {
  key: string
  ids: readonly string[]
  /** Visible item immediately before the block, or null at the start. */
  after: string | null
}

export function reconcileActivityIdentity(
  previous: readonly ActivityIdentity[],
  blocks: readonly Omit<ActivityIdentity, 'key'>[],
): ActivityIdentity[] {
  const byItem = new Map<string, ActivityIdentity>()
  const pending = new Map<string | null, ActivityIdentity>()
  for (const block of previous) {
    for (const id of block.ids) byItem.set(id, block)
    if (block.ids.length === 0) pending.set(block.after, block)
  }
  const used = new Set<string>()
  return blocks.map(block => {
    // A retry can remove earlier prose or split/merge a block. Preserve an
    // existing member's row tree even when the block moves in the transcript.
    const owner = block.ids.map(id => byItem.get(id)).find(candidate => candidate && !used.has(candidate.key))
      ?? pending.get(block.after)
    const base = `activity:${block.ids[0] ?? `pending:${block.after ?? 'start'}`}`
    let key = owner && !used.has(owner.key) ? owner.key : base
    // A split may retain the pending-derived key on an earlier block while
    // creating a fresh pause at its old anchor. Keys must still be unique.
    for (let suffix = 1; used.has(key); suffix++) key = `${base}:${suffix}`
    used.add(key)
    return { ...block, key }
  })
}
