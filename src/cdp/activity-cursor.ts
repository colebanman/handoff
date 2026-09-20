import { agentHue, renderActivityCursor, type CursorActivity, type CursorMode } from './activity-cursor-renderer'
import { renderFaviconPulse, type FaviconFrame } from './favicon-pulse-renderer'

export { renderActivityCursor, ACTIVITY_CURSOR_VERSION, AGENT_CURSOR_HUES, agentAccent, agentHue, type CursorActivity, type CursorMode } from './activity-cursor-renderer'

type Session = {
  signal: AbortSignal
  /** Which agent this session's pointer belongs to; picks its color. */
  agentId?: string
  hue?: number
  count: number
  tools: number
  turns: number
  timer?: ReturnType<typeof setInterval>
  stop: () => void
  finish: () => void
}

/**
 * One delivery slot per tab. `follow` rides along so a re-materialize keeps its
 * order; `settled` reports the renderer's travel estimate (0 = nothing to wait
 * for) exactly once, including when the entry is dropped or coalesced away.
 */
type Entry = {
  activity: CursorActivity
  signal?: AbortSignal
  follow?: CursorActivity
  ok?: () => void
  settled?: (estimate: number) => void
}

/** Milliseconds the page-side synthetic-event observer stays armed after a tool heartbeat. */
const ARMED_FOR = 2500
/** Cursor lifetime without further activity, per mode. */
const LIFETIME = { ambient: 30000, actions: 10000, off: 10000 } as const
/** How long an agent-initiated tab activation stays attributable. */
const ACTIVATION_WINDOW = 1500
/** How long a dropped `enter` waits for the incoming document. */
const PENDING_ENTER_WINDOW = 5000
/** Bounded, abort-aware hold before the tab actually flips (covers the favicon pulse). */
const SWITCH_HOLD = 300
/** Offsets of the three favicon "click" frames inside the hold. */
const FAVICON_FRAMES = [0, 110, 220] as const
/**
 * Ceiling on how long an action waits for the pointer to arrive. Cosmetic
 * gating only: anything unexpected resolves immediately.
 */
export const ARRIVAL_WAIT_CAP_MS = 450

/** Cosmetic, best-effort delivery. Never wait for cursor travel to execute a tool. */
export class ActivityCursor {
  private sessions = new Map<AbortSignal, Session>()
  private owners = new Map<number, AbortSignal>()
  private presented = new Set<number>()
  private pending = new Map<number, Entry>()
  private deliveries = new Map<number, Promise<void>>()
  private captures = new Map<number, number>()
  private mode: CursorMode = 'ambient'
  /** Host-side spatial memory: survives navigation, which wipes the page-side renderer. */
  private lastPositions = new Map<number, { x: number; y: number }>()
  /** Tabs whose document has gone away since they were last presented. */
  private navigated = new Set<number>()
  /** Tab-switch `enter` that could not be injected yet (page still loading / restricted). */
  private pendingEnter = new Map<number, { activity: CursorActivity; signal: AbortSignal; at: number }>()
  /** Tabs the agent is about to activate, with their expiry. */
  private expectations = new Map<number, number>()

  setMode(mode: CursorMode): void {
    if (mode === this.mode) return
    this.mode = mode
    if (mode === 'off') this.hideAll()
  }

