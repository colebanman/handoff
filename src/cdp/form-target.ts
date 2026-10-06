/** These functions are serialized into the page; keep all helpers local. */
export function formTargetCanFocus(this: Element): boolean {
  if (!this.isConnected || !this.getClientRects().length) return false
  const parent = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ??
    ((el.getRootNode() as ShadowRoot).host ?? null)
  for (let el: Element | null = this; el; el = parent(el)) {
    if (el.matches(':disabled,[disabled],[readonly],[aria-readonly="true"],[aria-disabled="true"],[aria-hidden="true"],[inert]')) return false
  }
  return this.ownerDocument.defaultView?.getComputedStyle(this).visibility !== 'hidden'
}

export function formTargetReceivesPointer(this: Element, x: number, y: number): boolean {
  const parent = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ??
    ((el.getRootNode() as ShadowRoot).host ?? null)
  if (!this.isConnected) return false
  for (let el: Element | null = this; el; el = parent(el)) {
    if (el.matches(':disabled,[disabled],[aria-disabled="true"],[aria-hidden="true"],[inert]')) return false
  }
  let hit = this.ownerDocument.elementFromPoint(x, y)
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y)
    if (!inner || inner === hit) break
    hit = inner
  }
  for (let el = hit; el; el = parent(el)) if (el === this) return true
  return false
}

export function formTargetHasFocus(this: Element): boolean {
  const parent = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ??
    ((el.getRootNode() as ShadowRoot).host ?? null)
  if (!this.isConnected) return false
  for (let el: Element | null = this; el; el = parent(el)) {
    if (el.matches(':disabled,[disabled],[readonly],[aria-readonly="true"],[aria-disabled="true"],[aria-hidden="true"],[inert]')) return false
  }
  let active = this.ownerDocument.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  for (let el = active; el; el = parent(el)) if (el === this) return true
  return false
}
