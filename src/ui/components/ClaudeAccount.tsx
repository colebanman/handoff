import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  CLAUDE_AUTH_STORAGE_KEY,
  getClaudeAccountStatus,
  signInClaude,
  signOutClaude,
  submitClaudeAuthorizationCode,
  type ClaudeAccountStatus,
} from '../../agent/anthropic-oauth'
import { ClaudeAccountFlow, focusClaudeSignInTab } from './claude-account-flow'

export function ClaudeAccount({
  onConnected,
  onDisconnected,
  variant = 'settings',
}: {
  onConnected?: (status: ClaudeAccountStatus) => void | Promise<void>
  onDisconnected?: () => void | Promise<void>
  variant?: 'settings' | 'onboarding'
}): React.ReactElement {
  const [code, setCode] = useState('')
  const callbacks = useRef({ onConnected, onDisconnected })
  callbacks.current = { onConnected, onDisconnected }
  const flowRef = useRef<ClaudeAccountFlow | null>(null)
  if (!flowRef.current) {
    flowRef.current = new ClaudeAccountFlow({
      getStatus: getClaudeAccountStatus,
      signIn: signInClaude,
      signOut: signOutClaude,
      onConnected: (status) => callbacks.current.onConnected?.(status),
      onDisconnected: () => callbacks.current.onDisconnected?.(),
    })
  }
  const flow = flowRef.current
  const view = useSyncExternalStore(flow.subscribe, flow.snapshot)
  const { status, phase, authTabId, error } = view
  const busy = phase !== 'idle'
  const className = `oauth-device${variant === 'onboarding' ? ' oauth-device--onboarding' : ''}`

  useEffect(() => {
    flow.activate()
    void flow.refresh()
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area === 'local' && CLAUDE_AUTH_STORAGE_KEY in changes) void flow.refresh()
    }
    chrome.storage.onChanged.addListener(changed)
    return () => {
      flow.dispose()
      chrome.storage.onChanged.removeListener(changed)
    }
  }, [flow])

  const start = (method?: 'copy-code'): void => {
    setCode('')
    void flow.start(method)
  }

  const cancel = (): void => {
    setCode('')
    flow.cancel()
  }

  const openPage = async (): Promise<void> => {
    if (authTabId === undefined) return
    const currentView = flow.snapshot()
    try {
      await focusClaudeSignInTab(authTabId)
    } catch {
      if (flow.snapshot() === currentView) flow.setError('Could not open the Claude sign-in tab. Cancel and sign in again.')
    }
  }

  const submit = (): void => {
    try {
      if (!submitClaudeAuthorizationCode(code.trim())) {
        flow.setError('Paste the full authorization code or callback URL from this sign-in attempt.')
      } else {
        setCode(''); flow.setError(undefined)
      }
    } catch (err) {
      flow.setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (status === null) {
    return <div className={className} aria-live="polite"><span className="oauth-status">Checking Claude session…</span></div>
  }

  if (status.connected || phase === 'disconnecting') {
    return (
      <div className={className}>
        <div className="oauth-account">
          <div>
            <span className="oauth-status oauth-status--ok">Connected to Claude</span>
            {status.email ? <p className="field__hint">{status.email}</p> : null}
          </div>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void flow.disconnect()}>{phase === 'disconnecting' ? 'Disconnecting…' : 'Disconnect'}</button>
        </div>
        {error ? <p className="oauth-error" role="alert">{error}</p> : null}
      </div>
    )
  }

  return (
    <div className={className}>
      {busy ? (
        <>
          <div className="oauth-row" aria-live="polite">
            <span className="oauth-status">{phase === 'exchanging-token' ? 'Connecting your Claude account…' : phase === 'opening-browser' ? 'Opening Claude sign-in…' : 'Finish signing in in the Claude tab…'}</span>
            {phase === 'waiting-browser' && authTabId !== undefined ? <button type="button" className="btn btn--ghost" onClick={() => void openPage()}>Open page</button> : null}
            <button type="button" className="btn btn--ghost" onClick={cancel}>Cancel</button>
          </div>
          {phase === 'waiting-browser' ? <>
          <label className="field">
            <span className="field__label">Authorization code or callback URL</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
              placeholder="Paste here if sign-in does not return automatically"
            />
          </label>
          <button type="button" className="btn btn--ghost" disabled={!code.trim()} onClick={submit}>Complete sign-in</button>
          </> : null}
        </>
      ) : (
        <>
          <button type="button" className="btn btn--primary oauth-device__primary" onClick={() => start()}>
            {variant === 'onboarding' ? 'Continue with Claude' : 'Sign in with Claude'}
          </button>
          <p className="field__hint">Uses your Claude subscription and its usage limits.</p>
          <button type="button" className="btn btn--ghost" onClick={() => start('copy-code')}>Use a sign-in code instead</button>
        </>
      )}
      {error ? <p className="oauth-error" role="alert">{error}</p> : null}
    </div>
  )
}