  /**
   * `agentId` gives this session's pointer its own identity: subagents get a
   * stable hue from the shared palette so several moving cursors are
   * distinguishable, while the main agent keeps the original accent and a
   * single-agent run is pixel-identical to before.
   */
  begin(signal: AbortSignal, agentId?: string): () => void {
    if (signal.aborted) return () => {}
    const existing = this.sessions.get(signal)
    if (existing) { existing.count++; if (agentId && !existing.agentId) { existing.agentId = agentId; existing.hue = agentHue(agentId) } }
    else {
      const close = (cancelled: boolean): void => {
        clearInterval(this.sessions.get(signal)?.timer)
        this.sessions.delete(signal)
        signal.removeEventListener('abort', stop)
        for (const [tab, owner] of this.owners) {
          if (owner !== signal) continue
          this.forgetTab(tab)
          if (cancelled) { void this.hide(tab, true); continue }
          this.owners.delete(tab)
          const queued = this.pending.get(tab)
          this.setPending(tab, {
            activity: queued?.signal === signal
              ? queued.activity
              : { kind: 'finish' },
            follow: queued?.signal === signal ? queued.follow : undefined,
          })
          void this.flush(tab)
        }
      }
      const stop = (): void => close(true)
      this.sessions.set(signal, { signal, agentId, hue: agentHue(agentId), count: 1, tools: 0, turns: 0, stop, finish: () => close(false) })
      signal.addEventListener('abort', stop, { once: true })
    }
    let ended = false
    return () => {
      if (ended) return
      ended = true
      const session = this.sessions.get(signal)
      if (session && --session.count === 0) session.finish()
    }
  }

  beginTool(signal: AbortSignal): () => void {
    const session = this.sessions.get(signal)
    if (!session || signal.aborted) return () => {}
    session.tools++
    this.syncTimer(session)
    this.touch(session)
    let ended = false
    return () => {
      if (ended || this.sessions.get(signal) !== session) return
      ended = true
      session.tools--
      this.syncTimer(session)
      this.touch(session) // Start the full inactivity window after the last tool settles.
    }
  }

  /**
   * Ambient only: while the model streams and no tool is running, the owned tabs
   * breathe instead of going quiet. Re-entrant and idempotent.
   */
  beginModelTurn(signal: AbortSignal): () => void {
    const session = this.sessions.get(signal)
    if (!session || signal.aborted || this.mode !== 'ambient') return () => {}
    session.turns++
    this.syncTimer(session)
    let ended = false
    return () => {
      if (ended || this.sessions.get(signal) !== session) return
      ended = true
      session.turns--
      this.syncTimer(session)
    }
  }

  show(tab: number, activity: CursorActivity, signal?: AbortSignal): void {
    if (this.mode === 'off') return
    if (!signal || signal.aborted || !this.sessions.has(signal)) return
    if (Number.isFinite(activity.x) && Number.isFinite(activity.y)) {
      this.lastPositions.set(tab, { x: activity.x!, y: activity.y! })
    }
    this.own(tab, signal)
    this.enqueue(tab, { activity, signal })
  }

  /**
   * `show`, then wait for the pointer to actually get there so the real input
   * lands under it. The wait is the renderer's own travel estimate, capped at
   * {@link ARRIVAL_WAIT_CAP_MS}; every failure path (off, aborted, restricted
   * page, unknown session, nothing visible to travel) resolves immediately and
   * nothing ever rejects.
   */
  async showAndWait(tab: number, activity: CursorActivity, signal?: AbortSignal): Promise<void> {
    if (this.mode === 'off') return
    if (!signal || signal.aborted || !this.sessions.has(signal)) return
    if (Number.isFinite(activity.x) && Number.isFinite(activity.y)) {
      this.lastPositions.set(tab, { x: activity.x!, y: activity.y! })
    }
    this.own(tab, signal)
    const estimate = await new Promise<number>((resolve) => {
      this.enqueue(tab, { activity, signal, settled: resolve })
    })
    if (!(estimate > 0)) return
    await this.hold(Math.min(estimate, ARRIVAL_WAIT_CAP_MS), signal)
  }

  /**
   * Ambient only: rest in place. After a navigation the page-side renderer is
   * gone, so the remembered position is replayed as a `move` before the `park`.
   */
  park(tab: number, signal?: AbortSignal): void {
    if (this.mode !== 'ambient') return
    if (!signal || signal.aborted || !this.sessions.has(signal)) return
    this.own(tab, signal)
    const last = this.navigated.has(tab) ? this.lastPositions.get(tab) : undefined
    this.navigated.delete(tab)
    if (last) this.enqueue(tab, { activity: { kind: 'move', ...last }, follow: { kind: 'park' }, signal })
    else this.enqueue(tab, { activity: { kind: 'park' }, signal })
  }

