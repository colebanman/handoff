import type { ClaudeAccountStatus, ClaudeSignInOptions, ClaudeSignInPhase } from '../../agent/anthropic-oauth'

export interface ClaudeAccountView {
  status: ClaudeAccountStatus | null
  phase: 'idle' | 'disconnecting' | ClaudeSignInPhase
  authTabId?: number
  error?: string
}

interface ClaudeAccountActions {
  getStatus: () => Promise<ClaudeAccountStatus>
  signIn: (options: ClaudeSignInOptions) => Promise<ClaudeAccountStatus>
  signOut: () => Promise<void>
  onConnected: (status: ClaudeAccountStatus) => void | Promise<void>
  onDisconnected: () => void | Promise<void>
}

/** Keep asynchronous storage reads and cancelled sign-ins from replacing newer UI state. */
export class ClaudeAccountFlow {
  private view: ClaudeAccountView = { status: null, phase: 'idle' }
  private listeners = new Set<() => void>()
  private generation = 0
  private readVersion = 0
  private controller?: AbortController
  private active = true
  private refreshPending = false

  constructor(private readonly actions: ClaudeAccountActions) {}

  snapshot = (): ClaudeAccountView => this.view
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(patch: Partial<ClaudeAccountView>): void {
    this.view = { ...this.view, ...patch }
    for (const listener of this.listeners) listener()
  }

  private current(generation: number): boolean {
    return this.active && this.generation === generation
  }

  private settle(generation: number): void {
    if (!this.current(generation)) return
    this.controller = undefined
    this.update({ phase: 'idle', authTabId: undefined })
    if (this.refreshPending) {
      this.refreshPending = false
      void this.refresh()
    }
  }

  activate(): void { this.active = true }

  dispose(): void {
    this.active = false
    ++this.generation
    ++this.readVersion
    this.controller?.abort()
    this.controller = undefined
    this.refreshPending = false
    this.update({ phase: 'idle', authTabId: undefined })
  }

  async refresh(): Promise<void> {
    // Storage events emitted by our own login/disconnect are reconciled by the
    // operation that owns them, after its callbacks and writes have completed.
    if (this.view.phase !== 'idle') { this.refreshPending = true; return }
    const generation = this.generation
    const readVersion = ++this.readVersion
    const current = (): boolean => this.current(generation) && readVersion === this.readVersion
    try {
      const status = await this.actions.getStatus()
      if (!current()) return
      const previous = this.view.status
      this.update({ status })
      if (status.connected && !previous?.connected) {
        this.update({ phase: 'exchanging-token' })
        await this.actions.onConnected(status)
      } else if (!status.connected && previous?.connected) {
        this.update({ phase: 'disconnecting' })
        await this.actions.onDisconnected()
      }
    } catch (error) {
      if (current()) this.update({ status: this.view.status ?? { connected: false }, error: errorMessage(error) })
    } finally {
      if (current()) this.settle(generation)
    }
  }

  setError(error?: string): void { this.update({ error }) }

  cancel(): void {
    ++this.generation
    ++this.readVersion
    this.controller?.abort()
    this.controller = undefined
    this.refreshPending = false
    this.update({ phase: 'idle', authTabId: undefined, error: undefined })
  }

  async start(method?: 'copy-code'): Promise<void> {
    this.cancel()
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    this.update({ phase: 'opening-browser' })
    try {
      const status = await this.actions.signIn({
        method,
        signal: controller.signal,
        onAuthTab: (authTabId) => { if (this.current(generation)) this.update({ authTabId }) },
        onPhaseChange: (phase) => { if (this.current(generation)) this.update({ phase }) },
      })
      if (!this.current(generation)) return
      this.update({ status, authTabId: undefined })
      await this.actions.onConnected(status)
    } catch (error) {
      if (this.current(generation)) this.update({ error: errorMessage(error) })
    } finally {
      this.settle(generation)
    }
  }

  async disconnect(): Promise<void> {
    this.cancel()
    const generation = this.generation
    this.update({ phase: 'disconnecting' })
    try {
      await this.actions.signOut()
      if (!this.current(generation)) return
      this.update({ status: { connected: false } })
      await this.actions.onDisconnected()
    } catch (error) {
      if (this.current(generation)) this.update({ error: errorMessage(error) })
    } finally {
      this.settle(generation)
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Reuse the tab observed by OAuth; a new tab's callback would never be captured. */
export async function focusClaudeSignInTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true })
  if (typeof tab?.windowId === 'number') await chrome.windows.update(tab.windowId, { focused: true })
}
