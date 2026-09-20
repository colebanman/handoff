/**
 * Settings modal over ONE local draft: every control edits local state and only
 * Save persists, so opening Settings can never disturb chats.
 *
 * Five groups, in the order people reach for them — Account, Behavior,
 * Prompt, Automations, Theme. Tab order lives in `settings-sections.ts`.
 *
 * Rules the body follows (DESIGN.md): one control per row, label left and
 * control right, at most one summary line per group, no explanatory paragraphs.
 * Anything that is rarely touched — request routing, the agent bridge, the
 * developer tools, the personalization re-scan — lives behind
 * that group's collapsed "Advanced" disclosure rather than in a tab of its own.
 *
 * Model CHOICE deliberately lives in the composer's model picker, not here.
 * Navigation is top tabs rather than a side rail because the side panel is
 * ~360px wide: a ~100px rail would leave key/URL inputs under 200px.
 */
import { useEffect, useState } from 'react'
import { AutomationsPanel } from './Automations'
import { BRIDGE_DEFAULT_PORT } from '../../shared/bridge-protocol'
import {
  isOpenAIModelId,
  CEREBRAS_DEFAULT_MODEL_ID,
  MODEL_OPTIONS,
  OPENAI_DEFAULT_MODEL_ID,
  STEP_CHECKPOINT,
  XAI_DEFAULT_MODEL_ID,
  type ActivityCursorMode,
  type ProviderKind,
  type Settings,
} from '../../shared/types'
import {
  checkLogin,
  generateKey,
  openLogin,
  providerLabel,
  OpenAiLoginRequiredError,
  type ProvisionProvider,
} from '../../agent/key-provisioning'
import { debugLog } from '../../shared/debug-log'
import { DEV_BUILD, devFreshReset } from '../../shared/dev-reset'
import { formatError } from '../../shared/errors'
import { openMemoryFile, replayOnboarding, rerunOnboardingSetup, useStore } from '../store'
import { SITE_MEMORY_PATH } from '../../agent/site-memory'
import { openStreamInspector as openInspectorWindow } from '../../shared/stream-inspector'
import { ChatGPTAccount } from './ChatGPTAccount'
import { activityCursorMode } from '../../storage/settings'
import {
  resolveSection,
  SETTINGS_SECTIONS,
  type SectionId,
} from './settings-sections'

export type { SectionId }

/** Copy for the pointer control (Theme). Order = least to most. */
const ACTIVITY_CURSOR_OPTIONS: ReadonlyArray<{ value: ActivityCursorMode; label: string }> = [
  { value: 'off', label: 'Never' },
  { value: 'actions', label: 'On clicks and typing' },
  { value: 'ambient', label: 'Always while working' },
]

/** How requests leave the extension. 'direct' = each model's own provider. */
type Routing = 'direct' | 'gateway' | 'openai-compatible'

/**
 * The direct provider the current default model belongs to (used for the
 * Active badge and to materialize Settings.provider when routing is direct).
 * Falls back to the previous direct provider for unrecognized custom ids.
 */
function directProviderFor(modelId: string, prev: ProviderKind): ProviderKind {
  const curated = MODEL_OPTIONS.find((m) => m.id === modelId)
  if (curated) return curated.provider
  if (isOpenAIModelId(modelId)) return 'openai'
  if (prev === 'openai' || prev === 'xai' || prev === 'cerebras') return prev
  return modelId.trim().toLowerCase().startsWith('grok') ? 'xai' : 'openai'
}