  /** Record that the agent — not the user — is about to activate this tab. */
  expectActivation(tab: number): void {
    this.expectations.set(tab, Date.now() + ACTIVATION_WINDOW)
  }

  consumeExpectedActivation(tab: number): boolean {
    const until = this.expectations.get(tab)
    if (until === undefined) return false
    this.expectations.delete(tab)
    return until > Date.now()
  }

  /**
   * Visible tab switch: the pointer leaves the old tab toward the strip, the
   * target tab's favicon takes a three-frame "click" while the strip is out of
   * reach, the tab flips, and the pointer descends onto the new one from the
   * same x.
   */
  async switchTabs(opts: {
    fromTab?: number
    toTab: number
    signal: AbortSignal
    stripX?: number
    /** Data URL of the target tab's favicon; absent draws a neutral tile. */
    icon?: string
    activate: () => Promise<void>
  }): Promise<void> {
    const { fromTab, toTab, signal, stripX, icon, activate } = opts
    if (this.mode !== 'ambient' || signal.aborted || !this.sessions.has(signal)) { await activate(); return }
    const x = stripX ?? 40
    if (fromTab !== undefined && this.presented.has(fromTab)) {
      this.enqueue(fromTab, { activity: { kind: 'exit', x }, signal })
    }
    // Service-worker timers, not page timers: a background tab throttles its own.
    const pulses = fromTab !== toTab
    const timers: Array<ReturnType<typeof setTimeout>> = []
    let stopped = false
    const stopPulse = (): void => {
      if (stopped) return
      stopped = true
      for (const timer of timers) clearTimeout(timer)
      if (pulses) void this.faviconFrame(toTab, 'restore')
    }
    if (pulses) {
      void this.faviconFrame(toTab, 0, icon)
      for (const [index, at] of FAVICON_FRAMES.entries()) {
        if (index === 0) continue
        const step = index as 1 | 2
        timers.push(setTimeout(() => { if (!stopped) void this.faviconFrame(toTab, step, icon) }, at))
      }
    }
    await this.hold(SWITCH_HOLD, signal)
    if (signal.aborted) stopPulse()
    this.expectActivation(toTab)
    try {
      await activate()
    } finally {
      stopPulse()
    }
    if (signal.aborted || !this.sessions.has(signal)) return
    this.own(toTab, signal)
    const enter: CursorActivity = { kind: 'enter', x, toY: 88 }
    // Restricted or still-loading pages drop the injection; onNavigated retries it.
    this.pendingEnter.set(toTab, { activity: enter, signal, at: Date.now() })
    this.enqueue(toTab, { activity: enter, signal, ok: () => this.pendingEnter.delete(toTab) })
  }

  onNavigated(tab: number, phase: 'committed' | 'domcontentloaded'): void {
    if (phase === 'committed') {
      // The old document is gone; nothing can be delivered to it. Keep the owner
      // and the remembered position so the new one can re-materialize.
      this.presented.delete(tab)
      this.navigated.add(tab)
      return
    }
    const owner = this.owners.get(tab)
    if (!owner || owner.aborted || !this.sessions.has(owner)) return
    const queued = this.pendingEnter.get(tab)
    if (queued) {
      this.pendingEnter.delete(tab)
      if (queued.signal === owner && Date.now() - queued.at <= PENDING_ENTER_WINDOW) {
        this.navigated.delete(tab)
        this.own(tab, owner)
        this.enqueue(tab, { activity: queued.activity, signal: owner })
        return
      }
    }
    if (this.mode !== 'ambient') return
    const last = this.lastPositions.get(tab)
    this.navigated.delete(tab)
    this.own(tab, owner)
    if (last) this.enqueue(tab, { activity: { kind: 'move', ...last }, follow: { kind: 'park' }, signal: owner })
    else this.enqueue(tab, { activity: { kind: 'park' }, signal: owner })
  }

