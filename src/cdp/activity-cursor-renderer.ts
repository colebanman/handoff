/**
 * Page-side renderer for the agent's activity cursor.
 *
 * The exported function is serialized by chrome.scripting.executeScript and
 * runs inside the target page, so everything it needs lives inside it: no
 * imports, no closure over module state. The host side (ActivityCursor in
 * ./activity-cursor.ts) only ever calls executeScript with one CursorActivity.
 */

export type CursorMode = 'off' | 'actions' | 'ambient'

export type CursorActivity = {
  kind:
    | 'move'      // travel to (x, y); pointer arrives and rests
    | 'click'     // travel to (x, y); press + ring + hit-rect on arrival
    | 'type'      // sit at the focused field's edge; field outline + underline sweep
    | 'scroll'    // travel to (x, y); chevron trail in the direction of dy
    | 'park'      // ambient: stay where you are and rest, or materialize at the parked spot
    | 'thinking'  // ambient: model is streaming; slow breathe + drift, no target change
    | 'exit'      // tab switch, outgoing half: fly to (x, -14) and fade out above the viewport
    | 'enter'     // tab switch, incoming half: appear at (x, -14) and descend to toY, then park
    | 'hide'      // fade out (immediate: snap + forget position)
    | 'visibility'// re-evaluate visibility only (screenshot suppression)
    | 'finish'    // run ended normally: drop working states, then fade out over 600ms
    | 'keepalive' // extend the deadline; carries the armed window for the synthetic-event observer
  x?: number
  y?: number
  /** Scroll direction for `scroll` (sign only matters). */
  dy?: number
  /** Landing y for `enter` (default 88). */
  toY?: number
  immediate?: boolean
  captureHidden?: boolean
  /**
   * Milliseconds (from receipt) during which untrusted DOM events in the page
   * — clicks, focus, input, submit, scroll driven by the agent's own JS — move
   * the pointer locally. 0/undefined disarms.
   */
  armedFor?: number
  /** Milliseconds the pointer stays visible without further activity. Default 30000. */
  lifetime?: number
  /**
   * Identity of the agent this pointer belongs to. Several agents may draw in
   * one document (or one native overlay), so each gets its own renderer
   * instance keyed by this id. Undefined/'main' is the single-agent case.
   */
  agentId?: string
  /**
   * HSL hue for this agent's accent, from {@link agentHue}. Undefined keeps the
   * original lavender, so a single-agent run looks exactly as it always did.
   */
  hue?: number
}

/**
 * Stable hue wheel for multi-agent runs. The main agent is deliberately absent:
 * it keeps the original accent, so nothing changes for a single-agent run.
 * Subagent ids map into the wheel by a cheap deterministic hash, so the same
 * agent is the same color in the page cursor, the native overlay and the task
 * tray, across processes and restarts, with no allocation state to keep.
 */
export const AGENT_CURSOR_HUES = [265, 20, 145, 200, 45, 320, 95, 240] as const

/** Accent hue for an agent, or undefined for the main agent's original accent. */
export function agentHue(agentId?: string): number | undefined {
  if (!agentId || agentId === 'main') return undefined
  let hash = 0
  for (let i = 0; i < agentId.length; i++) hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0
  return AGENT_CURSOR_HUES[hash % AGENT_CURSOR_HUES.length]
}

/** CSS color for an agent's cursor accent. */
export function agentAccent(agentId?: string): string {
  const hue = agentHue(agentId)
  return hue === undefined ? '#b4a1ff' : `hsl(${hue} 72% 72%)`
}

export const ACTIVITY_CURSOR_VERSION = 7

/**
 * Serialized by chrome.scripting: keep all page-side state and helpers inside.
 * Returns the estimated milliseconds until the pointer arrives at the requested
 * point (0 when nothing visible will travel), so the host can let a click land
 * after the pointer does — bounded, never required.
 */
