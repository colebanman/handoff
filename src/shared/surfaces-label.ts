/** Human-readable labels for browser tabs held by subagents. */
export function surfaceLabel(surface: string, tabTitles?: Record<string, string> | Map<string, string>): string {
  if (surface.startsWith('tab:')) {
    const id = surface.slice(4)
    const title = tabTitles instanceof Map ? tabTitles.get(id) : tabTitles?.[id]
    const trimmed = title?.trim()
    return trimmed ? `Tab · ${trimmed}` : `Tab ${id}`
  }
  return surface
}

/** Labels for a list of surfaces, in order, skipping empties. */
export function surfaceLabels(surfaces: readonly string[] | undefined, tabTitles?: Record<string, string> | Map<string, string>): string[] {
  return (surfaces ?? []).filter(Boolean).map((surface) => surfaceLabel(surface, tabTitles))
}