  onTabActivated(tab: number): void {
    if (this.consumeExpectedActivation(tab)) return // Agent-initiated: `enter` is already queued.
    if (this.mode !== 'ambient') return
    const owner = this.owners.get(tab)
    if (!owner || owner.aborted || !this.sessions.has(owner)) return
    // The user came to look at a tab the agent works in: guarantee a settle.
    this.own(tab, owner)
    this.enqueue(tab, { activity: { kind: 'park' }, signal: owner })
  }

  /** Soft hide for navigation: spatial continuity is kept host-side. */
  hideOnNavigate(tab: number): void {
    this.navigated.add(tab)
    if (!this.presented.has(tab) && !this.deliveries.has(tab)) return
    this.presented.delete(tab)
    this.enqueue(tab, { activity: { kind: 'hide', immediate: false } })
  }

  hide(tab: number, immediate = false): Promise<void> {
    if (!this.presented.has(tab) && !this.deliveries.has(tab)) return Promise.resolve()
    this.owners.delete(tab)
    this.presented.delete(tab)
    this.setPending(tab, { activity: { kind: 'hide', immediate } })
    return this.flush(tab)
  }

  hideAll(): void {
    for (const tab of [...this.presented]) void this.hide(tab, true)
  }

  async withoutCursor<T>(tab: number, capture: () => Promise<T>): Promise<T> {
    this.captures.set(tab, (this.captures.get(tab) ?? 0) + 1)
    const syncVisibility = (): Promise<void> => {
      if (!this.presented.has(tab)) return this.deliveries.get(tab) ?? Promise.resolve()
      // Preserve any queued destination; its delivery will inherit captureHidden.
      if (!this.pending.has(tab)) this.pending.set(tab, { activity: { kind: 'visibility' } })
      return this.flush(tab)
    }
    try {
      await syncVisibility()
      return await capture()
    } finally {
      const remaining = (this.captures.get(tab) ?? 1) - 1
      if (remaining) this.captures.set(tab, remaining)
      else this.captures.delete(tab)
      await syncVisibility()
    }
  }

