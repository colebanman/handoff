/**
 * Accessibility-tree snapshot: fetches the full AX tree over CDP, filters
 * ignored/uninteresting nodes, assigns stable document-scoped refs to
 * interactive nodes and context nodes, and serializes an indented outline
 * that is the model's primary perception of the page.
 *
 * Line format (indent = tree depth):
 *   [e12] button "Sign in"
 *   [e13] textbox "Email" value="user@example.com"
 *   [e14] link "Assignments" → /courses/1/assignments
 *         heading "Upcoming"
 *   [e21] checkbox "Remember me" [checked]
 *
 * Interactive nodes get actionable e refs; pure-text/context nodes get n IDs. Header line carries URL / title / tab id.
 *
 * Autofill: fields Chrome has autofilled (saved passwords/addresses) are
 * tagged `[autofilled]`. Chrome hides autofilled values from scripts AND the
 * AX tree until a real user gesture, so these fields look empty in the
 * snapshot while actually being filled — the tag is the only signal. Detected
 * via the `:autofill` CSS pseudo-class, matched back to AX nodes by backend
 * DOM node id.
 */

import { sliceWellFormed } from '../shared/text'
import { renderBrowserSnapshot } from '../shared/browser-snapshot'

/* ---- Minimal local CDP typings (do not pull in devtools-protocol) ---- */

interface AXValue {
  type?: string
  value?: unknown
}

interface AXProperty {
  name: string
  value?: AXValue
}

interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  description?: AXValue
  value?: AXValue
  properties?: AXProperty[]
  childIds?: string[]
  backendDOMNodeId?: number
  frameId?: string
}

/** Owned by one attached tab, never by an individual model request. A new
 * document/session gets a new namespace, so stale refs cannot target a new node. */
export class SnapshotReferences {
  document = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  revision = 0
  private root?: string
  private next = 0
  private refs = new Map<string, string>()

  begin(root: string): void {
    if (this.root !== undefined && this.root !== root) {
      this.document = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      this.revision = 0
      this.next = 0
      this.refs.clear()
    }
    this.root = root
    this.revision++
  }

  ref(key: string, interactive: boolean): string {
    const identity = `${interactive ? 'e' : 'n'}:${key}`
    let ref = this.refs.get(identity)
    if (!ref) {
      ref = `${interactive ? 'e' : 'n'}${this.document}-${++this.next}`
      this.refs.set(identity, ref)
    }
    return ref
  }

  retain(keys: Set<string>): void {
    for (const key of this.refs.keys()) if (!keys.has(key)) this.refs.delete(key)
  }
}

export interface GetFullAXTreeResult {
  nodes: AXNode[]
}

/** The `send` fn the service passes in (attaches on demand). */
export type SendFn = <T = unknown>(method: string, params?: object) => Promise<T>

export interface BuildSnapshotResult {
  text: string
  /** ref (e.g. "e12") -> backendDOMNodeId */
  refMap: Map<string, number>
  refDescriptions: Map<string, { role: string; name: string }>
}

/** Roles considered interactive → always get a ref. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'slider',
  'spinbutton',
  'switch',
  'listbox',
  'scrollbar',
  'treeitem',
])

/** Roles that carry useful context text but are not interactive (no ref). */
const CONTEXT_ROLES = new Set([
  'dialog',
  'alertdialog',
  'form',
  'region',
  'group',
  'heading',
  'paragraph',
  'text',
  'StaticText',
  'staticText',
  'listitem',
  'cell',
  'columnheader',
  'rowheader',
  'article',
  'blockquote',
  'code',
  'term',
  'definition',
  'caption',
  'figcaption',
  'label',
  'log',
  'status',
  'alert',
])

function strVal(v: AXValue | undefined): string {
  if (!v || v.value === undefined || v.value === null) return ''
  return typeof v.value === 'string' ? v.value : String(v.value)
}

function propMap(node: AXNode): Map<string, AXValue | undefined> {
  const m = new Map<string, AXValue | undefined>()
  for (const p of node.properties ?? []) m.set(p.name, p.value)
  return m
}

