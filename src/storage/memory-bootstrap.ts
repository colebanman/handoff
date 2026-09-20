/**
 * Version marker for production memory migrations.
 *
 * This deliberately lives outside the VFS. MEMORY.md is user-owned and may be
 * deleted; recording the migration separately means a later panel open will
 * not recreate a file the user intentionally removed.
 */
import { debugLog } from '../shared/debug-log'

const KEY = 'memoryBootstrapVersion'

export const CURRENT_MEMORY_BOOTSTRAP_VERSION = 1

export async function loadMemoryBootstrapVersion(): Promise<number> {
  try {
    const out = await chrome.storage.local.get(KEY)
    const stored = out[KEY]
    return typeof stored === 'number' && Number.isFinite(stored) && stored >= 0
      ? Math.floor(stored)
      : 0
  } catch (err) {
    debugLog.error('storage', 'load memory bootstrap version', err)
    return 0
  }
}

export async function markMemoryBootstrapComplete(): Promise<void> {
  await chrome.storage.local.set({ [KEY]: CURRENT_MEMORY_BOOTSTRAP_VERSION })
  debugLog.log('storage', `memory bootstrap migrated to v${CURRENT_MEMORY_BOOTSTRAP_VERSION}`)
}
