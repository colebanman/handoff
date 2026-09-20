let counter = 0

/** Compact unique id, monotonic within a page lifetime. */
export function uid(prefix = 'id'): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * The tail of a generated id, for showing a subagent or task to a person:
 * "sub-a-mfxk3s-1-8emu" → "8emu". Short enough to read aloud, and the same
 * for a subagent and the background task that runs it.
 */
export function shortId(id: string): string {
  const tail = id.trim().split('-').filter(Boolean).at(-1) ?? ''
  return tail || id.trim().slice(0, 6)
}
