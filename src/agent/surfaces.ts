/**
 * Exclusive browser tab ownership.
 *
 * ## Hard vs soft claims (the main-agent rule)
 *
 * A **hard** claim is taken by a subagent for its whole run. It fails up front
 * if any requested surface is already held by another *running* agent.
 *
 * A **soft** claim is taken by the MAIN agent, automatically, as a side effect
 * of resolving a tab for a browser tool. The rule, implemented here and relied on by `spawn`:
 *
 *   1. A soft claim never fails and never displaces anything: if a subagent
 *      already holds the surface, main simply does not get a claim on it.
 *   2. Ordinary hard claims respect soft claims too. Delegation explicitly
 *      hands the parent's soft claims to its child, atomically with claiming
 *      the rest of the assigned tabs. Another agent's claims still conflict.
 *   3. A soft claim expires on its own {@link SOFT_CLAIM_TTL_MS} after the main
 *      agent's last action on that surface, and every further action refreshes
 *      it. Expiry rather than an explicit turn-teardown hook keeps the rule out
 *      of the turn loop and means a crashed or abandoned turn cannot strand a
 *      surface.
 *
 * The registry is runtime-wide (not per-turn): a background subagent from an
 * earlier turn may still be running when a later turn spawns another.
 */

/** How long the main agent's automatic claim on a surface it touched survives. */
export const SOFT_CLAIM_TTL_MS = 60_000

/** A surface is the unit of exclusive agent ownership. */
export type AgentSurface = { kind: 'tab'; tabId: number }

/** Stable registry key for a browser tab. */
export function surfaceKey(surface: AgentSurface): string {
  return `tab:${surface.tabId}`
}

export function tabSurface(tabId: number): AgentSurface {
  return { kind: 'tab', tabId }
}

/** Human-readable surface label used in conflict messages and UI chips. */
export function describeSurface(surface: AgentSurface): string {
  return `tab ${surface.tabId}`
}

export interface ClaimRecord {
  ownerAgentId: string
  surface: AgentSurface
  claimedAt: number
  /** Soft claims are the main agent's automatic, yielding, expiring claims. */
  soft: boolean
  /** Soft claims only: absolute time after which the claim is ignored. */
  expiresAt?: number
}

export interface SurfaceConflict {
  surface: AgentSurface
  ownerAgentId: string
  /** Kept for the pre-existing tab-conflict message shape. */
  tabId: number
  soft: boolean
}

export interface SurfaceAssignmentsOptions {
  now?: () => number
  softTtlMs?: number
}

export class SurfaceAssignments {
  private readonly ownerByKey = new Map<string, ClaimRecord>()
  private readonly activeByKey = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number
  private readonly softTtlMs: number

  constructor(options: SurfaceAssignmentsOptions = {}) {
    this.now = options.now ?? Date.now
    this.softTtlMs = options.softTtlMs ?? SOFT_CLAIM_TTL_MS
  }

