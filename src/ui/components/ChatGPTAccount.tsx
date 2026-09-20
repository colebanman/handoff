import { useEffect, useRef, useState } from 'react'
import {
  completeChatGPTDeviceLogin,
  connectChatGPTInBrowser,
  disconnectChatGPT,
  getChatGPTAccountStatus,
  requestChatGPTDeviceCode,
  type ChatGPTAccountStatus,
  type ChatGPTDeviceCode,
} from '../../agent/openai-chatgpt-oauth'

export function ChatGPTAccount({
  onConnected,
  onDisconnected,
  variant = 'settings',
}: {
  onConnected?: (status: ChatGPTAccountStatus) => void | Promise<void>
  onDisconnected?: () => void | Promise<void>
  variant?: 'settings' | 'onboarding'
}): React.ReactElement {
  const [status, setStatus] = useState<ChatGPTAccountStatus | null>(null)
  const [device, setDevice] = useState<ChatGPTDeviceCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const deviceClassName = `oauth-device${variant === 'onboarding' ? ' oauth-device--onboarding' : ''}`

  useEffect(() => {
    let mounted = true
    getChatGPTAccountStatus()
      .then((next) => {
        if (!mounted) return
        setStatus(next)
        if (next.connected) void onConnected?.(next)
      })
      .catch(() => mounted && setStatus({ connected: false }))
    return () => {
      mounted = false
      controller.current?.abort()
    }
  }, [])

  const finishConnect = async (
    nextStatus: ChatGPTAccountStatus,
    nextController: AbortController,
  ): Promise<void> => {
    if (nextController.signal.aborted) return
    await onConnected?.(nextStatus)
    setStatus(nextStatus)
    setDevice(null)
  }

  const startBrowserConnect = async (): Promise<void> => {
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    setBusy(true)
    setError(null)
    try {
      const nextStatus = await connectChatGPTInBrowser(nextController.signal)
      await finishConnect(nextStatus, nextController)
    } catch (err) {
      if (!nextController.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (!nextController.signal.aborted) setBusy(false)
      if (controller.current === nextController) controller.current = null
    }
  }

  const startDeviceConnect = async (): Promise<void> => {
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    setBusy(true)
    setError(null)
    try {
      const nextDevice = await requestChatGPTDeviceCode()
      if (nextController.signal.aborted) return
      setDevice(nextDevice)
      await chrome.tabs.create({ url: nextDevice.verificationUrl, active: true })
      const nextStatus = await completeChatGPTDeviceLogin(nextDevice, nextController.signal)
      await finishConnect(nextStatus, nextController)
    } catch (err) {
      if (!nextController.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (!nextController.signal.aborted) setBusy(false)
      if (controller.current === nextController) controller.current = null
    }
  }

  const cancelConnect = (): void => {
    controller.current?.abort()
    controller.current = null
    setDevice(null)
    setBusy(false)
    setError(null)
  }

  const remove = async (): Promise<void> => {
    cancelConnect()
    await disconnectChatGPT()
    await onDisconnected?.()
    setStatus({ connected: false })
  }

  const openDevicePage = (): void => {
    if (device) void chrome.tabs.create({ url: device.verificationUrl, active: true })
  }

  if (status === null) {
    return (
      <div className={deviceClassName} aria-live="polite">
        <span className="oauth-status">Checking ChatGPT session…</span>
      </div>
    )
  }

  if (status.connected) {
    const detail = [status.email, status.planType].filter(Boolean).join(' · ')
    return (
      <div className="oauth-account">
        <div>
          <span className="oauth-status oauth-status--ok">Connected to ChatGPT</span>
          {detail ? <p className="field__hint">{detail}</p> : null}
        </div>
        <button type="button" className="btn btn--ghost" onClick={() => void remove()}>
          Disconnect
        </button>
      </div>
    )
  }

  if (device) {
    return (
      <div className={deviceClassName}>
        <p className="field__hint">Enter this one-time code in the ChatGPT tab. This expires in 15 minutes.</p>
        <button
          type="button"
          className="oauth-device__code"
          title="Copy code"
          onClick={() => void navigator.clipboard.writeText(device.userCode).catch(() => {})}
        >
          {device.userCode}
        </button>
        <div className="oauth-row">
          <span className="oauth-status">{busy ? 'Waiting for approval…' : 'Sign-in paused'}</span>
          <button type="button" className="btn btn--ghost" onClick={openDevicePage}>
            Open page
          </button>
          <button type="button" className="btn btn--ghost" onClick={cancelConnect}>
            Cancel
          </button>
        </div>
        {error ? <p className="oauth-error">{error}</p> : null}
      </div>
    )
  }

  if (busy) {
    return (
      <div className={deviceClassName}>
        <div className="oauth-row">
          <span className="oauth-status">Finish signing in in the ChatGPT tab…</span>
          <button type="button" className="btn btn--ghost" onClick={cancelConnect}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={deviceClassName}>
      <button
        type="button"
        className="btn btn--primary oauth-device__primary"
        onClick={() => void startBrowserConnect()}
      >
        {variant === 'onboarding' ? 'Continue with ChatGPT' : 'Sign in with ChatGPT'}
      </button>
      <p className="field__hint">
        {variant === 'onboarding'
          ? 'A browser tab will open. You’ll return here automatically.'
          : 'Uses your ChatGPT subscription and returns here automatically after browser approval.'}
      </p>
      {variant === 'onboarding' ? (
        <div className="oauth-device__divider" aria-hidden="true">
          <span>or</span>
        </div>
      ) : null}
      <button
        type="button"
        className="btn btn--ghost oauth-device__fallback"
        onClick={() => void startDeviceConnect()}
      >
        Use a one-time code
      </button>
      {error ? <p className="oauth-error">{error}</p> : null}
    </div>
  )
}
