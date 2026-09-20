/** Settings tabs in the Chrome extension, in display order. */
export const SETTINGS_SECTIONS = [
  { id: 'account', label: 'Account' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'instructions', label: 'Prompt' },
  { id: 'automations', label: 'Automations' },
  { id: 'appearance', label: 'Theme' },
] as const

export type SectionId = typeof SETTINGS_SECTIONS[number]['id']

/** Resolve saved or legacy names to a visible settings tab. */
export function resolveSection(requested: string | undefined): SectionId {
  const legacy: Record<string, SectionId> = { accounts: 'account' }
  const id = (legacy[requested ?? ''] ?? requested) as SectionId | undefined
  return id && SETTINGS_SECTIONS.some(section => section.id === id) ? id : 'account'
}