  /** One favicon frame on the target tab. Fire-and-forget: a restricted tab just keeps its icon. */
  private async faviconFrame(tab: number, step: FaviconFrame['step'], icon?: string): Promise<void> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab }, func: renderFaviconPulse,
        args: [{ step, ...(icon ? { icon } : {}) } satisfies FaviconFrame],
      })
    } catch { /* Restricted pages, closed tabs: no pulse. */ }
  }

  private own(tab: number, signal: AbortSignal): void {
    this.owners.set(tab, signal)
    this.presented.add(tab)
  }

  private forgetTab(tab: number): void {
    this.pendingEnter.delete(tab)
    this.expectations.delete(tab)
    this.lastPositions.delete(tab)
    this.navigated.delete(tab)
  }

  private hold(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      timer = setTimeout(done, ms)
      if (signal.aborted) done()
      else signal.addEventListener('abort', done, { once: true })
    })
  }

  /** One 2s heartbeat per session, shared by tool keepalives and model-turn thinking. */
  private syncTimer(session: Session): void {
    const wanted = session.tools > 0 || (session.turns > 0 && this.mode === 'ambient')
    if (wanted === !!session.timer) return
    if (!wanted) { clearInterval(session.timer); session.timer = undefined; return }
    session.timer = setInterval(() => {
      if (session.tools > 0) this.touch(session)
      else if (session.turns > 0 && this.mode === 'ambient') this.think(session)
    }, 2000)
  }

  /**
   * Keepalive for every tab the session already owns. A tool with no positioned
   * tab produces nothing: the cursor never invents a location.
   */
  private touch(session: Session): void {
    for (const [tab, owner] of this.owners) {
      if (owner !== session.signal) continue
      if (!this.pending.has(tab)) this.pending.set(tab, { activity: { kind: 'keepalive' }, signal: session.signal })
      void this.flush(tab)
    }
  }

  private think(session: Session): void {
    for (const [tab, owner] of this.owners) {
      if (owner !== session.signal) continue
      if (!this.pending.has(tab)) this.pending.set(tab, { activity: { kind: 'thinking' }, signal: session.signal })
      void this.flush(tab)
    }
  }

  private enqueue(tab: number, entry: Entry): void {
    this.setPending(tab, entry)
    void this.flush(tab)
  }

  /** Coalescing must never swallow an arrival callback: a displaced entry settles at 0. */
  private setPending(tab: number, entry: Entry): void {
    const displaced = this.pending.get(tab)
    if (displaced && displaced !== entry) displaced.settled?.(0)
    this.pending.set(tab, entry)
  }

  private flush(tab: number): Promise<void> {
    const current = this.deliveries.get(tab)
    if (current) return current
    const delivery = (async () => {
      // Coalesce bursts (including per-character keyboard dispatch) and keep
      // hide ordered after any already-in-flight script on this tab.
      while (this.pending.has(tab)) {
        const next = this.pending.get(tab)!
        this.pending.delete(tab)
        let settled = false
        const settle = (estimate: number): void => {
          if (settled) return
          settled = true
          next.settled?.(estimate)
        }
        if (next.signal && (next.signal.aborted || !this.sessions.has(next.signal))) { settle(0); continue }
        const session = next.signal ? this.sessions.get(next.signal) : undefined
        const armed = session ? { armedFor: session.tools > 0 ? ARMED_FOR : 0 } : {}
        const identity = session?.agentId ? { agentId: session.agentId, hue: session.hue } : {}
        const lifetime = LIFETIME[this.mode]
        const activities = next.follow ? [next.activity, next.follow] : [next.activity]
        for (const activity of activities) {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab }, func: renderActivityCursor,
              args: [{ ...activity, ...armed, ...identity, captureHidden: (this.captures.get(tab) ?? 0) > 0, lifetime }],
            })
            if (activity === next.activity) {
              next.ok?.()
              // The renderer answers with its estimated travel time in ms.
              const estimate = Number((results as Array<{ result?: unknown }> | undefined)?.[0]?.result)
              settle(Number.isFinite(estimate) ? estimate : 0)
            }
          } catch { /* Restricted pages, navigation, closed tabs: no cursor. */ }
        }
        settle(0)
      }
    })().finally(() => {
      this.deliveries.delete(tab)
      // An abort can enqueue cleanup between the loop finishing and this
      // microtask. Drain that final update too, including for capture callers.
      if (this.pending.has(tab)) return this.flush(tab)
    })
    this.deliveries.set(tab, delivery)
    return delivery
  }
}

/**
 * Plausible x of a tab's button in window coordinates. The exit only has to
 * leave the viewport somewhere near the target tab's column — the favicon pulse
 * carries the "click", and the pointer is gone above the top edge by then, so
 * only gross errors read wrong. Undefined means "exit top-left".
 */
export function estimateTabStripX(input: {
  windowWidth: number
  tabs: Array<{ index: number; pinned: boolean }>
  targetIndex: number
}): number | undefined {
  const { windowWidth, tabs, targetIndex } = input
  if (!Number.isFinite(windowWidth) || windowWidth < 500) return undefined
  if (!tabs.some((tab) => tab.index === targetIndex)) return undefined
  // New-tab button plus window controls take the tail of the strip.
  const strip = windowWidth - 120
  const pinned = tabs.filter((tab) => tab.pinned).length
  const unpinned = tabs.length - pinned
  const width = unpinned > 0 ? Math.max(66, Math.min(240, (strip - pinned * 40) / unpinned)) : 0
  let left = 0
  for (const tab of [...tabs].sort((a, b) => a.index - b.index)) {
    const own = tab.pinned ? 40 : width
    if (tab.index === targetIndex) return left + own / 2
    left += own
  }
  return undefined
}
