/** Lossless, model-facing browser observations. IDs identify nodes, not their
 * changing labels/values. Full observations remain the canonical stored form. */
export interface BrowserSnapshot {
  tabId: number
  document: string
  revision: number
  header: string
  lines: string[]
}

const ID = '[en][a-z0-9]+-\\d+'
const NODE = new RegExp(`^ *\\[(${ID})\\] .+$`)
const FULL = /^Browser snapshot v1 tab=(\d+) document=([a-z0-9]+) revision=(\d+)$/m
const END = '\nEnd browser snapshot.'

export function snapshotNodeId(line: string): string | undefined {
  return NODE.exec(line)?.[1]
}

export function renderBrowserSnapshot(snapshot: BrowserSnapshot): string {
  return `Browser snapshot v1 tab=${snapshot.tabId} document=${snapshot.document} revision=${snapshot.revision}\n${snapshot.header}\n\n${snapshot.lines.join('\n')}${END}`
}

/** A missing footer (including truncated/spilled output) is not a baseline. */
export function parseBrowserSnapshot(text: string): { snapshot: BrowserSnapshot; before: string; after: string } | undefined {
  const match = FULL.exec(text)
  if (!match) return undefined
  const start = match.index + match[0].length + 1
  const end = text.indexOf(END, start)
  const split = text.indexOf('\n\n', start)
  if (end < 0 || split < 0 || split > end) return undefined
  const body = text.slice(split + 2, end)
  const lines = body ? body.split('\n') : []
  const ids = lines.map(snapshotNodeId)
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return undefined
  return {
    snapshot: { tabId: Number(match[1]), document: match[2]!, revision: Number(match[3]), header: text.slice(start, split), lines },
    before: text.slice(0, match.index), after: text.slice(end + END.length),
  }
}

export type SnapshotEdit =
  | { kind: 'remove'; id: string }
  | { kind: 'set'; line: string }
  | { kind: 'place'; after: string | null; line: string }

export interface SnapshotDelta {
  tabId: number
  document: string
  from: number
  revision: number
  header?: string
  context: string[]
  edits: SnapshotEdit[]
}

/** Exact comparison, not hash equality or fuzzy label matching. Placement
 * edits also represent moves and retain the original indentation/order. */
export function diffBrowserSnapshot(previous: BrowserSnapshot, next: BrowserSnapshot): SnapshotDelta {
  if (previous.tabId !== next.tabId || previous.document !== next.document) throw new Error('Different browser documents')
  const wanted = new Set(next.lines.map((line) => snapshotNodeId(line)!))
  const working = previous.lines.filter((line) => wanted.has(snapshotNodeId(line)!))
  const edits: SnapshotEdit[] = previous.lines.filter((line) => !wanted.has(snapshotNodeId(line)!))
    .map((line) => ({ kind: 'remove', id: snapshotNodeId(line)! }))
  const changed = new Set<string>()
  next.lines.forEach((line, index) => {
    const id = snapshotNodeId(line)!
    if (snapshotNodeId(working[index] ?? '') !== id) {
      const old = working.findIndex((value) => snapshotNodeId(value) === id)
      if (old >= 0) working.splice(old, 1)
      working.splice(index, 0, line)
      edits.push({ kind: 'place', after: index ? snapshotNodeId(next.lines[index - 1]!)! : null, line })
      changed.add(id)
    } else if (working[index] !== line) {
      working[index] = line
      edits.push({ kind: 'set', line })
      changed.add(id)
    }
  })
  // Include unchanged ancestors so an error, field, or newly inserted item
  // retains its form/dialog/section context without another model call.
  const context = new Set<string>()
  const ancestors: string[] = []
  for (const line of next.lines) {
    const depth = line.length - line.trimStart().length
    while (ancestors.length && ancestors.at(-1)!.length - ancestors.at(-1)!.trimStart().length >= depth) ancestors.pop()
    if (changed.has(snapshotNodeId(line)!)) {
      for (const parent of ancestors) if (!changed.has(snapshotNodeId(parent)!)) context.add(parent)
    }
    ancestors.push(line)
  }
  return {
    tabId: next.tabId, document: next.document, from: previous.revision, revision: next.revision,
    ...(previous.header !== next.header ? { header: next.header } : {}), context: [...context], edits,
  }
}