function boolProp(m: Map<string, AXValue | undefined>, name: string): boolean {
  const v = m.get(name)
  return v?.value === true || v?.value === 'true'
}

/** Collapse whitespace and cap a name so a single label can't blow the budget. */
function cleanName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim()
  return n.length > 200 ? sliceWellFormed(n, 200) + '…' : n
}

/* ---- Autofill detection -------------------------------------------- */

interface RemoteObject {
  objectId?: string
}

interface EvaluateResult {
  result?: RemoteObject
}

interface GetPropertiesResult {
  result?: Array<{ name: string; value?: RemoteObject }>
}

interface DescribeNodeResult {
  node?: { backendNodeId?: number }
}

const MAX_AUTOFILL_FIELDS = 20

/**
 * Collect form fields the browser has autofilled (`:autofill` matches even
 * while the value is still hidden from scripts), walking same-origin iframes
 * too. Returns raw elements so the caller can map them to backend node ids.
 */
const AUTOFILL_SCAN_JS = `(() => {
  const out = [];
  const visit = (doc) => {
    if (!doc || out.length >= ${MAX_AUTOFILL_FIELDS}) return;
    let els = [];
    try { els = doc.querySelectorAll('input, textarea, select'); } catch (e) { return; }
    for (const el of els) {
      if (out.length >= ${MAX_AUTOFILL_FIELDS}) return;
      let hit = false;
      try { hit = el.matches(':autofill'); } catch (e) {}
      if (!hit) { try { hit = el.matches(':-webkit-autofill'); } catch (e) {} }
      if (hit) out.push(el);
    }
    let frames = [];
    try { frames = doc.querySelectorAll('iframe, frame'); } catch (e) {}
    for (const f of frames) { try { visit(f.contentDocument); } catch (e) {} }
  };
  visit(document);
  return out;
})()`

/**
 * Best-effort set of backendDOMNodeIds for autofilled fields. Any failure
 * (mid-navigation, scripting blocked, detached frame) yields an empty set —
 * the snapshot simply goes out untagged.
 */
async function detectAutofilledBackendIds(send: SendFn): Promise<Set<number>> {
  const ids = new Set<number>()
  const objectGroup = 'ax-autofill-scan'
  try {
    const evaluated = await send<EvaluateResult>('Runtime.evaluate', {
      expression: AUTOFILL_SCAN_JS,
      returnByValue: false,
      objectGroup,
    })
    const arrayId = evaluated.result?.objectId
    if (!arrayId) return ids
    const props = await send<GetPropertiesResult>('Runtime.getProperties', {
      objectId: arrayId,
      ownProperties: true,
    })
    for (const prop of props.result ?? []) {
      if (!/^\d+$/.test(prop.name)) continue
      const objectId = prop.value?.objectId
      if (!objectId) continue
      try {
        const described = await send<DescribeNodeResult>('DOM.describeNode', { objectId })
        const backendId = described.node?.backendNodeId
        if (backendId !== undefined) ids.add(backendId)
      } catch {
        // Element vanished between scan and describe; skip it.
      }
    }
  } catch {
    // Best-effort only.
  } finally {
    try {
      await send('Runtime.releaseObjectGroup', { objectGroup })
    } catch {
      // Context may be gone; nothing to release.
    }
  }
  return ids
}

/**
 * Build the snapshot from a live send fn. Enables Accessibility then fetches
 * the full AX tree, walks it in document order, and serializes.
 */
