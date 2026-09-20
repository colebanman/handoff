/**
 * First-run onboarding: ChatGPT sign-in FIRST, then the walkthrough, then the
 * optional Grok key, then done.
 *
 * The order is dictated by timing, not by narrative. The Luna pass (one
 * background model call that seeds MEMORY.md and the starter prompts from the
 * user's own Chrome data) cannot start until an OpenAI credential exists, and
 * every screen after that point is latency we get for free — so sign-in happens
 * on the welcome screen and `markConnected` fires the pass the instant it lands.
 * The four walkthrough screens are the cover, and there is deliberately no
 * fast-forward past them: the pass needs the seconds, and a first run is the one
 * time the walkthrough is worth reading.
 *
 * Keys can still be pasted or — experimentally — generated against the provider
 * console's internal API using the browser session the user is already signed
 * into (see agent/key-provisioning.ts). Generate is best-effort; Paste is always
 * the fallback.
 */
import { useEffect, useState } from 'react'
import {
  connectChatGPTAccount,
  connectProviderKey,
  completeOnboarding,
  saveUserName,
  startOnboardingSetup,
  USER_NAME_MAX,
} from '../store'
import {
  checkLogin,
  generateKey,
  openLogin,
  providerLabel,
  OpenAiLoginRequiredError,
  type ProvisionProvider,
} from '../../agent/key-provisioning'
import { formatError } from '../../shared/errors'
import { debugLog } from '../../shared/debug-log'
import { ChatGPTAccount } from './ChatGPTAccount'

/** Providers with a dedicated connect screen after the walkthrough (OpenAI is on welcome). */
const CONNECT_PROVIDERS: ProvisionProvider[] = ['xai']

// Step layout: sign-in, walkthrough, one connect screen per provider, name, done.
type Step =
  | { kind: 'welcome' }
  | { kind: 'how'; index: number }
  | { kind: 'connect'; provider: ProvisionProvider }
  | { kind: 'name' }
  | { kind: 'done' }

const HOW_SCREENS = [
  {
    title: 'It drives your browser, not a copy of it',
    body: 'The agent works in your real tabs — already signed in, already where you left off. It reads the page, clicks, types, and navigates for you.',
  },
  {
    title: 'Ask in plain language',
    body: '“Summarize these tabs”, “fill this form”, “pull the prices into a file”. No scripts, no selectors — just say what you want done.',
  },
  {
    title: 'It remembers what matters',
    body: 'A few durable facts about you live in an ordinary file you can read or edit. Task details don’t get hoarded.',
  },
  {
    title: 'Long jobs run in the background',
    body: 'Hand long work to subagents, steer them mid-task, and find everything they make — files, notes, exports — in the file panel.',
  },
]

const STEPS: Step[] = [
  { kind: 'welcome' },
  ...HOW_SCREENS.map((_, index) => ({ kind: 'how' as const, index })),
  ...CONNECT_PROVIDERS.map((provider) => ({ kind: 'connect' as const, provider })),
  { kind: 'name' },
  { kind: 'done' },
]

/**
 * How long the optional provider screen holds its skip-forward button. Long
 * enough that someone leaning on Next has to register that the screen exists,
 * short enough that a user who read it and wants out barely waits. Must match
 * the sweep duration in theme.css (`--onb-hold-dur`).
 */
const SKIP_HOLD_MS = 1500