  /** Drops expired soft claims so reads never see a stale main-agent hold. */
  private sweep(): void {
    const now = this.now()
    for (const [key, record] of this.ownerByKey) {
      if (record.soft && record.expiresAt !== undefined && record.expiresAt <= now && !this.activeByKey.has(key)) this.ownerByKey.delete(key)
    }
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try { fn() } catch { /* a UI listener must never break arbitration */ }
    }
  }

  /**
   * Claims every surface for agentId exclusively, or returns the first conflict
   * and changes NONE of them (all-or-nothing). Delegation may transfer soft
   * claims from its parent; hard claims and other agents' soft claims never yield.
   */
  claimSurfaces(agentId: string, surfaces: AgentSurface[], options: { handoffFromAgentId?: string } = {}): SurfaceConflict | undefined {
    this.sweep()
    for (const surface of surfaces) {
      const held = this.ownerByKey.get(surfaceKey(surface))
      const handoff = held?.soft && held.ownerAgentId === options.handoffFromAgentId && !this.activeByKey.has(surfaceKey(surface))
      if (held && held.ownerAgentId !== agentId && !handoff) {
        return { surface: held.surface, ownerAgentId: held.ownerAgentId, tabId: held.surface.tabId, soft: held.soft }
      }
    }
    const at = this.now()
    for (const surface of surfaces) {
      this.ownerByKey.set(surfaceKey(surface), { ownerAgentId: agentId, surface, claimedAt: at, soft: false })
    }
    if (surfaces.length > 0) this.changed()
    return undefined
  }

  /**
   * The main agent's automatic claim. Never fails; returns the subset it was
   * actually granted. An existing hard claim by someone else wins, and a soft
   * claim the caller already holds is refreshed rather than duplicated.
   */
  softClaim(agentId: string, surfaces: AgentSurface[]): AgentSurface[] {
    this.sweep()
    const at = this.now()
    const granted: AgentSurface[] = []
    let mutated = false
    for (const surface of surfaces) {
      const key = surfaceKey(surface)
      const held = this.ownerByKey.get(key)
      if (held && held.ownerAgentId !== agentId) continue
      const record: ClaimRecord = held && !held.soft
        ? { ...held, surface }
        : { ownerAgentId: agentId, surface, claimedAt: held?.claimedAt ?? at, soft: true, expiresAt: at + this.softTtlMs }
      this.ownerByKey.set(key, record)
      granted.push(surface)
      mutated = true
    }
    if (mutated) this.changed()
    return granted
  }

  /** Reserve the actual operation, not just its model's intention. Active
   * calls cannot expire or be handed to a child until their effects settle. */
  beginUse(agentId: string, surfaces: AgentSurface[]): () => void {
    this.sweep()
    const unique = [...new Map(surfaces.map(surface => [surfaceKey(surface), surface])).values()]
    for (const surface of unique) {
      const held = this.ownerByKey.get(surfaceKey(surface))
      if (held && held.ownerAgentId !== agentId) {
        throw new Error(`${describeSurface(surface)} is owned by ${held.ownerAgentId}. Wait for that agent to finish or use a different prepared tab; no action was dispatched.`)
      }
    }
    this.softClaim(agentId, unique)
    for (const surface of unique) {
      const key = surfaceKey(surface)
      this.activeByKey.set(key, (this.activeByKey.get(key) ?? 0) + 1)
    }
    let ended = false
    return () => {
      if (ended) return
      ended = true
      for (const surface of unique) {
        const key = surfaceKey(surface), count = this.activeByKey.get(key) ?? 0
        if (count <= 1) this.activeByKey.delete(key)
        else this.activeByKey.set(key, count - 1)
        const held = this.ownerByKey.get(key)
        if (held?.soft && held.ownerAgentId === agentId) held.expiresAt = this.now() + this.softTtlMs
      }
    }
  }

  /** Back-compat tab API: claims tab surfaces for agentId, all-or-nothing. */
  claim(agentId: string, tabIds: number[]): SurfaceConflict | undefined {
    return this.claimSurfaces(agentId, tabIds.map(tabSurface))
  }

  /** Releases every surface currently held by agentId. */
  releaseAll(agentId: string): void {
    let mutated = false
    for (const [key, record] of this.ownerByKey) {
      if (record.ownerAgentId === agentId) { this.ownerByKey.delete(key); mutated = true }
    }
    if (mutated) this.changed()
  }

  /** Back-compat alias for {@link releaseAll}. */
  release(agentId: string): void {
    this.releaseAll(agentId)
  }

  releaseSurface(agentId: string, surface: AgentSurface): void {
    const key = surfaceKey(surface)
    if (this.ownerByKey.get(key)?.ownerAgentId !== agentId) return
    this.ownerByKey.delete(key)
    this.changed()
  }

  ownerOf(surface: AgentSurface): string | undefined {
    this.sweep()
    return this.ownerByKey.get(surfaceKey(surface))?.ownerAgentId
  }

  /** Surface keys held by one agent, for TaskInfo / UI chips. */
  surfacesOf(agentId: string): string[] {
    this.sweep()
    const out: string[] = []
    for (const [key, record] of this.ownerByKey) if (record.ownerAgentId === agentId) out.push(key)
    return out.sort()
  }

  list(): ClaimRecord[] {
    this.sweep()
    return [...this.ownerByKey.values()]
  }

  /** Subscribe to claim changes (task tray). Returns an unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /**
   * Drop every tab claim. Used when the browser connection
   * generation changes and previously minted tab ids no longer mean anything.
   */
  invalidateTabs(): void {
    if (!this.ownerByKey.size) return
    this.ownerByKey.clear()
    this.activeByKey.clear()
    this.changed()
  }
}

const CDP_TAB_OPERATIONS = new Set(['attach', 'detach', 'send', 'snapshot', 'click', 'type', 'pressKey',
  'scroll', 'navigate', 'evalInPage', 'attachFiles', 'selectorForRef', 'fill', 'select', 'listFrames',
  'evalInFrame', 'clickInFrame', 'waitForLoad', 'screenshot', 'networkResponseBody'])

/** Used for both direct tools and sandbox dispatch. Internal CDP calls keep
 * the outer operation's lease; they do not invent a different caller. */
export function guardCdpOwnership<T extends object>(cdp: T, ownerId: string | undefined): T {
  if (!ownerId) return cdp
  return new Proxy(cdp, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      if (typeof key !== 'string' || !CDP_TAB_OPERATIONS.has(key)) return value.bind(target)
      return async (...args: unknown[]) => {
        const release = sharedSurfaceAssignments().beginUse(ownerId, [tabSurface(args[0] as number)])
        try { return await Reflect.apply(value, target, args) } finally { release() }
      }
    },
  })
}

export function createSurfaceAssignments(options?: SurfaceAssignmentsOptions): SurfaceAssignments {
  return new SurfaceAssignments(options)
}

/**
 * The one runtime-wide registry. `createTabAssignments()` hands this out, and
 * the tool layer reaches it directly to record the main agent's soft claims
 * (the tool layer has no path to the runtime's own instance).
 */
let shared: SurfaceAssignments | undefined
export function sharedSurfaceAssignments(): SurfaceAssignments {
  if (!shared) shared = new SurfaceAssignments()
  return shared
}

/** Test seam: forget the runtime-wide registry. */
export function resetSharedSurfaceAssignments(): void {
  shared = undefined
}
