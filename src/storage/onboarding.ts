/**
 * chrome.storage.local persistence for the first-run "Luna pass" — the one-off
 * background call that seeds /workspace/MEMORY.md and the starter prompts right
 * after ChatGPT OAuth.
 *
 * Why persist at all: the pass costs a model call over the user's whole Chrome
 * history and must happen exactly once per install. The record is what makes
 * `startOnboardingSetup()` idempotent across side-panel reloads, and it is
 * where the generated starter prompts live — the empty-chat chips have to
 * survive a panel close, since the panel is closed most of the time.
 *
 * Why `running` is downgraded to `failed` on load: nothing resumes a pass. The
 * agent runtime lives in the side panel and dies with it, so a persisted
 * `running` can only mean the panel was closed or the extension reloaded
 * mid-pass — the model call is gone and no one will ever finish that record.
 * The composer's "still configuring…" gate keys off `running`, so trusting it
 * at startup would disable the composer permanently. A downgrade both unlocks
 * the UI and leaves the door open for a fresh attempt.
 */
import type { OnboardingSetupRecord, OnboardingSetupStatus } from '../shared/types'
import { debugLog } from '../shared/debug-log'

const KEY = 'onboardingSetup'

/** Matches the 3-4 prompts Luna is asked for, with headroom for a chatty model. */
const MAX_STARTER_PROMPTS = 6

/** Reason stamped on a `running` record found at load time (panel closed mid-pass). */
const INTERRUPTED_ERROR = 'interrupted before it finished'

export async function loadOnboardingSetup(): Promise<OnboardingSetupRecord> {
  try {
    const out = await chrome.storage.local.get(KEY)
    return recoverInterrupted(normalizeOnboardingSetup(out[KEY] as Partial<OnboardingSetupRecord> | undefined))
  } catch (err) {
    debugLog.error('storage', 'loadOnboardingSetup', err)
    return defaultOnboardingSetup()
  }
}

export async function saveOnboardingSetup(record: OnboardingSetupRecord): Promise<void> {
  const next = normalizeOnboardingSetup(record)
  await chrome.storage.local.set({ [KEY]: next })
  debugLog.log('storage', `onboarding setup saved (status=${next.status}, prompts=${next.starterPrompts.length})`)
}

/** Never attempted — also the safe answer for an unreadable record. */
export function defaultOnboardingSetup(): OnboardingSetupRecord {
  return { status: 'idle', starterPrompts: [] }
}

/**
 * Tolerant of anything on disk (older shapes, a hand-edited record, undefined):
 * this drives whether the composer is usable, so an unreadable record has to
 * degrade to "idle with no prompts" rather than throw.
 */
export function normalizeOnboardingSetup(record: Partial<OnboardingSetupRecord> | undefined): OnboardingSetupRecord {
  const base = defaultOnboardingSetup()
  if (!record || typeof record !== 'object') return base

  const starterPrompts = (Array.isArray(record.starterPrompts) ? record.starterPrompts : [])
    .map((prompt) => (typeof prompt === 'string' ? prompt.trim() : ''))
    .filter((prompt) => prompt.length > 0)
    .slice(0, MAX_STARTER_PROMPTS)

  const stored = record.status
  const status: OnboardingSetupStatus =
    stored === 'running' || stored === 'done' || stored === 'failed' ? stored : base.status

  return {
    status,
    starterPrompts,
    startedAt: typeof record.startedAt === 'number' ? record.startedAt : undefined,
    finishedAt: typeof record.finishedAt === 'number' ? record.finishedAt : undefined,
    error: typeof record.error === 'string' ? record.error.trim() || undefined : undefined,
  }
}

/**
 * Load-time repair, deliberately NOT part of the shape normalizer: `running` is
 * a legitimate thing to persist (that is how a reload learns a pass was already
 * attempted), it just can never still be live once we are reading it back.
 */
function recoverInterrupted(record: OnboardingSetupRecord): OnboardingSetupRecord {
  if (record.status !== 'running') return record
  debugLog.log('storage', 'onboarding setup was interrupted mid-pass; recorded as failed')
  return { ...record, status: 'failed', finishedAt: Date.now(), error: INTERRUPTED_ERROR }
}
