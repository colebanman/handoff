import { toolCount, type ActivityItem } from '../activity'

/** Verbose prose stays readable until the answer begins; a reader's choice wins. */
export function thoughtDisclosure(verbose: boolean, live: boolean, manual: boolean | null): {
  open: boolean
  automatic: boolean
} {
  return { open: manual ?? (verbose && live), automatic: manual === null && verbose && live }
}

/** A mixed reasoning/tool run deserves the same disclosure as multiple tools. */
export function activityDisclosure(items: readonly ActivityItem[], live: boolean, manual: boolean | null): {
  hasHeader: boolean
  open: boolean
  capped: boolean
} {
  const tools = toolCount(items)
  const hasReasoning = items.some((item) => item.kind === 'reasoning' && item.text.trim().length > 0)
  const hasHeader = tools >= 2 || (tools > 0 && hasReasoning)
  return {
    hasHeader,
    open: !hasHeader || (manual ?? live),
    capped: hasHeader && live && manual === null,
  }
}