export function Settings({
  settings,
  onSave,
  onClose,
  onChatGPTConnectionChange,
  initialSection,
}: {
  settings: Settings
  initialSection?: string
  onSave: (next: Settings) => void | Promise<void>
  onClose: () => void
  onChatGPTConnectionChange: (connected: boolean) => void
}): React.ReactElement {
  const tabs = SETTINGS_SECTIONS
  const [section, setSection] = useState<SectionId>(() => resolveSection(initialSection))
  useEffect(() => setSection(resolveSection(initialSection)), [initialSection])
  // The re-run button gates on PERSISTED auth, not the unsaved form draft: the
  // pass reads whatever is actually stored, so offering it on a draft the user
  // hasn't saved would just produce a silent no-op.
  // Either OpenAI credential can run the pass; only the provider has to match.
  const canRunSetup = settings.provider === 'openai'
  const setupRunning = useStore().setup.status === 'running'
  const [routing, setRouting] = useState<Routing>(
    settings.provider === 'gateway' || settings.provider === 'openai-compatible'
      ? settings.provider
      : 'direct',
  )
  // Advanced starts open only when an alternate route is already active —
  // otherwise it stays out of the way.
  const [routingOpen, setRoutingOpen] = useState(
    settings.provider === 'gateway' || settings.provider === 'openai-compatible',
  )
  const [behaviorAdvanced, setBehaviorAdvanced] = useState(false)
  const [typeSafeEnabled, setTypeSafeEnabled] = useState(settings.typeSafeEnabled === true)
  const [typeSafeApiKey, setTypeSafeApiKey] = useState(settings.typeSafeApiKey ?? '')
  const [promptAdvanced, setPromptAdvanced] = useState(false)
  const [openaiAuthMode, setOpenaiAuthMode] = useState<'api-key' | 'chatgpt'>(
    settings.openaiAuthMode ?? 'api-key',
  )
  const [apiKeys, setApiKeys] = useState<Partial<Record<ProviderKind, string>>>(() => ({
    ...(settings.apiKey ? { [settings.provider]: settings.apiKey } : {}),
    ...settings.apiKeys,
  }))
  const [baseURL, setBaseURL] = useState(settings.baseURL ?? '')
  const [theme, setTheme] = useState<'dark' | 'light'>(settings.theme ?? 'dark')
  const [activityCursor, setActivityCursor] = useState<ActivityCursorMode>(() =>
    activityCursorMode(settings),
  )
  const [notifyOnLongTurn, setNotifyOnLongTurn] = useState(settings.notifyOnLongTurn !== false)
  const [pauseAtStepCheckpoints, setPauseAtStepCheckpoints] = useState(
    settings.pauseAtStepCheckpoints !== false,
  )
  const [suggestNextPrompt, setSuggestNextPrompt] = useState(settings.suggestNextPrompt !== false)
  const [bridgeEnabled, setBridgeEnabled] = useState(settings.bridgeEnabled !== false)
  const [bridgePort, setBridgePort] = useState(String(settings.bridgePort ?? BRIDGE_DEFAULT_PORT))
  const [customInstructions, setCustomInstructions] = useState(settings.customInstructions ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      if (!saving) onClose()
    }
    window.addEventListener('keydown', dismiss, true)
    return () => window.removeEventListener('keydown', dismiss, true)
  }, [onClose, saving])

  const setKey = (target: ProviderKind, value: string): void =>
    setApiKeys((prev) => ({ ...prev, [target]: value }))

  // The badge (and, when routing is direct, the persisted provider) follows
  // the current default model — the picker owns model choice, not this modal.
  const activeDirect = routing === 'direct' ? directProviderFor(settings.modelId, settings.provider) : undefined

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true); setSaveError('')
    const keys: Partial<Record<ProviderKind, string>> = {}
    for (const [k, v] of Object.entries(apiKeys)) {
      const trimmed = v?.trim()
      if (trimmed) keys[k as ProviderKind] = trimmed
    }
    const provider: ProviderKind =
      routing === 'direct' ? directProviderFor(settings.modelId, settings.provider) : routing
    // `saveSettings` REPLACES the stored settings rather than merging, so this
    // object must carry every field — including the ones this modal has no
    // control over. Building it from scratch silently dropped `userName` (the
    // greeting reverted) and `onboardingComplete` (onboarding reappeared) on any
    // Save. Spread first, then set every managed field EXPLICITLY, using
    // `undefined` for "absent" so a cleared field actually clears instead of the
    // spread resurrecting its old value.
    const next: Settings = {
      ...settings,
      provider,
      openaiAuthMode,
      apiKey: provider === 'openai' && openaiAuthMode === 'chatgpt' ? '' : (keys[provider] ?? ''),
      apiKeys: keys,
      // Model choice lives in the composer picker; this only re-normalizes
      // vendor prefixes when the ROUTE changed under the same model.
      modelId: resolveModelId(settings.modelId, provider),
      theme,
      activityCursor,
      typeSafeEnabled,
      typeSafeApiKey: typeSafeApiKey.trim() || undefined,
      notifyOnLongTurn,
      baseURL: routing === 'openai-compatible' && baseURL.trim() ? baseURL.trim() : undefined,
      customInstructions: customInstructions.trim() || undefined,
      // Opt-out only: store `false` when disabled, absent (= default ON) otherwise.
      pauseAtStepCheckpoints: pauseAtStepCheckpoints ? undefined : false,
      suggestNextPrompt: suggestNextPrompt ? undefined : false,
      bridgeEnabled: bridgeEnabled ? undefined : false,
      // normalizeSettings drops this again when it equals the default port.
      bridgePort: Number(bridgePort.trim()) || undefined,
    }
    try { await onSave(next); onClose() }
    catch (error) { setSaveError(`Could not save settings: ${formatError(error)}`) }
    finally { setSaving(false) }
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => !saving && e.target === e.currentTarget && onClose()}>
      <div className="modal modal--settings" role="dialog" aria-modal="true" aria-label="Settings">
        <h2 className="modal__title">Settings</h2>

        <div className="settings-nav" role="tablist" aria-label="Settings sections" inert={saving}>
          {tabs.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              id={`settings-tab-${s.id}`}
              aria-selected={section === s.id}
              // Only one tabpanel is mounted at a time; pointing an inactive
              // tab at an id that isn't in the DOM is an ARIA violation.
              aria-controls={section === s.id ? `settings-panel-${s.id}` : undefined}
              className={`settings-nav__tab${section === s.id ? ' settings-nav__tab--active' : ''}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div
          className="settings-body"
          inert={saving}
          role="tabpanel"
          id={`settings-panel-${section}`}
          aria-labelledby={`settings-tab-${section}`}
        >
          {section === 'account' ? (
            <>
              <p className="settings-summary">
                Each model talks directly to its own provider. Pick the model in the message box.
              </p>

              <CredentialGroup name="OpenAI" active={activeDirect === 'openai'}>
                <Row label="Sign in with">
                  <select
                    aria-label="OpenAI authentication"
                    value={openaiAuthMode}
                    onChange={(e) => setOpenaiAuthMode(e.target.value as 'api-key' | 'chatgpt')}
                  >
                    <option value="chatgpt">ChatGPT subscription</option>
                    <option value="api-key">API key</option>
                  </select>
                </Row>
                {openaiAuthMode === 'chatgpt' ? (
                  <div className="field">
                    <ChatGPTAccount
                      onConnected={() => onChatGPTConnectionChange(true)}
                      onDisconnected={() => onChatGPTConnectionChange(false)}
                    />
                  </div>
                ) : (
                  <KeyField
                    label="OpenAI API key"
                    placeholder="sk-…"
                    value={apiKeys.openai ?? ''}
                    onChange={(v) => setKey('openai', v)}
                    provision="openai"
                  />
                )}
              </CredentialGroup>

              <CredentialGroup name="xAI (Grok)" active={activeDirect === 'xai'}>
                <KeyField
                  label="xAI API key"
                  placeholder="xai-…"
                  value={apiKeys.xai ?? ''}
                  onChange={(v) => setKey('xai', v)}
                  provision="xai"
                />
              </CredentialGroup>

              <CredentialGroup name="Cerebras" active={activeDirect === 'cerebras'}>
                <KeyField
                  label="Cerebras API key"
                  placeholder="csk-…"
                  value={apiKeys.cerebras ?? ''}
                  onChange={(v) => setKey('cerebras', v)}
                />
              </CredentialGroup>

              {DEV_BUILD ? (
                <Advanced
                  label="Request routing"
                  badge={routing !== 'direct' ? 'Active' : undefined}
                  open={routingOpen}
                  onToggle={() => setRoutingOpen((o) => !o)}
                >
                  <Row label="Send requests">
                    <select
                      aria-label="Send requests"
                      value={routing}
                      onChange={(e) => setRouting(e.target.value as Routing)}
                    >
                      <option value="direct">Directly to each provider</option>
                      <option value="gateway">Vercel AI Gateway</option>
                      <option value="openai-compatible">OpenAI-compatible endpoint</option>
                    </select>
                  </Row>
                  {routing === 'gateway' ? (
                    <KeyField
                      label="Gateway API key"
                      placeholder="vck_…"
                      value={apiKeys.gateway ?? ''}
                      onChange={(v) => setKey('gateway', v)}
                    />
                  ) : null}
                  {routing === 'openai-compatible' ? (
                    <>
                      <KeyField
                        label="Endpoint API key"
                        placeholder="sk-…"
                        value={apiKeys['openai-compatible'] ?? ''}
                        onChange={(v) => setKey('openai-compatible', v)}
                      />
                      <label className="field">
                        <span className="field__label">Base URL</span>
                        <input
                          type="text"
                          value={baseURL}
                          spellCheck={false}
                          placeholder="https://host/v1"
                          onChange={(e) => setBaseURL(e.target.value)}
                        />
                      </label>
                    </>
                  ) : null}
                  {routing !== 'direct' ? (
                    <p className="settings-summary">
                      While this is on, every request uses this route — the accounts above are not
                      contacted.
                    </p>
                  ) : null}
                </Advanced>
              ) : null}
            </>
          ) : section === 'behavior' ? (
            <>
              <CheckRow
                label="Notify me when a long turn finishes"
                checked={notifyOnLongTurn}
                onChange={setNotifyOnLongTurn}
              />
              <CheckRow
                label={`Ask before continuing past ${STEP_CHECKPOINT} steps`}
                checked={pauseAtStepCheckpoints}
                onChange={setPauseAtStepCheckpoints}
              />
              <CheckRow
                label="Suggest my next message"
                hint="One extra call to a cheap model per finished turn."
                checked={suggestNextPrompt}
                onChange={setSuggestNextPrompt}
              />

              <Advanced
                label="Advanced"
                open={behaviorAdvanced}
                onToggle={() => setBehaviorAdvanced((o) => !o)}
              >
                <CheckRow
                  label="TypeSafe (experimental)"
                  hint="Find relevant skills, run familiar read-only functions, and check extracted facts."
                  checked={typeSafeEnabled}
                  onChange={setTypeSafeEnabled}
                />
                <label className="field">
                  <span className="field__label">TypeSafe API key</span>
                  <input type="password" autoComplete="off" spellCheck={false}
                    value={typeSafeApiKey} placeholder="Paste your TypeSafe API key"
                    onChange={(e) => setTypeSafeApiKey(e.target.value)} />
                </label>
                <p className="settings-summary">
                  When enabled, task context, saved guidance and preferences, and source excerpts are sent to TypeSafe.
                  Uses separate API billing. Changes apply to new turns.
                </p>
                <CheckRow
                  label="Let local coding agents open chats here"
                  checked={bridgeEnabled}
                  onChange={setBridgeEnabled}
                />
                {bridgeEnabled ? (
                  <Row label="Bridge port">
                    <input
                      className="settings-row__input"
                      type="text"
                      inputMode="numeric"
                      aria-label="Bridge port"
                      value={bridgePort}
                      placeholder={String(BRIDGE_DEFAULT_PORT)}
                      onChange={(e) => setBridgePort(e.target.value)}
                    />
                  </Row>
                ) : null}

                {/* Diagnostics and destructive test controls are compiled out
                    of product builds rather than merely disabled at runtime. */}
                {DEV_BUILD ? (
                  <>
                    <Row label="Stream inspector">
                      <button type="button" className="btn btn--ghost" onClick={openStreamInspector}>
                        Open
                      </button>
                    </Row>
                    <Row label="Welcome tour">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => {
                          replayOnboarding()
                          onClose()
                        }}
                      >
                        Replay
                      </button>
                    </Row>
                    <Row label="Reset" hint="Reset clears chats, settings, memory, and files but keeps sign-in.">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => void runFreshReset(true)}
                      >
                        Reset
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => void runFreshReset(false)}
                      >
                        Full wipe
                      </button>
                    </Row>
                  </>
                ) : null}
              </Advanced>
            </>
          ) : section === 'automations' ? (
            <AutomationsPanel onClose={onClose} />
          ) : section === 'instructions' ? (
            <>
              <p className="settings-summary">
                Applied to every chat and subagent, including new ones.
              </p>
              <label className="field">
                <span className="field__label">Custom instructions</span>
                <textarea
                  value={customInstructions}
                  rows={7}
                  spellCheck={false}
                  placeholder={'e.g. "Keep answers brief. Never submit or post anything without asking me first."'}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                />
              </label>

              {/* Memory is a plain file, so "manage it" is just "open it" — no
                  editor here, and nothing to Save (these bypass the draft). */}
              <Row
                label="Memory"
                hint="MEMORY.md is always in context; SITES.md only on matching pages."
              >
                <button type="button" className="btn btn--ghost" onClick={() => openMemoryFile()}>
                  MEMORY.md
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => openMemoryFile(SITE_MEMORY_PATH)}
                >
                  SITES.md
                </button>
              </Row>

              {/* OpenAI-only: this pass uses the user's own Chrome data and
                  upserts memory by title instead of duplicating it. */}
              {canRunSetup ? (
                <Advanced
                  label="Advanced"
                  open={promptAdvanced}
                  onToggle={() => setPromptAdvanced((o) => !o)}
                >
                  <Row
                    label="Refresh memory from browser"
                    hint="Re-reads history and bookmarks. Does not reopen the welcome tour."
                  >
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={setupRunning}
                      onClick={rerunOnboardingSetup}
                    >
                      {setupRunning ? 'Scanning…' : 'Refresh'}
                    </button>
                  </Row>
                </Advanced>
              ) : null}
            </>
          ) : section === 'appearance' ? (
            <>
              <Row label="Theme">
                <select
                  aria-label="Theme"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as 'dark' | 'light')}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </Row>
              <Row label="Show the agent's pointer">
                <select
                  aria-label="Show the agent's pointer"
                  value={activityCursor}
                  onChange={(e) => setActivityCursor(e.target.value as ActivityCursorMode)}
                >
                  {ACTIVITY_CURSOR_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Row>
            </>
          ) : null}
        </div>

        {saveError && <p role="alert">{saveError}</p>}
        <div className="modal__actions">
          <button className="btn btn--ghost" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---- row primitives ------------------------------------------------------ */

/** One control per row: label (and at most one hint line) left, control right. */
function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="settings-row">
      <span className="settings-row__label">{label}</span>
      <span className="settings-row__control">{children}</span>
      {hint ? <p className="settings-row__hint">{hint}</p> : null}
    </div>
  )
}

/** A Row whose control is a checkbox; the whole row is the label's hit area. */
function CheckRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}): React.ReactElement {
  return (
    <label className={`settings-row${disabled ? ' settings-row--disabled' : ''}`}>
      <span className="settings-row__label">{label}</span>
      <span className="settings-row__control">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      </span>
      {hint ? <p className="settings-row__hint">{hint}</p> : null}
    </label>
  )
}

/** Collapsed disclosure for the rarely-touched tail of a group. */
function Advanced({
  label,
  badge,
  open,
  onToggle,
  children,
}: {
  label: string
  badge?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="settings-adv">
      <button type="button" className="settings-adv-toggle" aria-expanded={open} onClick={onToggle}>
        <span
          className={`settings-adv-toggle__chev${open ? ' settings-adv-toggle__chev--open' : ''}`}
          aria-hidden="true"
        >
          ▸
        </span>
        <span className="settings-cred__name">{label}</span>
        {badge ? <span className="settings-cred__badge">{badge}</span> : null}
      </button>
      {open ? <div className="settings-adv__body">{children}</div> : null}
    </section>
  )
}

/**
 * Dev build only. Reload rather than patching state back: the store caches
 * settings, chats and the VFS handle, and nothing in it expects storage to
 * vanish underneath it — a fresh page is the only honest first run.
 */
async function runFreshReset(keepCredentials: boolean): Promise<void> {
  try {
    await devFreshReset({ keepCredentials })
  } catch (err) {
    debugLog.error('storage', 'devFreshReset', err)
  }
  location.reload()
}

/** A popup window, not a tab: the inspector is meant to sit beside the panel. */
function openStreamInspector(): void {
  // Explicit click: focus it, and reuse the window if one is already open.
  void openInspectorWindow({ focus: true })
}

/**
 * If the provider changed under a curated model of another vendor (e.g. moving
 * to xAI while the model is still gpt-5.5), swap to that provider's default
 * model instead of sending a foreign id; otherwise apply the provider's usual
 * prefix rules.
 */
function resolveModelId(modelId: string, provider: ProviderKind): string {
  const curated = MODEL_OPTIONS.find((m) => m.id === modelId)
  if (
    curated &&
    (provider === 'openai' || provider === 'xai' || provider === 'cerebras') &&
    curated.provider !== provider
  ) {
    if (provider === 'xai') return XAI_DEFAULT_MODEL_ID
    if (provider === 'cerebras') return CEREBRAS_DEFAULT_MODEL_ID
    return OPENAI_DEFAULT_MODEL_ID
  }
  if (provider === 'gateway') {
    if (modelId.includes('/')) return modelId
    return modelId.startsWith('grok') ? `xai/${modelId}` : `openai/${modelId}`
  }
  if (provider === 'openai' || provider === 'openai-compatible') {
    return modelId.startsWith('openai/') ? modelId.slice('openai/'.length) : modelId
  }
  if (provider === 'xai') {
    return modelId.startsWith('xai/') ? modelId.slice('xai/'.length) : modelId
  }
  if (provider === 'cerebras') return modelId.replace(/^cerebras\//, '')
  return modelId
}

/* ---- accounts & keys ----------------------------------------------------- */

/** One provider's credential block; "Active" marks the provider chats use. */
function CredentialGroup({
  name,
  active,
  children,
}: {
  name: string
  active: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="settings-cred">
      <header className="settings-cred__head">
        <span className="settings-cred__name">{name}</span>
        {active ? <span className="settings-cred__badge">Active</span> : null}
      </header>
      {children}
    </section>
  )
}

type GenState = 'idle' | 'checking' | 'creating' | 'needs-login' | 'done' | 'error'

/**
 * Password field for one provider key, with the optional console mint for the
 * providers key-provisioning supports. A generated key lands in the parent's
 * draft exactly like a pasted one — Save is still what persists it.
 */
function KeyField({
  label,
  placeholder,
  value,
  onChange,
  provision,
}: {
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  provision?: ProvisionProvider
}): React.ReactElement {
  const [gen, setGen] = useState<GenState>('idle')
  const [error, setError] = useState<string | undefined>()
  const busy = gen === 'checking' || gen === 'creating'

  const runGenerate = async (): Promise<void> => {
    if (!provision) return
    setError(undefined)
    setGen('checking')
    try {
      // xAI login is a cheap cookie probe. OpenAI has no such probe — its token
      // lives in a dashboard tab that generateKey opens itself, throwing
      // OpenAiLoginRequiredError only when the user really isn't signed in.
      if (provision === 'xai' && !(await checkLogin('xai'))) {
        setGen('needs-login')
        return
      }
      setGen('creating')
      onChange(await generateKey(provision))
      setGen('done')
    } catch (err) {
      if (err instanceof OpenAiLoginRequiredError) {
        setGen('needs-login')
        return
      }
      setError(formatError(err))
      setGen('error')
    }
  }

  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="settings-key">
        <input
          className="settings-key__input"
          type="password"
          value={value}
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {provision ? (
          <button
            type="button"
            className="btn btn--ghost settings-key__gen"
            disabled={busy}
            title={`Mint a new key from your signed-in ${providerLabel(provision)} console`}
            onClick={() => void runGenerate()}
          >
            Generate
          </button>
        ) : null}
      </div>
      {provision && gen !== 'idle' ? (
        <GenerateState
          state={gen}
          error={error}
          provider={provision}
          onRetry={() => void runGenerate()}
        />
      ) : null}
    </div>
  )
}

function GenerateState({
  state,
  error,
  provider,
  onRetry,
}: {
  state: GenState
  error: string | undefined
  provider: ProvisionProvider
  onRetry: () => void
}): React.ReactElement | null {
  const label = providerLabel(provider)

  if (state === 'checking' || state === 'creating') {
    return (
      <p className="settings-key__status">
        <span className="settings-key__spinner" />
        {state === 'checking' ? `Checking your ${label} account…` : 'Creating your key…'}
      </p>
    )
  }

  if (state === 'done') {
    return (
      <p className="settings-key__status settings-key__status--ok">
        New key generated — choose Save to keep it.
      </p>
    )
  }

  if (state === 'needs-login') {
    return (
      <div className="settings-key__status settings-key__status--stack">
        <span>Sign in to {label} in the tab we open, then continue.</span>
        <span className="oauth-row">
          <button type="button" className="btn btn--ghost" onClick={() => void openLogin(provider)}>
            Open {label} login
          </button>
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            Continue
          </button>
        </span>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="settings-key__status settings-key__status--stack">
        <span className="oauth-error">{error ?? 'Something went wrong.'}</span>
        <span className="oauth-row">
          <button type="button" className="btn btn--ghost" onClick={onRetry}>
            Try again
          </button>
        </span>
      </div>
    )
  }

  return null
}
