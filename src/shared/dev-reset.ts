/**
 * Dev-only "fresh start": put this install back to its first-run state so the
 * onboarding flow can be tested over and over instead of once per fresh profile.
 *
 * Why a compile-time flag and not a runtime one. This function is genuinely
 * destructive — it drops every chat, every setting, and the entire virtual
 * filesystem. A runtime `if (isDev)` still SHIPS the code, and a production
 * bundle that contains a reachable "erase the user's work" path is a bug waiting
 * for the wrong message to arrive. `__DEV_BUILD__` is a Vite `define`
 * (see vite.config.ts), so in `npm run build` every guard below reads
 * `if (false)`, Rollup deletes the branch, and the reset — plus the only
 * `indexedDB.deleteDatabase` call in the codebase — is not emitted at all. Only
 * `npm run build:dev` sets HANDOFF_DEV=1. Callers must therefore wrap calls in
 * `if (DEV_BUILD)` so the reference itself disappears; the early return
 * inside is belt-and-braces for the case where a bundler declines to fold.
 *
 * Why credentials survive by default. What needs retesting is onboarding's
 * shape, not OAuth. Sitting through the full ChatGPT sign-in on every reload
 * makes the loop slow enough that nobody actually runs it, so the default
 * snapshots the two credential-bearing storage keys, clears everything, and
 * writes them back — minus `onboardingComplete`, which is exactly the flag that
 * has to be absent for the overlay to appear. `keepCredentials: false` exists
 * for the times the sign-in path itself is what changed.
 *
 * Why the VFS goes too. MEMORY.md and the seeded skills live in IndexedDB, not
 * in chrome.storage. Clearing only chrome.storage would leave Luna's notes from
 * the previous run in place, so the next "first run" would silently start with
 * memory about a user it had supposedly never met — every later onboarding test
 * would be measuring the wrong thing.
 *
 * Runs in both the service worker and the side panel: `indexedDB` and
 * `chrome.storage.local` are available in each.
 */

import { debugLog } from './debug-log'

/** Compile-time constant. Guard every call site on this so Rollup can drop it. */
export const DEV_BUILD: boolean = __DEV_BUILD__

/** Settings blob holding `apiKey` / `apiKeys` — key mirrored from src/storage/settings.ts. */
const SETTINGS_KEY = 'settings'

/** ChatGPT OAuth token store — key mirrored from src/agent/openai-chatgpt-oauth.ts. */
const CHATGPT_TOKENS_KEY = 'openai_chatgpt_oauth_tokens'

const CREDENTIAL_KEYS = [SETTINGS_KEY, CHATGPT_TOKENS_KEY] as const

/** Stamped after a reset so it is obvious in storage which run is a fresh one. */
const MARKER_KEY = 'devFreshStartAt'

/** VFS database name — mirrored from src/storage/vfs.ts. */
const VFS_DB_NAME = 'handoff-vfs'

/** How long a blocked delete is given to land before the reset moves on. */
const BLOCKED_GRACE_MS = 1_500

type DeleteOutcome = 'deleted' | 'blocked' | 'error'

/**
 * `deleteDatabase` never resolves while another context still holds an open
 * connection (a second panel, the artifact viewer), and it reports that as
 * `onblocked` rather than an error. Waiting forever would wedge the reset with
 * no output at all, so a blocked delete gets a short grace period — the close
 * usually happens inside it and `onsuccess` still wins — and then gives up.
 */
function deleteVfsDatabase(): Promise<DeleteOutcome> {
  return new Promise<DeleteOutcome>((resolve) => {
    let settled = false
    const finish = (outcome: DeleteOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    const req = indexedDB.deleteDatabase(VFS_DB_NAME)
    req.onsuccess = () => finish('deleted')
    req.onerror = () => finish('error')
    req.onblocked = () => setTimeout(() => finish('blocked'), BLOCKED_GRACE_MS)
  })
}

/** Drop `onboardingComplete` but keep the keys/provider/model the blob carries. */
function withoutOnboardingFlag(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const next: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  delete next.onboardingComplete
  return next
}

export async function devFreshReset(opts: { keepCredentials: boolean }): Promise<void> {
  if (!DEV_BUILD) return

  const kept: Record<string, unknown> = {}
  if (opts.keepCredentials) {
    const snapshot = await chrome.storage.local.get([...CREDENTIAL_KEYS])
    for (const key of CREDENTIAL_KEYS) {
      const value = snapshot[key]
      if (value === undefined) continue
      kept[key] = key === SETTINGS_KEY ? withoutOnboardingFlag(value) : value
    }
  }

  await chrome.storage.local.clear()
  const vfs = await deleteVfsDatabase()
  await chrome.storage.local.set({ ...kept, [MARKER_KEY]: Date.now() })

  const restored = Object.keys(kept)
  const summary =
    `[dev] fresh start — chrome.storage.local cleared, VFS db "${VFS_DB_NAME}" ${vfs}, ` +
    (opts.keepCredentials
      ? `credentials kept (${restored.length > 0 ? restored.join(', ') : 'none were set'}), onboardingComplete stripped`
      : 'credentials WIPED, sign-in required again')
  debugLog.log('storage', summary)
  console.info(summary)
}
