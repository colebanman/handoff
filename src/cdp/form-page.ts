import type { FormField } from '../shared/form-fill'

/** Serialized into the target's realm. All helpers must remain inside this
 * function. The remote object lives for ONE fill; no page globals or durable refs.
 * Methods inspect DOM state; only nativeSelect changes it (native input/change).
 */
export function createFormSession(this: Element, specs: FormField[], ...elements: Element[]) {
  const doc = this.ownerDocument
  const win = doc.defaultView!
  const originalUrl = win.location.href
  const normalize = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
  const parent = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ??
    (el.getRootNode() instanceof win.ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null)
  const closest = (el: Element, selector: string): Element | null => {
    for (let current: Element | null = el; current; current = parent(current)) if (current.matches(selector)) return current
    return null
  }
  const contains = (ancestor: Element, el: Element | null) => {
    for (let current = el; current; current = parent(current)) if (current === ancestor) return true
    return false
  }
  const query = (scope: ParentNode, selector: string): Element[] => {
    const found: Element[] = [], seen = new Set<Element>()
    const visit = (node: ParentNode) => {
      if (node instanceof win.Element) {
        if (seen.has(node)) return
        seen.add(node)
        if (node.matches(selector)) found.push(node)
        if (node.shadowRoot) visit(node.shadowRoot)
        if (node instanceof win.HTMLSlotElement) for (const assigned of node.assignedElements({ flatten: true })) visit(assigned)
      }
      for (const child of node.children) visit(child)
    }
    visit(scope)
    return found
  }
  const focused = () => {
    let active = doc.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    return active
  }
  const visible = (el: Element) => el.isConnected && !closest(el, '[aria-hidden="true"], [inert]') &&
    el.getClientRects().length > 0 && win.getComputedStyle(el).visibility === 'visible'
  const disabled = (el: Element) => !!closest(el, ':disabled, [disabled], [aria-disabled="true"], [inert]')
  const role = (el: Element) => el.getAttribute('role') ?? ''
  const kind = (el: Element) => {
    if (el instanceof win.HTMLSelectElement) return 'native-select'
    if (el instanceof win.HTMLInputElement && el.type === 'checkbox' || role(el) === 'checkbox' || role(el) === 'switch') return 'checkbox'
    if (el instanceof win.HTMLInputElement && role(el) === 'combobox') return 'combobox'
    if (el instanceof win.HTMLInputElement && !['button', 'submit', 'reset', 'file', 'hidden', 'radio', 'color', 'range'].includes(el.type) ||
      el instanceof win.HTMLTextAreaElement || (el as HTMLElement).isContentEditable) return 'text'
    if (role(el) === 'combobox' || el.matches('button, [role="button"]') &&
      (el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded'))) return 'select'
    return 'unsupported'
  }
  const linked = (el: Element, attr: string) => (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)
    .map(id => (el.getRootNode() as Document | ShadowRoot).getElementById?.(id)).filter((n): n is HTMLElement => !!n)
  const hasPart = (el: Element, part: string) => Array.from(el.classList).some(c => c.endsWith(`__${part}`))
  const singleValue = (el: Element) => hasPart(el, 'single-value') || Array.from(el.classList).some(c => c.endsWith('-singleValue'))
  /** React Select separates its editable query from its committed label. Scope
   * the reader to a grounded component shape, never arbitrary nearby text. This
   * supports classNamePrefix variants as well as the default generated classes. */
  const reactValueContainer = (el: Element): Element | undefined => {
    if (kind(el) !== 'combobox') return undefined
    const wrapper = el.parentElement
    const container = wrapper?.hasAttribute('data-value') ? wrapper.parentElement : wrapper
    if (!container || query(container, '[role="combobox"]').length !== 1) return undefined
    const knownIds = [el.id, el.getAttribute('aria-describedby'), el.getAttribute('aria-controls')].join(' ')
    const focusProxy = el.getAttribute('aria-readonly') === 'true' && el.getAttribute('inputmode') === 'none'
    if (hasPart(container, 'value-container') || (wrapper?.hasAttribute('data-value') || focusProxy) &&
      (/\breact-select-/.test(knownIds) || Array.from(container.children).some(singleValue))) return container
    return undefined
  }
  const label = (el: Element) => {
    const labels = (el as HTMLInputElement).labels
    const candidates = [linked(el, 'aria-labelledby').filter(n => n !== el).map(n => n.textContent).join(' '),
      labels?.length ? Array.from(labels).map(n => n.textContent).join(' ') : '',
      el.getAttribute('aria-label'), closest(el, '[label]')?.getAttribute('label'), closest(el, '[role="group"][aria-label]')?.getAttribute('aria-label'),
      closest(el, 'fieldset')?.querySelector('legend')?.textContent].map(normalize).filter(Boolean)
    const value = normalize((el as HTMLElement).innerText)
    return candidates.find(text => kind(el) !== 'select' || text !== value && text !== `${value} Required`) ?? ''
  }
  const controlSelector = 'input,textarea,select,button,[role="button"],[role="combobox"],[role="checkbox"],[role="switch"],[contenteditable="true"]'
  const popupSelector = '[role="listbox"]'
  const form = closest(this, 'form')
  const root = form && elements.every(el => contains(form, el)) ? form : doc.body
  const shadowScope = (el: Element) => {
    const hosts: unknown[] = []
    for (let scope = el.getRootNode(); scope instanceof win.ShadowRoot; scope = scope.host.getRootNode()) {
      const host = scope.host
      hosts.push([host.tagName, host.id, host.getAttribute('name'), host.getAttribute('label'), host.getAttribute('aria-label')])
    }
    return hosts
  }
  const identity = (el: Element) => JSON.stringify([shadowScope(el), el.tagName, el.getAttribute('type'), role(el), el.id, el.getAttribute('name'), label(el)])
  const controls = () => query(root, controlSelector).filter(el => visible(el) &&
    !closest(el, popupSelector) && role(el) !== 'option' && !closest(el, '[data-handoff-cursor], [data-handoff-sticky]'))
  // Submit/navigation buttons commonly enable during ordinary validation.
  // Their presence matters, but their enabled state is not a field dependency.
  const topology = () => JSON.stringify(controls().map(el => [identity(el), kind(el) === 'unsupported' ? null : disabled(el), el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
    !!closest(el, '[readonly], [aria-readonly="true"]')]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  const bindings = elements.map((node, index) => {
    if (node.ownerDocument !== doc || !node.isConnected) throw new Error('All fields must be live in the same document')
    for (let scope = node.getRootNode(); scope instanceof win.ShadowRoot; scope = scope.host.getRootNode()) {
      if (scope.host.shadowRoot !== scope) throw new Error('Closed shadow-root fields require individual actions')
    }
    const key = identity(node)
    return { node, key, rebind: !!(node.id || label(node) || node.getAttribute('name')) && controls().filter(n => identity(n) === key).length === 1,
      spec: specs[index]!, expected: undefined as string | boolean | undefined, seenPopups: [] as Element[] }
  })
  const initialTopology = topology()
  const node = (index: number) => {
    if (win.location.href !== originalUrl || !root.isConnected) throw new Error('Page changed during fill')
    const b = bindings[index]!
    if (b.node.isConnected && identity(b.node) === b.key) return b.node
    const candidates = b.rebind ? controls().filter(n => identity(n) === b.key) : []
    if (candidates.length !== 1) throw new Error('Field detached or changed; take a fresh snapshot')
    return b.node = candidates[0]!
  }
  const popups = () => query(doc, popupSelector).filter(visible)
  const popup = (index: number) => {
    const el = node(index), b = bindings[index]!
    const ids = [...linked(el, 'aria-controls'), ...linked(el, 'aria-owns')]
    const explicit = [...new Set(ids.flatMap(n => query(n, popupSelector)).filter(visible))]
    if (explicit.length > 1) throw new Error('Ambiguous popup relationship')
    if (explicit.length === 1) return explicit[0]!
    if (normalize(el.getAttribute('aria-controls')) || normalize(el.getAttribute('aria-owns'))) return undefined
    // Missing explicit links: accept only a unique NEW listbox after this field
    // was activated, with expansion/focus evidence. Never reuse an old popup.
    if (el.getAttribute('aria-expanded') !== 'true' && !contains(el, focused())) return undefined
    const fresh = popups().filter(n => !b.seenPopups.includes(n))
    if (fresh.length > 1) throw new Error('Multiple popups appeared; cannot attribute options to this field')
    return fresh[0]
  }
  const read = (el: Element): string | boolean | null => {
    if (kind(el) === 'checkbox') return el instanceof win.HTMLInputElement ? (el.indeterminate ? null : el.checked) :
      el.getAttribute('aria-checked') === 'true' ? true : el.getAttribute('aria-checked') === 'false' ? false : null
    if (el instanceof win.HTMLSelectElement) return normalize(el.selectedOptions[0]?.label)
    const container = reactValueContainer(el)
    if (container) {
      const values = Array.from(container.children).filter(n => singleValue(n) && visible(n))
      return values.length === 1 ? normalize((values[0] as HTMLElement).innerText) : null
    }
    if (el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement) return el.value
    if ((el as HTMLElement).isContentEditable) return (el as HTMLElement).innerText
    return normalize(el.getAttribute('aria-valuetext') || (el as HTMLElement).innerText).replace(/\s+Required$/, '')
  }
  const state = (index: number) => {
    const el = node(index)
    return { kind: kind(el), value: read(el), disabled: disabled(el), visible: visible(el),
      readonly: !!closest(el, '[readonly], [aria-readonly="true"]'),
      expanded: el.getAttribute('aria-expanded') === 'true', busy: !!closest(el, '[aria-busy="true"]'),
      invalid: el.getAttribute('aria-invalid') === 'true' }
  }
  const satisfied = (index: number) => {
    const s = state(index)
    return s.value === bindings[index]!.expected && s.visible && !s.busy && !s.invalid && !s.expanded
  }
  return {
    node,
    actionNode(index: number) {
      const el = node(index)
      // React Select's non-searchable input is a tiny focus proxy. Open the
      // enclosing control, whose relationship was established above.
      return el instanceof win.HTMLInputElement && el.matches('[readonly],[aria-readonly="true"]') ? reactValueContainer(el)?.parentElement ?? el : el
    },
    prepare(index: number) {
      const b = bindings[index]!, el = node(index), s = state(index), spec = b.spec
      if (topology() !== initialTopology) throw new Error('Form structure changed; inspect new or changed fields')
      const readonlyChoice = 'select' in spec && s.kind === 'combobox' && el instanceof win.HTMLInputElement && el.matches('[readonly],[aria-readonly="true"]')
      if (!s.visible || s.disabled || s.readonly && !readonlyChoice) throw new Error('Field is hidden, disabled or readonly')
      if ('text' in spec) {
        if (s.kind === 'combobox') throw new Error('Use select with an exact option label for this combobox; typing a query is not a committed answer')
        if (s.kind !== 'text') throw new Error('Text requires an input, textarea or editable field')
        if (spec.clear === false && (!(el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement) || el.selectionStart === null)) {
          throw new Error('Cannot verify append at this caret; use browser_type and inspect its result')
        }
        const input = el as HTMLInputElement
        const text = spec.text.replace(/\r\n?/g, '\n')
        b.expected = spec.clear === false ? input.value.slice(0, input.selectionStart!) + text + input.value.slice(input.selectionEnd!) : text
      } else if ('checked' in spec) {
        if (s.kind !== 'checkbox') throw new Error('checked requires a checkbox or switch')
        if (s.value === null) throw new Error('Checkbox state is mixed or unknown; inspect it before changing it')
        b.expected = spec.checked
      } else {
        if (s.kind !== 'native-select' && s.kind !== 'select' && s.kind !== 'combobox') throw new Error('Unsupported dropdown; inspect its interaction first')
        if (el instanceof win.HTMLSelectElement && el.multiple) throw new Error('Multiple selection requires an explicit interaction')
        const container = reactValueContainer(el)
        if (container && (hasPart(container, 'value-container--is-multi') || query(container, '*').some(n => hasPart(n, 'multi-value')))) {
          throw new Error('Multiple selection requires an explicit interaction')
        }
        b.expected = normalize(spec.select)
        b.seenPopups = popups()
      }
      return { kind: s.kind, satisfied: satisfied(index), searchable: s.kind === 'combobox' && !s.readonly,
        clearQuery: el instanceof win.HTMLInputElement && el.value.length > 0,
        expanded: s.expanded || (s.kind === 'select' || s.kind === 'combobox') && !!popup(index) }
    },
    option(index: number) {
      const p = popup(index)
      if (!p || closest(p, '[aria-busy="true"]')) return null
      if (p.getAttribute('aria-multiselectable') === 'true') throw new Error('Multiple selection requires an explicit interaction')
      const options = query(p, '[role="option"]').filter(el => visible(el) && !disabled(el) &&
        normalize(el.getAttribute('aria-label') || (el as HTMLElement).innerText) === bindings[index]!.expected)
      if (options.length > 1) throw new Error('Ambiguous option: more than one exact match')
      // A lazily populated popup may initially have no matching option.
      return options[0] ?? null
    },
    nativeSelect(index: number) {
      const el = node(index) as HTMLSelectElement
      if (!(el instanceof win.HTMLSelectElement) || disabled(el) || !visible(el) || el.multiple) throw new Error('Native select changed before selection')
      const options = Array.from(el.options).filter(o => normalize(o.label) === bindings[index]!.expected && !o.disabled && !o.closest('optgroup[disabled]'))
      if (options.length !== 1) throw new Error('Native option missing, disabled or ambiguous')
      for (const option of Array.from(el.options)) option.selected = option === options[0]
      el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }))
      el.dispatchEvent(new win.Event('change', { bubbles: true, composed: true }))
    },
    verify(index: number) {
      return { satisfied: satisfied(index) }
    },
    audit(count: number) {
      const unconfirmed: number[] = []
      for (let index = 0; index < count; index++) {
        try { if (!satisfied(index)) unconfirmed.push(index) } catch { unconfirmed.push(index) }
      }
      return { unconfirmed, changed: topology() !== initialTopology }
    },
  }
}
