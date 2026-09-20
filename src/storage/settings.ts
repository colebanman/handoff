import {
  DEFAULT_SETTINGS,
  type ActivityCursorMode,
  type Settings,
} from '../shared/types'
import { normalizeSettings, activityCursorMode } from '../shared/normalize-settings'
export { normalizeSettings, activityCursorMode, DEFAULT_ACTIVITY_CURSOR } from '../shared/normalize-settings'
import { debugLog } from '../shared/debug-log'

export type { ActivityCursorMode }

const KEY = 'settings'
const LEGACY_SUBSCRIPTION_TOKEN_KEY = 'anthropic_oauth_tokens'
export async function loadSettings(): Promise<Settings> {
  try {
    const out = await chrome.storage.local.get(KEY)
    await chrome.storage.local
      .remove(LEGACY_SUBSCRIPTION_TOKEN_KEY)
      .catch((err) => debugLog.error('storage', 'remove legacy subscription tokens', err))
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...(out[KEY] as Partial<Settings> | undefined) })
  } catch (err) {
    debugLog.error('storage', 'loadSettings', err)
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const next = normalizeSettings(settings)
  await chrome.storage.local.set({ [KEY]: next })
  debugLog.log('storage', `settings saved (provider=${next.provider}, model=${next.modelId})`)
}

/** Service-worker read of the current pointer mode (already migrated). */
export async function loadActivityCursorMode(): Promise<ActivityCursorMode> {
  return activityCursorMode(await loadSettings())
}

/** Fires whenever the settings record is rewritten (any context). */
export function subscribeSettings(listener: (settings: Settings) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !(KEY in changes)) return
    const next = changes[KEY]?.newValue as Partial<Settings> | undefined
    listener(normalizeSettings({ ...DEFAULT_SETTINGS, ...next }))
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}

/** Same, narrowed to the pointer mode; only fires when the mode actually changes. */
export function subscribeActivityCursorMode(
  listener: (mode: ActivityCursorMode) => void,
): () => void {
  let last: ActivityCursorMode | undefined
  return subscribeSettings((settings) => {
    const mode = activityCursorMode(settings)
    if (mode === last) return
    last = mode
    listener(mode)
  })
}