export async function buildSnapshot(
  send: SendFn,
  header: { tabId: number; url: string; title: string; tabList?: string },
  references = new SnapshotReferences(),
): Promise<BuildSnapshotResult> {
  await send('Accessibility.enable')
  const autofilled = await detectAutofilledBackendIds(send)
  const tree = await send<GetFullAXTreeResult>('Accessibility.getFullAXTree')
  const nodes = tree.nodes ?? []

  const byId = new Map<string, AXNode>()
  for (const n of nodes) byId.set(n.nodeId, n)

  // Determine the root: a node that is not referenced as any node's child.
  const childIds = new Set<string>()
  for (const n of nodes) for (const c of n.childIds ?? []) childIds.add(c)
  const roots = nodes.filter((n) => !childIds.has(n.nodeId))
  references.begin(roots.map((node) => `${node.frameId ?? ''}:${node.nodeId}:${node.backendDOMNodeId ?? ''}`).join('|'))

  const refMap = new Map<string, number>()
  const refDescriptions = new Map<string, { role: string; name: string }>()
  const lines: string[] = []
  const liveIdentities = new Set<string>()
  const visited = new Set<string>()

  const emit = (node: AXNode, depth: number): void => {
    if (visited.has(node.nodeId)) return
    visited.add(node.nodeId)

    const role = strVal(node.role)
    const name = cleanName(strVal(node.name))
    const ignored = node.ignored === true

    const isInteractive = !ignored && INTERACTIVE_ROLES.has(role)
    const isContext = !ignored && CONTEXT_ROLES.has(role) && name.length > 0

    // A node is "kept" (emits a line) if interactive, or context-with-name.
    let keptDepth = depth
    if (isInteractive || isContext) {
      const indent = '  '.repeat(depth)
      const actionable = isInteractive && node.backendDOMNodeId !== undefined
      const key = `${node.frameId ?? ''}:${node.nodeId}:${node.backendDOMNodeId ?? ''}`
      const ref = references.ref(key, actionable)
      liveIdentities.add(`${actionable ? 'e' : 'n'}:${key}`)
      let line = `${indent}[${ref}] ${role}`
      if (actionable) {
        refMap.set(ref, node.backendDOMNodeId!)
        refDescriptions.set(ref, { role, name })
      }
      if (name.length > 0) line += ` "${name}"`

      const m = propMap(node)

      // Editable value (textbox/combobox/searchbox/spinbutton).
      const val = strVal(node.value)
      if (val.length > 0 && (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton')) {
        const shown = val.length > 100 ? sliceWellFormed(val, 100) + '…' : val
        line += ` value="${shown.replace(/\s+/g, ' ')}"`
      }

      // Link href, when available via a URL property.
      if (role === 'link') {
        const href = strVal(m.get('url')) || strVal(node.description)
        if (href.length > 0) line += ` → ${href}`
      }

      // State flags.
      const flags: string[] = []
      const checked = m.get('checked')
      if (checked && checked.value !== undefined && checked.value !== false && checked.value !== 'false') {
        flags.push(checked.value === 'mixed' ? 'mixed' : 'checked')
      }
      if (boolProp(m, 'disabled')) flags.push('disabled')
      const expanded = m.get('expanded')
      if (expanded && expanded.value !== undefined) flags.push(expanded.value === true || expanded.value === 'true' ? 'expanded' : 'collapsed')
      if (boolProp(m, 'selected')) flags.push('selected')
      if (boolProp(m, 'required')) flags.push('required')
      if (boolProp(m, 'focused')) flags.push('focused')
      if (boolProp(m, 'busy')) flags.push('busy')
      if (boolProp(m, 'modal')) flags.push('modal')
      if (boolProp(m, 'readonly')) flags.push('readonly')
      const invalid = strVal(m.get('invalid'))
      if (invalid && invalid !== 'false') flags.push(`invalid=${invalid}`)
      // Chrome-autofilled field: really filled, but the value is hidden from
      // scripts/AX until a user gesture — the tag is the only visible signal.
      if (node.backendDOMNodeId !== undefined && autofilled.has(node.backendDOMNodeId)) flags.push('autofilled')
      for (const f of flags) line += ` [${f}]`

      lines.push(line)
      keptDepth = depth + 1
    }

    for (const cid of node.childIds ?? []) {
      const child = byId.get(cid)
      if (child) emit(child, keptDepth)
    }
  }

  for (const r of roots) emit(r, 0)
  references.retain(liveIdentities)

  const headerLines: string[] = []
  headerLines.push(`URL ${header.url} | title ${header.title} | tab ${header.tabId}`)
  if (header.tabList) headerLines.push(header.tabList)
  const text = renderBrowserSnapshot({
    tabId: header.tabId, document: references.document, revision: references.revision,
    header: headerLines.join('\n'), lines,
  })

  return { text, refMap, refDescriptions }
}