export function Onboarding(): React.ReactElement {
  const [stepIndex, setStepIndex] = useState(0)
  // Providers connected during this run, so the final screen can flag when none
  // were set up (you can't chat without a provider credential).
  const [connected, setConnected] = useState<Set<string>>(new Set())
  // The name lives here, not in ScreenName: the footer's forward button is the
  // submit control, and the screen remounts on every step change (keyed body).
  const [name, setName] = useState('')
  const [savingName, setSavingName] = useState(false)
  // Skip-forward held on the optional provider screen (see SKIP_HOLD_MS).
  const [skipHeld, setSkipHeld] = useState(false)
  const step = STEPS[stepIndex]!
  const atIntro = step.kind === 'welcome' || step.kind === 'how'

  /**
   * Releases the hold armed by `goToStep`. Keyed on the step as well as the flag
   * so re-entering the screen restarts the full wait; the cleanup covers both a
   * step change and unmount, so nothing setStates into a dead component.
   */
  useEffect(() => {
    if (!skipHeld) return
    const id = window.setTimeout(() => setSkipHeld(false), SKIP_HOLD_MS)
    return () => window.clearTimeout(id)
  }, [skipHeld, stepIndex])

  /**
   * Every navigation goes through here, and the hold is armed in the SAME commit
   * as the step change. Arming from an effect instead would leave the button live
   * for one frame — which is precisely the frame a spam-clicker is in — and
   * re-arming here (rather than once per mount) is what makes arriving via Back
   * earn the wait again.
   */
  const goToStep = (index: number): void => {
    const clamped = Math.min(Math.max(index, 0), STEPS.length - 1)
    setStepIndex(clamped)
    setSkipHeld(STEPS[clamped]!.kind === 'connect')
  }

  const next = (): void => goToStep(stepIndex + 1)
  const back = (): void => goToStep(stepIndex - 1)
  const finish = (): void => void completeOnboarding()
  const nameReady = name.trim().length > 0

  /**
   * Advance off the name screen. `saveUserName` swallows its own memory-write
   * failure, but a settings write can still reject — and a user who told us
   * their name must not be trapped on the second-to-last screen because storage
   * hiccuped, so we log and move on either way.
   */
  const submitName = async (): Promise<void> => {
    if (!nameReady || savingName) return
    setSavingName(true)
    try {
      await saveUserName(name)
    } catch (err) {
      debugLog.error('ui', 'onboarding saveUserName', err)
    } finally {
      setSavingName(false)
    }
    next()
  }
  /**
   * Single place the Luna pass is triggered. Any OpenAI credential will do — the
   * pass is a GPT prompt, not a subscription feature — and hanging it off
   * "connected" rather than off one specific button means the key and paste paths
   * get it too. Idempotent, so the ChatGPT card firing `onConnected` again from
   * its mount effect is harmless.
   */
  const markConnected = (provider: ProvisionProvider): void => {
    setConnected((prev) => new Set(prev).add(provider))
    if (provider === 'openai') startOnboardingSetup()
  }

  const progress = (
    <div className="onb__dots" aria-hidden="true">
      {STEPS.slice(0, -1).map((_, i) => (
        <span key={i} className={`onb__dot${i === stepIndex ? ' onb__dot--active' : ''}`} />
      ))}
    </div>
  )

  return (
    <div className="onb-scrim">
      <div className="onb" role="dialog" aria-modal="true" aria-label="Set up Handoff">
        {/* Keyed on the step so every advance remounts the screen and replays
            its entrance — consecutive text screens share a component and would
            otherwise reconcile in place (no animation, a visible teleport). */}
        <div className="onb__body" key={stepIndex}>
          {step.kind === 'welcome' ? (
            <ScreenWelcome onDone={next} onConnected={markConnected} />
          ) : step.kind === 'how' ? (
            <ScreenText title={HOW_SCREENS[step.index]!.title} body={HOW_SCREENS[step.index]!.body} />
          ) : step.kind === 'connect' ? (
            <ConnectProvider key={step.provider} provider={step.provider} onDone={next} onConnected={markConnected} />
          ) : step.kind === 'name' ? (
            <ScreenName value={name} disabled={savingName} onChange={setName} onSubmit={submitName} />
          ) : (
            <ScreenDone hasKey={connected.size > 0} />
          )}
        </div>

        <div className="onb__footer">
          {stepIndex > 0 ? (
            <button className="btn btn--ghost" onClick={back}>
              Back
            </button>
          ) : (
            <span />
          )}
          {progress}
          {atIntro ? (
            <button className="btn btn--primary" onClick={next}>
              {stepIndex === 0
                ? // Sign-in lives on this screen, so acknowledge it once it lands.
                  connected.size > 0
                  ? 'Continue'
                  : 'Get started'
                : 'Next'}
            </button>
          ) : step.kind === 'connect' ? (
            // Held for SKIP_HOLD_MS on arrival. The screen's own Paste/Generate/
            // Continue controls stay live throughout — only the bail-out waits,
            // and the sweep under the label says so rather than leaving a button
            // that just refuses to click.
            <button
              className={`btn btn--ghost onb__hold${skipHeld ? ' onb__hold--armed' : ''}`}
              onClick={next}
              disabled={skipHeld}
              aria-label={skipHeld ? 'Skip for now — available in a moment' : 'Skip for now'}
            >
              Skip for now
              {skipHeld ? <span className="onb__hold-sweep" aria-hidden="true" /> : null}
            </button>
          ) : step.kind === 'name' ? (
            // Unskippable: no ghost bail-out here, and forward stays disabled
            // until they've typed something. Back is still available.
            <button
              className="btn btn--primary"
              onClick={() => void submitName()}
              disabled={!nameReady || savingName}
            >
              Continue
            </button>
          ) : (
            <button className="btn btn--primary" onClick={finish}>
              Start chatting
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---- intro screens ------------------------------------------------------- */

/**
 * Welcome + sign-in on one screen. ChatGPT is the primary path (it is what makes
 * the Luna pass — and therefore the seeded memory and starter prompts — possible);
 * the API-key path is a quiet link into the same ConnectProvider machinery the
 * other providers use, with its ChatGPT card suppressed since it lives above.
 */
function ScreenWelcome({
  onDone,
  onConnected,
}: {
  onDone: () => void
  onConnected: (provider: ProvisionProvider) => void
}): React.ReactElement {
  const [mode, setMode] = useState<'chatgpt' | 'key'>('chatgpt')

  if (mode === 'key') {
    return (
      <ConnectProvider
        provider="openai"
        keyOnly
        onDone={onDone}
        onConnected={onConnected}
        onBack={() => setMode('chatgpt')}
      />
    )
  }

  return (
    <div className="onb__screen">
      <div className="onb__mark">✦</div>
      <h1 className="onb__title">Welcome to Handoff</h1>
      <p className="onb__lead">
        An AI agent that lives in your side panel and can actually use your browser. Sign in and we’ll
        set it up around how you already browse.
      </p>
      <div className="onb__auth">
        <ChatGPTAccount
          variant="onboarding"
          onConnected={async () => {
            await connectChatGPTAccount()
            // onConnected → markConnected is what starts the Luna pass, for every
            // credential path at once; don't add a second trigger here.
            onConnected('openai')
          }}
        />
        <button className="onb__link" onClick={() => setMode('key')}>
          Use an API key instead
        </button>
      </div>
    </div>
  )
}

function ScreenText({ title, body }: { title: string; body: string }): React.ReactElement {
  return (
    <div className="onb__screen">
      <h1 className="onb__title">{title}</h1>
      <p className="onb__lead">{body}</p>
    </div>
  )
}

/**
 * The last thing we ask, and the only screen without an escape hatch. Two
 * things downstream depend on the answer — the empty-chat greeting and the
 * agent's memory — and an empty name makes both worse than not asking, so the
 * footer's forward button stays disabled until something is typed. It goes last
 * because by now the connection work is done: this is the one question that is
 * purely about them.
 */
function ScreenName({
  value,
  disabled,
  onChange,
  onSubmit,
}: {
  value: string
  /** Save in flight — don't let a second Enter double-submit. */
  disabled: boolean
  onChange: (value: string) => void
  onSubmit: () => Promise<void>
}): React.ReactElement {
  return (
    <div className="onb__screen">
      <div className="onb__mark">✦</div>
      <h1 className="onb__title">What should we call you?</h1>
      <p className="onb__lead">
        A first name or a nickname is plenty. It’s how we’ll greet you here, and the agent will
        remember it.
      </p>
      <input
        className="onb__input"
        type="text"
        value={value}
        autoFocus
        autoComplete="given-name"
        spellCheck={false}
        maxLength={USER_NAME_MAX}
        placeholder="Your name"
        aria-label="What should we call you?"
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          // Enter is the primary path on a one-field screen; stop the default so
          // it can't also trip the footer button that just took focus.
          e.preventDefault()
          void onSubmit()
        }}
      />
    </div>
  )
}

function ScreenDone({ hasKey }: { hasKey: boolean }): React.ReactElement {
  if (!hasKey) {
    return (
      <div className="onb__screen">
        <div className="onb__mark onb__mark--warn">!</div>
        <h1 className="onb__title">No provider connected yet</h1>
        <p className="onb__lead">
          You’ll need a ChatGPT account or provider API key to chat. You can connect one any time from
          Settings, or go Back to set one up now.
        </p>
      </div>
    )
  }
  return (
    <div className="onb__screen">
      <div className="onb__mark onb__mark--ok">✓</div>
      <h1 className="onb__title">You’re all set</h1>
      <p className="onb__lead">
        Change providers, keys, and models any time in Settings → Accounts &amp; keys.
      </p>
    </div>
  )
}

/* ---- connect a provider -------------------------------------------------- */

type GenState = 'idle' | 'checking' | 'needs-login' | 'creating' | 'error'

function ConnectProvider({
  provider,
  onDone,
  onConnected,
  keyOnly,
  onBack,
}: {
  provider: ProvisionProvider
  onDone: () => void
  onConnected: (provider: ProvisionProvider) => void
  /** Hide the ChatGPT card (the welcome screen already offers it above). */
  keyOnly?: boolean
  /** Return to the caller's own screen instead of the walkthrough's Back button. */
  onBack?: () => void
}): React.ReactElement {
  const label = providerLabel(provider)
  const [mode, setMode] = useState<'choose' | 'paste' | 'generate' | 'chatgpt'>('choose')
  const [pasteValue, setPasteValue] = useState('')
  const [gen, setGen] = useState<GenState>('idle')
  const [error, setError] = useState<string | undefined>()
  const [connected, setConnected] = useState(false)
  const [connectionKind, setConnectionKind] = useState<'key' | 'chatgpt'>('key')

  const placeholder = provider === 'xai' ? 'xai-…' : 'sk-…'

  const savePaste = async (): Promise<void> => {
    const trimmed = pasteValue.trim()
    if (!trimmed) return
    await connectProviderKey(provider, trimmed)
    onConnected(provider)
    setConnectionKind('key')
    setConnected(true)
  }

  const runGenerate = async (): Promise<void> => {
    setMode('generate')
    setError(undefined)
    setGen('checking')
    try {
      // xAI logs in via a cheap cookie probe. OpenAI has no such probe — its
      // token lives in a dashboard tab, so generateKey opens one in the
      // background automatically and throws OpenAiLoginRequiredError only if the
      // user genuinely isn't signed in.
      if (provider === 'xai' && !(await checkLogin('xai'))) {
        setGen('needs-login')
        return
      }
      setGen('creating')
      const key = await generateKey(provider)
      await connectProviderKey(provider, key)
      onConnected(provider)
      setConnectionKind('key')
      setConnected(true)
      setGen('idle')
    } catch (err) {
      if (err instanceof OpenAiLoginRequiredError) {
        setGen('needs-login')
        return
      }
      setError(formatError(err))
      setGen('error')
    }
  }

  const openConsoleLogin = (): void => void openLogin(provider)

  if (connected) {
    return (
      <div className="onb__screen">
        <ProviderMark provider={provider} />
        <h1 className="onb__title">{label} connected</h1>
        <p className="onb__lead">
          {connectionKind === 'chatgpt'
            ? 'Your ChatGPT subscription is connected. You’re ready to use the models available to your account.'
            : `Your key is saved in the extension. You’re ready to use ${label} models.`}
        </p>
        <button className="btn btn--primary onb__cta" onClick={onDone}>
          Continue
        </button>
      </div>
    )
  }

  return (
    <div className="onb__screen">
      <ProviderMark provider={provider} />
      <h1 className="onb__title">Connect {label}</h1>

      {mode === 'choose' ? (
        <>
          <p className="onb__lead">
            {provider === 'openai'
              ? keyOnly
                ? 'Connect an OpenAI Platform API key for usage-based billing. Paste one you already have, or let the extension generate one for you.'
                : 'Use your ChatGPT subscription, or connect an OpenAI Platform API key for usage-based billing.'
              : `Optional: add your ${label} key to run Grok models too. Paste one you already have, or let the extension generate one for you.`}
          </p>
          <div className="onb__cards">
            {provider === 'openai' && !keyOnly ? (
              <button className="onb-card" onClick={() => setMode('chatgpt')}>
                <ChatBubbleIcon />
                <span className="onb-card__title">Sign in with ChatGPT</span>
                <span className="onb-card__desc">Use your subscription and workspace models</span>
              </button>
            ) : null}
            <button className="onb-card" onClick={() => setMode('paste')}>
              <ClipboardIcon />
              <span className="onb-card__title">Paste key</span>
              <span className="onb-card__desc">Use an existing API key</span>
            </button>
            <button className="onb-card" onClick={runGenerate}>
              <WandIcon />
              <span className="onb-card__title">
                Generate key <span className="onb-card__chip">Experimental</span>
              </span>
              <span className="onb-card__desc">Mint one from your signed-in console</span>
            </button>
          </div>
          {onBack ? (
            <button className="onb__link" onClick={onBack}>
              Sign in with ChatGPT instead
            </button>
          ) : null}
        </>
      ) : mode === 'paste' ? (
        <>
          <p className="onb__lead">Paste your {label} API key. It’s kept in the extension’s local storage.</p>
          <input
            className="onb__input"
            type="password"
            value={pasteValue}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            onChange={(e) => setPasteValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void savePaste()
            }}
          />
          <div className="onb__row">
            <button className="btn btn--ghost" onClick={() => setMode('choose')}>
              Back
            </button>
            <button className="btn btn--primary" disabled={!pasteValue.trim()} onClick={() => void savePaste()}>
              Save key
            </button>
          </div>
        </>
      ) : mode === 'chatgpt' ? (
        <div className="onb__auth">
          <p className="onb__lead">Use your ChatGPT subscription and the models available to your account.</p>
          <ChatGPTAccount
            variant="onboarding"
            onConnected={async () => {
              await connectChatGPTAccount()
              onConnected(provider)
              setConnectionKind('chatgpt')
              setConnected(true)
            }}
          />
          <button className="onb__link" onClick={() => setMode('choose')}>
            Connect with an API key
          </button>
        </div>
      ) : (
        <GenerateStatus
          label={label}
          gen={gen}
          error={error}
          onOpenLogin={openConsoleLogin}
          onRetry={() => void runGenerate()}
          onPaste={() => {
            setMode('paste')
            setGen('idle')
            setError(undefined)
          }}
        />
      )}
    </div>
  )
}

function GenerateStatus({
  label,
  gen,
  error,
  onOpenLogin,
  onRetry,
  onPaste,
}: {
  label: string
  gen: GenState
  error: string | undefined
  onOpenLogin: () => void
  onRetry: () => void
  onPaste: () => void
}): React.ReactElement {
  if (gen === 'checking' || gen === 'creating') {
    return (
      <div className="onb__status">
        <span className="onb__spinner" />
        <span>{gen === 'checking' ? `Checking your ${label} account…` : `Creating your key…`}</span>
      </div>
    )
  }

  if (gen === 'needs-login') {
    return (
      <>
        <p className="onb__lead">
          Sign in to {label} in the tab we open, then come back and continue.
        </p>
        <div className="onb__row">
          <button className="btn btn--ghost" onClick={onOpenLogin}>
            Open {label} login
          </button>
          <button className="btn btn--primary" onClick={onRetry}>
            Continue
          </button>
        </div>
        <button className="onb__link" onClick={onPaste}>
          Paste a key instead
        </button>
      </>
    )
  }

  // error
  return (
    <>
      <p className="onb__error">{error ?? 'Something went wrong.'}</p>
      <div className="onb__row">
        <button className="btn btn--ghost" onClick={onRetry}>
          Try again
        </button>
        <button className="btn btn--primary" onClick={onPaste}>
          Paste a key instead
        </button>
      </div>
    </>
  )
}

/* ---- bits ---------------------------------------------------------------- */

function ProviderMark({ provider }: { provider: ProvisionProvider }): React.ReactElement {
  return <div className={`onb__provider onb__provider--${provider}`}>{provider === 'xai' ? 'x' : 'AI'}</div>
}

function ClipboardIcon(): React.ReactElement {
  return (
    <svg className="onb-card__icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="4" width="8" height="4" rx="1" />
      <path d="M8 6H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2" />
    </svg>
  )
}

function ChatBubbleIcon(): React.ReactElement {
  return (
    <svg className="onb-card__icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 15a3 3 0 0 1-3 3H9l-5 3v-6a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z" />
    </svg>
  )
}

function WandIcon(): React.ReactElement {
  return (
    <svg className="onb-card__icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 4V2M15 10V8M8.5 8.5 7 7M21.5 8.5 20 10M4 20l10-10 2 2L6 22z" />
      <path d="M20 15v2M20 21v-2M17.5 18.5H19M22.5 18.5H21" />
    </svg>
  )
}