export function applyBrowserSnapshotDelta(previous: BrowserSnapshot, delta: SnapshotDelta): BrowserSnapshot {
  if (previous.tabId !== delta.tabId || previous.document !== delta.document || previous.revision !== delta.from) {
    throw new Error('Browser snapshot baseline mismatch')
  }
  const lines = [...previous.lines]
  for (const edit of delta.edits) {
    const id = edit.kind === 'remove' ? edit.id : snapshotNodeId(edit.line)
    if (!id) throw new Error('Invalid browser node')
    const index = lines.findIndex((line) => snapshotNodeId(line) === id)
    if (edit.kind === 'remove') {
      if (index < 0) throw new Error('Missing removed node')
      lines.splice(index, 1)
    } else if (edit.kind === 'set') {
      if (index < 0) throw new Error('Missing changed node')
      lines[index] = edit.line
    } else {
      if (index >= 0) lines.splice(index, 1)
      const anchor = edit.after === null ? -1 : lines.findIndex((line) => snapshotNodeId(line) === edit.after)
      if (edit.after !== null && anchor < 0) throw new Error('Missing placement anchor')
      lines.splice(anchor + 1, 0, edit.line)
    }
  }
  return { tabId: delta.tabId, document: delta.document, revision: delta.revision, header: delta.header ?? previous.header, lines }
}

export function renderBrowserSnapshotDelta(delta: SnapshotDelta): string {
  const out = [`Browser changes v1 tab=${delta.tabId} document=${delta.document} from=${delta.from} revision=${delta.revision}`]
  if (delta.header !== undefined) out.push(`Page metadata: ${JSON.stringify(delta.header)}`)
  for (const line of delta.context) out.push(`Context: ${line}`)
  for (const edit of delta.edits) {
    if (edit.kind === 'remove') out.push(`Remove: [${edit.id}]`)
    else if (edit.kind === 'set') out.push(`Changed: ${edit.line}`)
    else out.push(`Place after [${edit.after ?? 'start'}]: ${edit.line}`)
  }
  out.push('All unlisted nodes and refs remain unchanged. End browser changes.')
  return out.join('\n')
}

/** Decode the actual model-facing representation for replay verification. */
export function parseBrowserSnapshotDelta(text: string): SnapshotDelta | undefined {
  const match = /^Browser changes v1 tab=(\d+) document=([a-z0-9]+) from=(\d+) revision=(\d+)\n([\s\S]*?)All unlisted nodes and refs remain unchanged\. End browser changes\./m.exec(text)
  if (!match) return undefined
  const delta: SnapshotDelta = { tabId: +match[1]!, document: match[2]!, from: +match[3]!, revision: +match[4]!, context: [], edits: [] }
  try {
    for (const line of match[5]!.split('\n')) {
      if (!line) continue
      if (line.startsWith('Page metadata: ')) delta.header = JSON.parse(line.slice(15))
      else if (line.startsWith('Context: ')) delta.context.push(line.slice(9))
      else if (line.startsWith('Changed: ')) delta.edits.push({ kind: 'set', line: line.slice(9) })
      else {
        const remove = new RegExp(`^Remove: \\[(${ID})\\]$`).exec(line)
        const place = new RegExp(`^Place after \\[(start|${ID})\\]: (.+)$`).exec(line)
        if (remove) delta.edits.push({ kind: 'remove', id: remove[1]! })
        else if (place) delta.edits.push({ kind: 'place', after: place[1] === 'start' ? null : place[1]!, line: place[2]! })
        else return undefined
      }
    }
    return delta
  } catch { return undefined }
}