export function renderActivityCursor(activity: CursorActivity): number {
  const VERSION = 7
  type Api = { version?: number; update: (value: CursorActivity) => number; dispose?: () => void }
  // One renderer instance per agent: several agents may draw in the same
  // document, each with its own hue.
  const agent = activity.agentId ?? 'main'
  const key = `__aiActivityCursor_${agent.replace(/[^A-Za-z0-9_]/g, '_')}` as '__aiActivityCursor'
  const scope = window as typeof window & { __aiActivityCursor?: Api }
  if (scope[key]?.version === VERSION) return scope[key]!.update(activity)
  // Existing tabs can retain a previous injected renderer across extension
  // updates. Replace it, rather than silently continuing the old hide rules.
  if (scope[key]) {
    scope[key]!.update({ kind: 'hide', immediate: true })
    scope[key]!.dispose?.()
    document.querySelectorAll(`[data-ai-activity-cursor="${agent}"]`).forEach((element) => element.remove())
    delete scope[key]
  }
  // A pre-v7 renderer used the unkeyed global and an empty marker attribute.
  const legacy = (window as typeof window & { __aiActivityCursor?: Api }).__aiActivityCursor
  if (legacy && agent === 'main') {
    legacy.update({ kind: 'hide', immediate: true })
    legacy.dispose?.()
    document.querySelectorAll('[data-ai-activity-cursor=""]').forEach((element) => element.remove())
    delete (window as typeof window & { __aiActivityCursor?: Api }).__aiActivityCursor
  }
  const passive = activity.kind === 'hide' || activity.kind === 'visibility' || activity.kind === 'finish' || activity.kind === 'keepalive' || activity.kind === 'thinking'
  if (passive || !document.documentElement) return 0

  const ACCENT = activity.hue === undefined ? '#b4a1ff' : `hsl(${activity.hue} 72% 72%)`
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.setAttribute('data-ai-activity-cursor', agent)
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;contain:layout style!important;'
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    :host { pointer-events:none !important; }
    * { box-sizing:border-box; }
    .position { position:absolute; left:0; top:0; width:24px; height:24px; pointer-events:none; }
    .cursor { opacity:0; transform:scale(.65); transform-origin:3px 3px; filter:blur(3px);
      transition:opacity 260ms cubic-bezier(.2,.7,.2,1),transform 260ms cubic-bezier(.2,.7,.2,1),filter 260ms ease; }
    .shown .cursor { opacity:1; transform:scale(1); filter:blur(0); }
    .shown.resting .cursor { opacity:.62; }
    .shown.parked .cursor { opacity:.55; }
    .shown.exiting .cursor { opacity:0; transform:scale(.8); filter:blur(1px); transition-duration:260ms; }
    .shown.finishing .cursor { opacity:0; transform:scale(.9); filter:blur(2px); transition-duration:600ms; }
    .drift { transform-origin:3px 3px; }
    .thinking .drift { animation:drift 4200ms ease-in-out infinite; }
    svg { display:block; width:24px; height:24px; overflow:visible; filter:drop-shadow(0 1px 1.5px #0006);
      transform-origin:3px 3px; }
    .press svg { transform:scale(.9) !important; transition:transform 90ms ease-out; }
    .halo { fill:${ACCENT}; stroke:${ACCENT}; stroke-width:2; opacity:.38; filter:blur(3px);
      transition:opacity 300ms ease; }
    .working .halo { animation:breathe 1000ms ease-in-out infinite alternate; }
    .thinking .halo { animation:breathe-slow 1800ms ease-in-out infinite alternate; }
    .parked .halo, .exiting .halo, .finishing .halo { opacity:0; animation:none; }
    .ring { position:absolute; left:-4px; top:-4px; width:12px; height:12px; border:1.5px solid ${ACCENT};
      border-radius:50%; opacity:0; transform-origin:center; }
    .click .ring { animation:click 380ms cubic-bezier(.2,.7,.2,1); }
    .chevrons { position:absolute; left:6px; top:26px; width:12px; display:flex; flex-direction:column; gap:2px; opacity:0; }
    .chevrons span { display:block; width:8px; height:8px; margin:0 auto; border-right:1.5px solid ${ACCENT}; border-bottom:1.5px solid ${ACCENT};
      transform:rotate(45deg); }
    .chevrons.up { top:auto; bottom:22px; flex-direction:column-reverse; }
    .chevrons.up span { transform:rotate(-135deg); }
    .scrolling .chevrons { animation:chevrons 300ms ease-out; }
    .hit { position:absolute; border:1.5px solid ${ACCENT}; border-radius:6px; opacity:0; pointer-events:none;
      box-shadow:0 0 0 0 ${ACCENT}00; }
    .hit.live { animation:hit 520ms cubic-bezier(.2,.7,.2,1) forwards; }
    .field { position:absolute; border:1.5px solid ${ACCENT}; border-radius:6px; opacity:0; pointer-events:none;
      transition:opacity 220ms ease, left 120ms ease, top 120ms ease, width 120ms ease, height 120ms ease; overflow:hidden; }
    .field.live { opacity:.3; }
    .field .sweep { position:absolute; left:0; right:0; bottom:0; height:2px; background:${ACCENT}; opacity:0;
      transform:scaleX(0); transform-origin:left; }
    .field.sweeping .sweep { animation:sweep 420ms cubic-bezier(.2,.7,.2,1); }
    @keyframes click { from { opacity:.7; transform:scale(.5); } to { opacity:0; transform:scale(3.3); } }
    @keyframes breathe { to { opacity:.65; } }
    @keyframes breathe-slow { from { opacity:.22; } to { opacity:.5; } }
    @keyframes drift { 0%,100% { transform:translate(0,0); } 25% { transform:translate(1.2px,-1.5px); } 50% { transform:translate(-.8px,1px); } 75% { transform:translate(1.5px,.6px); } }
    @keyframes chevrons { from { opacity:.75; transform:translateY(0); } to { opacity:0; transform:translateY(var(--chev-dir,10px)); } }
    @keyframes hit { 0% { opacity:0; box-shadow:0 0 0 0 ${ACCENT}00; } 18% { opacity:.55; } 100% { opacity:0; box-shadow:0 0 0 6px ${ACCENT}00; border-color:${ACCENT}00; } }
    @keyframes sweep { 0% { opacity:.9; transform:scaleX(0); } 70% { opacity:.9; transform:scaleX(1); } 100% { opacity:0; transform:scaleX(1); } }
    @media(prefers-reduced-motion:reduce) {
      .cursor { transition:opacity 100ms linear; transform:none; filter:none; }
      .working .halo,.thinking .halo,.thinking .drift,.click .ring,.scrolling .chevrons { animation:none; }
      .press svg { transform:none !important; }
      .hit.live { animation:hit-rm 200ms linear forwards; }
      .field.sweeping .sweep { animation:sweep-rm 200ms linear; }
      .chevrons { display:none; }
    }
    @keyframes hit-rm { from { opacity:.55; } to { opacity:0; } }
    @keyframes sweep-rm { from { opacity:.9; transform:scaleX(1); } to { opacity:0; transform:scaleX(1); } }
    @media(forced-colors:active) { path { fill:CanvasText; stroke:Canvas; } .halo { display:none; } .hit,.field { border-color:Highlight; } }
  `
  const position = document.createElement('div')
  position.className = 'position'
  // Codex-inspired rounded pointer: dark body, clean white rim, diffuse halo.
  // Activity lives in the halo instead of a separate badge beside the pointer.
  const cursor = document.createElement('div')
  cursor.className = 'cursor'
  const drift = document.createElement('div')
  drift.className = 'drift'
  const ring = document.createElement('span')
  ring.className = 'ring'
  const chevrons = document.createElement('span')
  chevrons.className = 'chevrons'
  for (let i = 0; i < 3; i++) chevrons.append(document.createElement('span'))
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  const silhouette = 'M4.35 3.15C3.48 2.8 2.8 3.48 3.15 4.35L9.8 20.55C10.16 21.44 11.46 21.37 11.72 20.44L13.33 14.75C13.52 14.08 14.08 13.52 14.75 13.33L20.44 11.72C21.37 11.46 21.44 10.16 20.55 9.8Z'
  const halo = document.createElementNS(svg.namespaceURI, 'path')
  halo.setAttribute('class', 'halo')
  halo.setAttribute('d', silhouette)
  const path = document.createElementNS(svg.namespaceURI, 'path')
  for (const [key, value] of Object.entries({ d: silhouette, fill: '#202126', stroke: '#fff', 'stroke-width': '1.5', 'stroke-linejoin': 'round' })) path.setAttribute(key, value)
  svg.append(halo, path)
  drift.append(svg)
  cursor.append(ring, chevrons, drift)
  position.append(cursor)
  const hit = document.createElement('div')
  hit.className = 'hit'
  const field = document.createElement('div')
  field.className = 'field'
  const sweep = document.createElement('span')
  sweep.className = 'sweep'
  field.append(sweep)
  root.append(style, hit, field, position)
  document.documentElement.append(host)

  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  let x = 0, y = 0, targetX = 0, targetY = 0, vx = 0, vy = 0
  let visible = false, positioned = false, captureHidden = false, frame = 0, last = 0, expires = 0
  let lifetime = 30000
  let lastActivity = 0, pendingClick = false, exiting = false
  let parkedPose = false
  let motionPath: { sx: number; sy: number; cx: number; cy: number; progress: number; velocity: number } | null = null
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let clickTimer: ReturnType<typeof setTimeout> | undefined
  let pressTimer: ReturnType<typeof setTimeout> | undefined
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  let finishTimer: ReturnType<typeof setTimeout> | undefined
  let exitTimer: ReturnType<typeof setTimeout> | undefined
  let sweepTimer: ReturnType<typeof setTimeout> | undefined
  // Target-rect feedback: the clicked element (short-lived) and the focused field (while typing).
  let hitElement: Element | null = null, hitTimer: ReturnType<typeof setTimeout> | undefined
  let fieldElement: Element | null = null
  let lastSweep = 0
  // Synthetic-event observer arming window (performance.now() deadline).
  let armedUntil = 0, lastLocalRetarget = 0

  function rectOf(element: Element): DOMRect { return element.getBoundingClientRect() }
  function placeBox(box: HTMLElement, rect: DOMRect, pad: number): void {
    box.style.left = `${(rect.left - pad).toFixed(1)}px`
    box.style.top = `${(rect.top - pad).toFixed(1)}px`
    box.style.width = `${(rect.width + pad * 2).toFixed(1)}px`
    box.style.height = `${(rect.height + pad * 2).toFixed(1)}px`
  }
  function repositionBoxes(): void {
    if (hitElement) placeBox(hit, rectOf(hitElement), 3)
    if (fieldElement) placeBox(field, rectOf(fieldElement), 2)
  }
  let boxListeners = false
  function syncBoxListeners(): void {
    const need = !!(hitElement || fieldElement)
    if (need === boxListeners) return
    boxListeners = need
    if (need) {
      addEventListener('scroll', repositionBoxes, { capture: true, passive: true })
      addEventListener('resize', repositionBoxes, { passive: true })
    } else {
      removeEventListener('scroll', repositionBoxes, { capture: true })
      removeEventListener('resize', repositionBoxes)
    }
  }
  function showHit(element: Element): void {
    const rect = rectOf(element)
    // Whole-viewport targets (body, page wrappers) make a meaningless outline.
    if (rect.width * rect.height > innerWidth * innerHeight * .6) return
    hitElement = element
    placeBox(hit, rect, 3)
    hit.classList.remove('live')
    void hit.offsetWidth
    hit.classList.add('live')
    clearTimeout(hitTimer)
    hitTimer = setTimeout(() => { hitElement = null; hit.classList.remove('live'); syncBoxListeners() }, 540)
    syncBoxListeners()
  }
  function showField(element: Element | null): void {
    if (element === fieldElement) { if (element) placeBox(field, rectOf(element), 2); return }
    fieldElement = element
    if (!element) { field.classList.remove('live', 'sweeping'); syncBoxListeners(); return }
    // Position before revealing so the outline does not slide in from a stale spot.
    field.style.transition = 'none'
    placeBox(field, rectOf(element), 2)
    void field.offsetWidth
    field.style.transition = ''
    field.classList.add('live')
    syncBoxListeners()
  }
  function sweepField(): void {
    const now = performance.now()
    if (now - lastSweep < 150) return
    lastSweep = now
    field.classList.remove('sweeping')
    void field.offsetWidth
    field.classList.add('sweeping')
    clearTimeout(sweepTimer)
    sweepTimer = setTimeout(() => field.classList.remove('sweeping'), 440)
  }

  function hide(immediate = false): void {
    visible = false
    pendingClick = false
    exiting = false
    parkedPose = false
    motionPath = null
    // Soft fades retain the presentation position for the next move. Only
    // explicit cancellation/navigation should discard spatial continuity.
    if (immediate) positioned = false
    clearTimeout(idleTimer)
    clearTimeout(finishTimer)
    clearTimeout(exitTimer)
    cancelAnimationFrame(frame)
    frame = 0
    position.className = 'position'
    showField(null)
    // Screenshot/capture must not include an animation on its way out.
    host.style.setProperty('visibility', immediate || captureHidden ? 'hidden' : 'visible', 'important')
  }

  function paint(): void {
    position.style.transform = `translate3d(${(x - 3).toFixed(2)}px,${(y - 3).toFixed(2)}px,0)`
    const speed = Math.hypot(vx, vy)
    if (reduced.matches) { svg.style.transform = ''; return }
    // A small lean communicates travel without obscuring the target. Parked,
    // the pointer relaxes into a slight backward tilt.
    const travelLean = Math.max(-14, Math.min(14, vx / 80))
    const restLean = parkedPose && speed < 20 ? -8 : 0
    svg.style.transform = `rotate(${(travelLean + restLean).toFixed(2)}deg) scale(${(1 + Math.min(.12, speed / 12000)).toFixed(4)},1)`
  }

  function pulseClick(): void {
    pendingClick = false
    position.classList.remove('click', 'press')
    void position.offsetWidth
    position.classList.add('click', 'press')
    clearTimeout(pressTimer)
    pressTimer = setTimeout(() => position.classList.remove('press'), 90)
    clearTimeout(clickTimer)
    clickTimer = setTimeout(() => position.classList.remove('click'), 400)
    if (hitElement) showHit(hitElement)
  }

  function pulseScroll(dy: number | undefined): void {
    chevrons.classList.toggle('up', (dy ?? 1) < 0)
    chevrons.style.setProperty('--chev-dir', (dy ?? 1) < 0 ? '-10px' : '10px')
    position.classList.remove('scrolling')
    void position.offsetWidth
    position.classList.add('scrolling')
    clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => position.classList.remove('scrolling'), 320)
  }

  function tick(now: number): void {
    frame = 0
    if (!visible) return
    if (now >= expires) { hide(); return }
    if (document.hidden) return // Pause painting, but retain the position and deadline.
    if (!host.isConnected && document.documentElement) document.documentElement.append(host)
    // The cursor represents the last real tool position. DOM replacement,
    // scrolling, focus changes, and disappearing targets do not own its lifetime.
    const dt = Math.min((now - last) / 1000 || 1 / 60, .032)
    last = now
    if (reduced.matches) { x = targetX; y = targetY; vx = vy = 0; motionPath = null }
    else {
      // Independent critically damped springs preserve velocity on retarget.
      const steps = Math.ceil(dt / .008)
      const step = dt / steps
      for (let i = 0; i < steps; i++) {
        let goalX = targetX, goalY = targetY
        if (motionPath) {
          const path = motionPath
          // Spring-driven progress along a restrained quadratic arc. Retargets
          // start from the current presentation point, never an old endpoint.
          path.velocity += ((1 - path.progress) * 240 - path.velocity * 31) * step
          path.progress = Math.min(1, path.progress + path.velocity * step)
          const t = path.progress, u = 1 - t
          goalX = u * u * path.sx + 2 * u * t * path.cx + t * t * targetX
          goalY = u * u * path.sy + 2 * u * t * path.cy + t * t * targetY
          if (t > .998) motionPath = null
        }
        const stiffness = motionPath ? 520 : 260
        const damping = motionPath ? 45.6 : 32.3
        vx += ((goalX - x) * stiffness - vx * damping) * step
        vy += ((goalY - y) * stiffness - vy * damping) * step
        x += vx * step
        y += vy * step
      }
    }
    paint()
    const remaining = Math.hypot(targetX - x, targetY - y)
    if (pendingClick && remaining < 3) pulseClick()
    if (exiting && (remaining < 6 || y < -8)) { hide(); return }
    const resting = now - lastActivity > 1200 && !pendingClick
    position.classList.toggle('resting', resting)
    if (resting) position.classList.remove('working')
    frame = requestAnimationFrame(tick)
  }

  function keepAlive(): void {
    if (!positioned) return // Never invent a location for an unpositioned tool.
    lastActivity = performance.now()
    expires = lastActivity + lifetime
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => hide(), lifetime)
    clearTimeout(finishTimer)
    position.classList.remove('finishing')
    visible = true
    position.classList.add('shown')
    position.classList.remove('resting')
    host.style.setProperty('visibility', captureHidden || document.hidden ? 'hidden' : 'visible', 'important')
    if (!frame && !document.hidden) { last = performance.now(); frame = requestAnimationFrame(tick) }
  }

  /** Travel to a viewport point over an element. Returns the estimated arrival time in ms. */
  function travel(px: number, py: number, element: Element | null, kind: CursorActivity['kind'], dy?: number): number {
    const destinationChanged = Math.hypot(px - targetX, py - targetY) > 2
    const distance = Math.hypot(px - x, py - y)
    const wasPositioned = positioned
    if (positioned && destinationChanged && !reduced.matches && distance > 140) {
      const dx = px - x, ddy = py - y
      const arc = Math.min(60, distance * .12)
      motionPath = {
        sx: x, sy: y,
        cx: Math.max(0, Math.min(innerWidth, (x + px) / 2 - ddy / distance * arc)),
        cy: Math.max(0, Math.min(innerHeight, (y + py) / 2 + dx / distance * arc)),
        progress: 0, velocity: Math.max(0, (vx * dx + vy * ddy) / (distance * distance)),
      }
    } else if (destinationChanged) motionPath = null
    if (destinationChanged) pendingClick = false
    targetX = px; targetY = py
    if (!positioned || reduced.matches) { x = px; y = py; vx = vy = 0; paint() }
    positioned = true
    exiting = false
    parkedPose = false
    if (!visible) void position.offsetWidth // Commit the hidden style before materializing.
    visible = true
    host.style.setProperty('visibility', captureHidden || document.hidden ? 'hidden' : 'visible', 'important')
    position.classList.add('shown')
    position.classList.remove('resting', 'parked', 'exiting', 'thinking', 'finishing')
    position.classList.toggle('working', kind === 'type' || kind === 'scroll')
    if (kind === 'type') { showField(element); sweepField() } else showField(null)
    if (kind === 'click') {
      pendingClick = true
      hitElement = element
    } else pendingClick = false
    if (kind === 'scroll') pulseScroll(dy)
    keepAlive()
    if (document.hidden || captureHidden || reduced.matches) return 0
    if (!wasPositioned) return 200 // materialize fade only
    if (distance < 3) return 0
    // Critically damped springs settle in ~4/(zeta*omega) regardless of distance;
    // the arc adds its own progress spring. Long hops get a little slack.
    return (motionPath ? 300 : 230) + (distance > 600 ? 40 : 0)
  }

  function focusedField(): Element | null {
    let element: Element | null = document.activeElement
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement
    if (!element || element === document.body || element === document.documentElement || element instanceof HTMLIFrameElement) return null
    return element
  }

  function inViewport(px: number, py: number): boolean {
    return Number.isFinite(px) && Number.isFinite(py) && px >= 0 && py >= 0 && px < innerWidth && py < innerHeight
  }

  function park(): void {
    if (positioned) {
      parkedPose = true
      position.classList.add('parked')
      position.classList.remove('working', 'thinking', 'exiting')
      showField(null)
      keepAlive()
      return
    }
    if (innerWidth < 320 || innerHeight < 200) return
    // The agent lives in the side panel: the pointer arrives from the right edge.
    const parkX = innerWidth - 28
    const parkY = Math.min(innerHeight - 40, 96)
    const under = document.elementFromPoint(parkX, parkY)
    if (!under || under === host) return
    x = innerWidth + 24; y = parkY; vx = -200; vy = 0
    positioned = true
    paint()
    travel(parkX, parkY, null, 'move')
    parkedPose = true
    position.classList.add('parked')
  }

  function enter(px: number, toY: number): void {
    const ex = Math.max(12, Math.min(innerWidth - 12, px))
    x = ex; y = -14; vx = 0; vy = 260
    positioned = true
    paint()
    travel(ex, Math.max(24, Math.min(innerHeight - 24, toY)), null, 'move')
    // Landing from the strip reads as arrival, then the pointer settles into the parked pose.
    parkedPose = true
    position.classList.add('parked')
  }

  function exit(px: number): void {
    if (!positioned) return
    const ex = Math.max(-40, Math.min(innerWidth + 40, px))
    motionPath = null
    pendingClick = false
    targetX = ex; targetY = -14
    exiting = true
    parkedPose = false
    showField(null)
    position.classList.remove('working', 'thinking', 'parked', 'resting')
    position.classList.add('exiting')
    if (reduced.matches) { hide(); return }
    keepAlive()
    clearTimeout(exitTimer)
    exitTimer = setTimeout(() => { if (exiting) hide() }, 420)
  }

  function update(value: CursorActivity): number {
    captureHidden = value.captureHidden ?? false
    if (typeof value.lifetime === 'number' && value.lifetime > 0) lifetime = value.lifetime
    if (typeof value.armedFor === 'number') armedUntil = value.armedFor > 0 ? performance.now() + value.armedFor : 0
    if (value.kind === 'finish') {
      position.classList.remove('working', 'thinking')
      showField(null)
      if (!visible) return 0
      position.classList.add('finishing')
      clearTimeout(finishTimer)
      finishTimer = setTimeout(() => hide(), 620)
      return 0
    }
    if (value.kind === 'keepalive') { keepAlive(); return 0 }
    if (value.kind === 'thinking') {
      if (!positioned) return 0
      position.classList.remove('working')
      position.classList.add('thinking')
      showField(null)
      keepAlive()
      return 0
    }
    if (value.kind === 'visibility') {
      // Screenshots temporarily suppress painting without resetting the
      // destination, velocity, or idle deadline.
      host.style.setProperty('visibility', captureHidden || document.hidden || !visible ? 'hidden' : 'visible', 'important')
      return 0
    }
    if (value.kind === 'hide') { hide(value.immediate); return 0 }
    if (!host.isConnected && document.documentElement) document.documentElement.append(host)
    // A transformed root changes the fixed-position coordinate system.
    if (getComputedStyle(document.documentElement).transform !== 'none') { keepAlive(); return 0 }
    if (value.kind === 'park') { park(); return 0 }
    if (value.kind === 'exit') { exit(typeof value.x === 'number' && Number.isFinite(value.x) ? value.x : 40); return 0 }
    if (value.kind === 'enter') { enter(typeof value.x === 'number' && Number.isFinite(value.x) ? value.x : 40, value.toY ?? 88); return 0 }
    let px = value.x, py = value.y
    let element: Element | null = null
    if (value.kind === 'type') {
      element = focusedField()
      if (!element) { keepAlive(); return 0 }
      const rect = rectOf(element)
      // Point next to the field's edge instead of covering the text being entered.
      px = rect.right - 5
      py = rect.top + Math.min(rect.height / 2, 14)
    }
    if (typeof px !== 'number' || typeof py !== 'number' || !inViewport(px, py)) { keepAlive(); return 0 }
    element ??= document.elementFromPoint(px, py)
    if (!element || element === host) { keepAlive(); return 0 }
    const rect = rectOf(element)
    if (!rect.width || !rect.height || getComputedStyle(element).visibility !== 'visible') { keepAlive(); return 0 }
    return travel(px, py, element, value.kind, value.dy)
  }

  /* ---- Synthetic-event observer: agent-driven JS actions move the pointer locally. ---- */
  function armed(): boolean { return armedUntil > performance.now() }
  function eventTarget(event: Event): Element | null {
    const first = event.composedPath()[0]
    const node = first instanceof Element ? first : first instanceof Node ? first.parentElement : null
    if (!node || node === host || host.contains(node)) return null
    return node
  }
  function centerOf(element: Element): { x: number; y: number } | null {
    const rect = rectOf(element)
    if (!rect.width || !rect.height) return null
    const cx = Math.max(rect.left + 2, Math.min(rect.right - 2, rect.left + rect.width / 2))
    const cy = Math.max(rect.top + 2, Math.min(rect.bottom - 2, rect.top + rect.height / 2))
    return inViewport(cx, cy) ? { x: cx, y: cy } : null
  }
  function localRetarget(element: Element, kind: 'click' | 'move' | 'type' | 'scroll', dy?: number): void {
    const now = performance.now()
    if (now - lastLocalRetarget < 120 && kind !== 'click') return
    lastLocalRetarget = now
    if (kind === 'type') {
      const fieldEl = focusedField()
      if (!fieldEl) return
      const rect = rectOf(fieldEl)
      const px = rect.right - 5, py = rect.top + Math.min(rect.height / 2, 14)
      if (!inViewport(px, py)) return
      travel(px, py, fieldEl, 'type')
      return
    }
    const point = centerOf(element)
    if (!point) return
    travel(point.x, point.y, element, kind, dy)
  }
  const onSyntheticClick = (event: Event): void => {
    if (event.isTrusted || !armed()) return
    const element = eventTarget(event)
    if (element) localRetarget(element, 'click')
  }
  const onFocusIn = (event: Event): void => {
    if (!armed()) return
    const element = eventTarget(event)
    if (!element || element === document.body) return
    const editable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element as HTMLElement).isContentEditable
    if (!editable) return
    localRetarget(element, 'type')
  }
  const onSyntheticInput = (event: Event): void => {
    if (event.isTrusted || !armed()) return
    const element = eventTarget(event)
    if (!element) return
    localRetarget(element, 'type')
  }
  const onSubmit = (event: Event): void => {
    if (!armed()) return
    const form = eventTarget(event)
    if (!(form instanceof HTMLFormElement)) return
    const button = form.querySelector('button[type=submit],input[type=submit],button:not([type])') ?? form
    localRetarget(button, 'click')
  }
  let lastScrollY = scrollY, scrollDebounce: ReturnType<typeof setTimeout> | undefined
  const onScroll = (event: Event): void => {
    if (!armed() || !positioned) return
    clearTimeout(scrollDebounce)
    scrollDebounce = setTimeout(() => {
      const dy = scrollY - lastScrollY
      lastScrollY = scrollY
      if (Math.abs(dy) < 4 && event.target === document) return
      // Wheel-driven scrolls already announce themselves via Input.dispatchMouseEvent;
      // programmatic ones show at the pointer's current spot.
      if (!inViewport(x, y)) return
      pulseScroll(dy)
      position.classList.add('working')
      keepAlive()
    }, 80)
  }
  document.addEventListener('click', onSyntheticClick, true)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('input', onSyntheticInput, true)
  document.addEventListener('change', onSyntheticInput, true)
  document.addEventListener('submit', onSubmit, true)
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })

  const onVisibilityChange = (): void => {
    host.style.setProperty('visibility', captureHidden || document.hidden || !visible ? 'hidden' : 'visible', 'important')
    if (!document.hidden && visible && !frame) { last = performance.now(); frame = requestAnimationFrame(tick) }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  scope[key] = {
    version: VERSION,
    update,
    dispose: () => {
      hide(true)
      for (const timer of [clickTimer, pressTimer, scrollTimer, finishTimer, exitTimer, sweepTimer, hitTimer, scrollDebounce]) clearTimeout(timer)
      hitElement = null; fieldElement = null; syncBoxListeners()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      document.removeEventListener('click', onSyntheticClick, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('input', onSyntheticInput, true)
      document.removeEventListener('change', onSyntheticInput, true)
      document.removeEventListener('submit', onSubmit, true)
      document.removeEventListener('scroll', onScroll, { capture: true })
      host.remove()
    },
  }
  return update(activity)
}
