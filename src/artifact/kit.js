/*
 * Artifact kit components — <ai-*> custom elements injected into every HTML
 * artifact after the runtime (kit.css supplies the styling). Light DOM on
 * purpose: the kit stylesheet applies directly, the agent can inspect and
 * patch rendered markup with api.artifacts.eval, and users can select text.
 *
 * Data goes in through properties (el.rows = [...]) or JSON attributes
 * (rows='[...]'); components re-render on change. See /skills/artifacts/SKILL.md.
 */
;(function () {
  'use strict'
  if (window.AiKit) return

  /* ---------------- helpers ---------------- */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function h(tag, attrs) {
    var el = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key]
        if (value === undefined || value === null || value === false) return
        if (key === 'class') el.className = value
        else if (key === 'text') el.textContent = value
        else if (key === 'html') el.innerHTML = value
        else if (key.slice(0, 2) === 'on' && typeof value === 'function') el.addEventListener(key.slice(2), value)
        else el.setAttribute(key, value === true ? '' : value)
      })
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i])
    return el
  }

  function append(parent, child) {
    if (child === undefined || child === null || child === false) return
    if (Array.isArray(child)) return child.forEach(function (c) { append(parent, c) })
    if (child instanceof Node) return parent.appendChild(child)
    parent.appendChild(document.createTextNode(String(child)))
  }

  function parseJsonAttr(el, name, fallback) {
    var raw = el.getAttribute(name)
    if (!raw) return fallback
    try {
      return JSON.parse(raw)
    } catch (e) {
      console.error('<' + el.tagName.toLowerCase() + '> invalid JSON in ' + name + ':', e.message)
      return fallback
    }
  }

  function parseDuration(raw) {
    var m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(String(raw || ''))
    if (!m) return 0
    var n = Number(m[1])
    var unit = m[2] || 'm'
    return n * (unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000)
  }

  function timeAgo(ms) {
    var diff = Math.max(0, Date.now() - ms)
    if (diff < 45000) return 'just now'
    var mins = Math.round(diff / 60000)
    if (mins < 60) return mins + 'm ago'
    var hours = Math.round(mins / 60)
    if (hours < 24) return hours + 'h ago'
    return Math.round(hours / 24) + 'd ago'
  }

  function toDate(value) {
    if (value instanceof Date) return isNaN(value) ? null : value
    if (value === undefined || value === null || value === '') return null
    var d = new Date(value)
    return isNaN(d) ? null : d
  }

  function dayKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  }

  function fmtDate(value, opts) {
    var d = toDate(value)
    if (!d) return ''
    return d.toLocaleDateString(undefined, opts || { month: 'short', day: 'numeric' })
  }

  function fmtTime(value) {
    var d = toDate(value)
    if (!d) return ''
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }

  function fmtDateTime(value) {
    var d = toDate(value)
    if (!d) return ''
    return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }

  function fmtNumber(value, opts) {
    if (typeof value !== 'number') return String(value == null ? '' : value)
    return value.toLocaleString(undefined, opts)
  }

  function openHref(href) {
    if (!href) return
    if (window.ai && typeof window.ai.open === 'function') window.ai.open(href)
    else window.open(href, '_blank', 'noopener')
  }

  /** Base class: property/attribute reactive, renders into light DOM. */
  class KitElement extends HTMLElement {
    constructor() {
      super()
      this._rendered = false
      this._scheduled = false
    }
    connectedCallback() {
      this._schedule()
    }
    attributeChangedCallback() {
      if (this.isConnected) this._schedule()
    }
    _captureChildren() {
      // Children written by the author, kept so re-renders can re-use them.
      this._children = Array.from(this.childNodes)
    }
    _schedule() {
      // During the initial parse an element connects before its children
      // exist, so the first render waits for the document to finish parsing.
      var self = this
      if (!this._rendered && document.readyState === 'loading') {
        if (!this._deferred) {
          this._deferred = true
          document.addEventListener('DOMContentLoaded', function () { self._schedule() }, { once: true })
        }
        return
      }
      if (this._scheduled) return
      this._scheduled = true
      var self = this
      // These are content updates, including in hidden verification windows.
      // Animation frames can be suspended there indefinitely.
      queueMicrotask(function () {
        self._scheduled = false
        if (!self._rendered) self._captureChildren()
        self._rendered = true
        try {
          self._paint()
        } catch (e) {
          console.error('<' + self.tagName.toLowerCase() + '> render failed:', e)
        }
      })
    }
    _paint() { this.render() }
    /** Author-provided children not marked with slot=… */
    _content() {
      return (this._children || []).filter(function (n) {
        return !(n.nodeType === 1 && n.getAttribute('slot'))
      })
    }
    _slot(name) {
      return (this._children || []).filter(function (n) {
        return n.nodeType === 1 && n.getAttribute('slot') === name
      })
    }
    _replace() {
      this.textContent = ''
      for (var i = 0; i < arguments.length; i++) append(this, arguments[i])
    }
    render() {}
  }

  /* ---------------- icons ---------------- */

  // Lucide-style 24px stroke icons. "c:" circle cx,cy,r · "r:" rect x,y,w,h,rx · else a path.
  var ICONS = {
    info: ['c:12,12,10', 'M12 16v-4', 'M12 8h.01'],
    'alert-triangle': ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
    'circle-check': ['c:12,12,10', 'm9 12 2 2 4-4'],
    'circle-x': ['c:12,12,10', 'm15 9-6 6', 'm9 9 6 6'],
    lightbulb: ['M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5', 'M9 18h6', 'M10 22h4'],
    sparkles: ['m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z'],
    check: ['M20 6 9 17l-5-5'],
    x: ['M18 6 6 18', 'm6 6 12 12'],
    plus: ['M5 12h14', 'M12 5v14'],
    'chevron-right': ['m9 18 6-6-6-6'],
    'chevron-down': ['m6 9 6 6 6-6'],
    'arrow-right': ['M5 12h14', 'm12 5 7 7-7 7'],
    'external-link': ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
    link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
    copy: ['r:8,8,14,14,2', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
    clock: ['c:12,12,10', 'M12 6v6l4 2'],
    calendar: ['r:3,4,18,18,2', 'M16 2v4', 'M8 2v4', 'M3 10h18'],
    'map-pin': ['M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z', 'c:12,10,3'],
    user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', 'c:12,7,4'],
    users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'c:9,7,4', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
    mail: ['r:2,4,20,16,2', 'm22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'],
    'file-text': ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
    book: ['M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2Z', 'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7Z'],
    'graduation-cap': ['M22 10 12 5 2 10l10 5 10-5Z', 'M6 12v5c3 3 9 3 12 0v-5', 'M22 10v6'],
    briefcase: ['r:2,7,20,14,2', 'M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16'],
    dollar: ['M12 2v20', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'],
    'trending-up': ['M22 7 13.5 15.5 8.5 10.5 2 17', 'M16 7h6v6'],
    'trending-down': ['M22 17 13.5 8.5 8.5 13.5 2 7', 'M16 17h6v-6'],
    target: ['c:12,12,10', 'c:12,12,6', 'c:12,12,2'],
    flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z', 'M4 22v-7'],
    star: ['M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z'],
    zap: ['M13 2 3 14h9l-1 8 10-12h-9l1-8Z'],
    search: ['c:11,11,8', 'm21 21-4.3-4.3'],
    refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
    list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
    'check-square': ['r:3,3,18,18,2', 'm9 12 2 2 4-4'],
    home: ['m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M9 22V12h6v10'],
    plane: ['M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2Z'],
    'shopping-cart': ['c:8,21,1', 'c:19,21,1', 'M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12'],
    code: ['m16 18 6-6-6-6', 'm8 6-6 6 6 6'],
    'message-square': ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z'],
    heart: ['M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z'],
    lock: ['r:3,11,18,11,2', 'M7 11V7a5 5 0 0 1 10 0v4'],
    bolt: ['M13 2 3 14h9l-1 8 10-12h-9l1-8Z'],
    circle: ['c:12,12,10'],
  }

  function iconSvg(name, cls) {
    var parts = ICONS[name] || ICONS.circle
    var inner = parts.map(function (p) {
      if (p.slice(0, 2) === 'c:') { var c = p.slice(2).split(','); return '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="' + c[2] + '"/>' }
      if (p.slice(0, 2) === 'r:') { var r = p.slice(2).split(','); return '<rect x="' + r[0] + '" y="' + r[1] + '" width="' + r[2] + '" height="' + r[3] + '" rx="' + (r[4] || 0) + '"/>' }
      return '<path d="' + p + '"/>'
    }).join('')
    return '<svg class="icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>'
  }

  function iconNode(name, cls) {
    var tpl = document.createElement('template')
    tpl.innerHTML = iconSvg(name, cls)
    return tpl.content.firstChild
  }

  var ACCENTS = /^(blue|violet|green|amber|rose|teal|orange|slate)$/
  function applyAccent(el) {
    var accent = el.getAttribute('accent')
    if (accent && ACCENTS.test(accent)) document.documentElement.setAttribute('data-accent', accent)
  }

  /** Shared page header for <ai-app> and <ai-doc>. */
  function appHeader(el, title, actions) {
    var subtitle = el.getAttribute('subtitle')
    var updated = el.getAttribute('updated')
    var meta = []
    if (subtitle) meta.push(h('span', { class: 'app-subtitle', html: inlineMd(subtitle) }))
    if (updated) meta.push(h('span', { class: 'app-updated', title: updated }, iconNode('clock'), 'Updated ' + (toDate(updated) ? fmtDateTime(updated) : updated)))
    return h('header', { class: 'app-header' },
      h('div', { class: 'grow' },
        h('h1', { class: 'app-title', html: inlineMd(title) }),
        meta.length ? h('div', { class: 'app-meta' }, meta) : null,
      ),
      actions.length ? h('div', { class: 'app-actions' }, actions) : null,
    )
  }

  /* ---------------- <ai-app> ---------------- */

  class AiApp extends KitElement {
    static get observedAttributes() {
      return ['title', 'subtitle', 'width', 'updated', 'accent']
    }
    render() {
      var width = this.getAttribute('width') || 'default'
      applyAccent(this)
      this._replace(h('div', { class: 'container' + (width !== 'default' ? ' container-' + width : '') },
        appHeader(this, this.getAttribute('title') || document.title || 'Untitled', this._slot('actions')),
        h('div', { class: 'stack stack-lg app-content' }, this._content()),
      ))
    }
  }

  /* ---------------- <ai-stat> ---------------- */

  class AiStat extends KitElement {
    static get observedAttributes() {
      return ['label', 'value', 'delta', 'hint', 'trend', 'icon']
    }
    render() {
      var delta = this.getAttribute('delta')
      var trend = this.getAttribute('trend') || (delta && delta.trim().startsWith('-') ? 'down' : delta && delta.trim().startsWith('+') ? 'up' : '')
      this._replace(
        h('div', { class: 'stat' },
          h('div', { class: 'stat-label' }, h('span', { text: this.getAttribute('label') || '' }), this.getAttribute('icon') ? iconNode(this.getAttribute('icon')) : null),
          h('div', { class: 'stat-value', text: this.getAttribute('value') || '—' }),
          delta || this.getAttribute('hint')
            ? h('div', { class: 'stat-delta' }, delta ? h('span', { class: 'stat-trend ' + trend, text: delta }) : null, delta && this.getAttribute('hint') ? ' · ' : null, this.getAttribute('hint') || null)
            : null,
        ),
      )
    }
  }

  /* ---------------- <ai-badge> ---------------- */

  class AiBadge extends KitElement {
    static get observedAttributes() {
      return ['variant']
    }
    render() {
      var variant = this.hasAttribute('variant') ? this.getAttribute('variant') : toneFor(this.textContent)
      this._replace(h('span', { class: 'badge' + (variant ? ' badge-' + variant : '') }, this._content()))
    }
  }

  /* ---------------- <ai-table> ---------------- */

  /**
   * Column spec: objects, or a compact string "key=Label:type(hrefKey), …"
   * (key defaults to the column index for array rows, else the snake_cased
   * label). Array rows without columns use their first row as the header.
   */
  function normalizeColumns(cols, rows) {
    if (typeof cols === 'string') cols = cols.split(',').map(function (c) { return c.trim() }).filter(Boolean)
    if (!Array.isArray(cols)) return null
    var arrays = Array.isArray(rows[0])
    return cols.map(function (col, index) {
      if (typeof col !== 'string') return col.key === undefined && arrays ? Object.assign({ key: index }, col) : col
      var m = /^(?:([\w$.-]+)=)?(.*?)(?::(\w+)(?:\(([\w$.-]+)\))?)?$/.exec(col)
      var label = m[2].trim()
      return {
        key: m[1] !== undefined ? m[1] : arrays ? index : label.toLowerCase().replace(/[^\w]+/g, '_').replace(/^_|_$/g, ''),
        label: label, type: m[3], hrefKey: m[4],
      }
    })
  }

  function sortValue(value) {
    if (typeof value === 'number') return value
    var text = plainMd(value == null ? '' : value)
    var num = NUMERIC.test(text) ? Number(text.replace(/[^\d.-]/g, '')) : NaN
    return isNaN(num) ? text : num
  }

  class AiTable extends KitElement {
    static get observedAttributes() {
      return ['columns', 'rows', 'empty', 'dense', 'sortable', 'caption', 'filter']
    }
    constructor() {
      super()
      this._sort = null
    }
    get columns() {
      var raw = this._columns || this.getAttribute('columns')
      if (typeof raw === 'string' && /^\s*\[/.test(raw)) raw = parseJsonAttr(this, 'columns', null)
      return normalizeColumns(raw, this._rows || parseJsonAttr(this, 'rows', [])) || this._inferColumns()
    }
    set columns(value) {
      this._columns = value
      if (this.isConnected) this._schedule()
    }
    get rows() {
      return this._rows || parseJsonAttr(this, 'rows', [])
    }
    set rows(value) {
      this._rows = Array.isArray(value) ? value : []
      if (this.isConnected) this._schedule()
    }
    _inferColumns() {
      var rows = this._rows || parseJsonAttr(this, 'rows', [])
      var first = rows[0]
      if (!first || typeof first !== 'object') return []
      if (Array.isArray(first)) return first.map(function (label, index) { return { key: index, label: String(label) } })
      return Object.keys(first).map(function (key) {
        return { key: key, label: key.replace(/[_-]+/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase() }) }
      })
    }
    /** Authored pipe-table children → { columns, rows }. */
    _markdownTable() {
      var text = dedentText((this._children || []).map(function (n) { return n.textContent }).join('')).trim()
      var lines = text.split('\n')
      var at = lines.findIndex(function (_l, i) { return isTableStart(lines, i) })
      if (at < 0) return null
      var t = parseTable(lines, at)
      return {
        columns: t.head.map(function (label, index) { return { key: index, label: plainMd(label), align: t.aligns[index] } }),
        rows: t.rows,
      }
    }
    _cell(col, row) {
      var value = typeof col.render === 'function' ? col.render(row) : row[col.key]
      var td = h('td', { class: [col.align === 'right' || col.type === 'number' ? 'num' : col.align === 'center' ? 'center' : '', col.className || ''].join(' ').trim() || null })
      if (value instanceof Node) td.appendChild(value)
      else if (typeof col.render === 'function' && typeof value === 'string' && col.html !== false) td.innerHTML = value
      else if (col.type === 'date') td.textContent = fmtDate(value)
      else if (col.type === 'datetime') td.textContent = fmtDateTime(value)
      else if (col.type === 'number') td.textContent = fmtNumber(value, col.format)
      else if (col.type === 'badge') {
        if (value != null && value !== '') {
          var variant = typeof col.variant === 'object' && col.variant ? col.variant[value] : col.variant
          td.innerHTML = badgeHtml(esc(value), variant === undefined ? toneFor(value) : variant)
        }
      } else if (col.type === 'link' && value) td.appendChild(h('a', { href: String(row[col.hrefKey || 'href'] || value), text: String(value), target: '_blank', rel: 'noreferrer' }))
      else if (typeof value === 'string') td.innerHTML = inlineMd(value)
      else td.textContent = value == null ? '' : String(value)
      return td
    }
    render() {
      var self = this
      var md = !this._rows && !this.getAttribute('rows') ? this._markdownTable() : null
      var columns = (md ? md.columns : this.columns) || []
      var rows = (md ? md.rows : this.rows).slice()
      if (!md && !this._columns && !this.getAttribute('columns') && Array.isArray(rows[0])) rows = rows.slice(1)
      var sortable = this.hasAttribute('sortable')
      if (this._sort) {
        var key = this._sort.key
        var dir = this._sort.dir
        rows.sort(function (a, b) {
          var x = sortValue(a[key]), y = sortValue(b[key])
          if (x === '' || x == null) return 1
          if (y === '' || y == null) return -1
          var r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
          return dir === 'desc' ? -r : r
        })
      }
      var thead = h('thead', null, h('tr', null, columns.map(function (col) {
        var th = h('th', {
          class: [col.align === 'right' || col.type === 'number' ? 'num' : col.align === 'center' ? 'center' : '', sortable ? 'sortable' : ''].join(' ').trim() || null,
          style: col.width ? 'width:' + col.width : null,
          text: col.label || String(col.key),
        })
        if (sortable) {
          if (self._sort && self._sort.key === col.key) th.setAttribute('aria-sort', self._sort.dir === 'asc' ? 'ascending' : 'descending')
          th.addEventListener('click', function () {
            self._sort = self._sort && self._sort.key === col.key && self._sort.dir === 'asc' ? { key: col.key, dir: 'desc' } : { key: col.key, dir: 'asc' }
            self._schedule()
          })
        }
        return th
      })))
      var clickable = typeof this.onRowClick === 'function' || this.hasAttribute('row-click')
      var trs = rows.map(function (row, index) {
        var tr = h('tr', { class: clickable ? 'clickable' : null }, columns.map(function (col) { return self._cell(col, row) }))
        if (clickable) {
          tr.addEventListener('click', function () {
            self.dispatchEvent(new CustomEvent('row-click', { detail: { row: row, index: index }, bubbles: true }))
            if (typeof self.onRowClick === 'function') self.onRowClick(row, index)
            else if (row.href) openHref(row.href)
          })
        }
        return tr
      })
      var emptyRow = h('tr', { class: 'empty-row', hidden: rows.length ? true : null }, h('td', { colspan: String(Math.max(1, columns.length)) }, h('div', { class: 'empty', text: this.getAttribute('empty') || 'Nothing here yet.' })))
      var tbody = h('tbody', null, trs, emptyRow)
      var table = h('table', { class: 'table' + (this.hasAttribute('dense') ? ' table-dense' : '') }, this.getAttribute('caption') ? h('caption', { class: 'sr-only', text: this.getAttribute('caption') }) : null, thead, tbody)
      var wrap = h('div', { class: 'table-wrap' }, table)
      if (!this.hasAttribute('filter')) return this._replace(wrap)
      var query = this._query || ''
      var input = h('input', { class: 'input input-sm', type: 'search', placeholder: this.getAttribute('filter') || 'Filter…', value: query })
      var count = h('span', { class: 'muted text-xs' })
      function apply() {
        var q = input.value.trim().toLowerCase()
        var shown = 0
        self._query = input.value
        trs.forEach(function (tr) {
          var hit = !q || tr.textContent.toLowerCase().indexOf(q) >= 0
          tr.hidden = !hit
          if (hit) shown++
        })
        emptyRow.hidden = shown > 0
        count.textContent = q ? shown + ' of ' + trs.length : trs.length + ' rows'
      }
      input.addEventListener('input', apply)
      apply()
      this._replace(h('div', { class: 'stack stack-sm' }, h('div', { class: 'table-toolbar' }, h('span', { class: 'input-icon' }, iconNode('search'), input), count), wrap))
    }
  }

  /* ---------------- <ai-list> ---------------- */

  class AiList extends KitElement {
    static get observedAttributes() {
      return ['items', 'empty']
    }
    get items() {
      return this._items || parseJsonAttr(this, 'items', [])
    }
    set items(value) {
      this._items = Array.isArray(value) ? value : []
      if (this.isConnected) this._schedule()
    }
    render() {
      var self = this
      var items = this.items
      if (!items.length) {
        this._replace(h('div', { class: 'list' }, h('div', { class: 'empty', text: this.getAttribute('empty') || 'Nothing here yet.' })))
        return
      }
      this._replace(h('div', { class: 'list' }, items.map(function (item, index) {
        var clickable = Boolean(item.href) || typeof self.onItemClick === 'function'
        var row = h(clickable && item.href && !self.onItemClick ? 'a' : 'div', {
          class: 'list-item' + (clickable ? ' clickable' : ''),
          href: item.href && !self.onItemClick ? item.href : null,
          target: item.href ? '_blank' : null,
          rel: item.href ? 'noreferrer' : null,
        },
          item.icon ? h('span', { class: 'avatar', html: item.icon }) : item.initials ? h('span', { class: 'avatar', text: item.initials }) : null,
          h('div', { class: 'list-item-body' },
            h('div', { class: 'list-item-title truncate', text: item.title || '' }),
            item.subtitle ? h('div', { class: 'list-item-subtitle', text: item.subtitle }) : null,
          ),
          item.badge ? h('span', { class: 'badge' + (item.badgeVariant ? ' badge-' + item.badgeVariant : ''), text: item.badge }) : null,
          item.meta ? h('span', { class: 'list-item-meta', text: item.meta }) : null,
        )
        if (typeof self.onItemClick === 'function') {
          row.addEventListener('click', function () { self.onItemClick(item, index) })
        }
        row.addEventListener('click', function () {
          self.dispatchEvent(new CustomEvent('item-click', { detail: { item: item, index: index }, bubbles: true }))
        })
        return row
      })))
    }
  }

  /* ---------------- <ai-kv> ---------------- */

  class AiKv extends KitElement {
    static get observedAttributes() {
      return ['items']
    }
    get items() {
      return this._items || parseJsonAttr(this, 'items', [])
    }
    set items(value) {
      this._items = value
      if (this.isConnected) this._schedule()
    }
    render() {
      var items = this.items
      var pairs = Array.isArray(items) ? items : Object.keys(items || {}).map(function (k) { return { label: k, value: items[k] } })
      this._replace(h('dl', { class: 'kv' }, pairs.map(function (pair) {
        return [h('dt', { text: pair.label }), h('dd', { text: pair.value == null ? '—' : String(pair.value) })]
      })))
    }
  }

  /* ---------------- <ai-tabs> / <ai-tab> ---------------- */

  class AiTabs extends KitElement {
    static get observedAttributes() {
      return ['active']
    }
    render() {
      var self = this
      var tabs = this._content().filter(function (n) { return n.nodeType === 1 && n.tagName === 'AI-TAB' })
      if (!tabs.length) return
      var active = this.getAttribute('active') || tabs[0].getAttribute('name') || '0'
      var list = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(function (tab, index) {
        var name = tab.getAttribute('name') || String(index)
        var selected = name === active
        return h('button', {
          class: 'tab', role: 'tab', type: 'button', 'aria-selected': selected ? 'true' : 'false', text: tab.getAttribute('label') || name,
          onclick: function () {
            self.setAttribute('active', name)
            self.dispatchEvent(new CustomEvent('tab-change', { detail: { name: name }, bubbles: true }))
          },
        })
      }))
      tabs.forEach(function (tab, index) {
        var name = tab.getAttribute('name') || String(index)
        if (name === active) tab.setAttribute('data-active', '')
        else tab.removeAttribute('data-active')
      })
      this._replace(h('div', { class: 'stack' }, list, h('div', { class: 'tab-panels' }, tabs)))
    }
  }

  /* ---------------- <ai-calendar> ---------------- */

  class AiCalendar extends KitElement {
    static get observedAttributes() {
      return ['view', 'date', 'events', 'week-start']
    }
    get events() {
      return this._events || parseJsonAttr(this, 'events', [])
    }
    set events(value) {
      this._events = Array.isArray(value) ? value : []
      if (this.isConnected) this._schedule()
    }
    _anchor() {
      return this._anchorDate || toDate(this.getAttribute('date')) || new Date()
    }
    _shift(delta) {
      var view = this.getAttribute('view') || 'week'
      var d = new Date(this._anchor())
      if (view === 'month') d.setMonth(d.getMonth() + delta)
      else d.setDate(d.getDate() + delta * 7)
      this._anchorDate = d
      this._schedule()
    }
    _eventNode(ev) {
      var self = this
      var start = toDate(ev.start || ev.date)
      var end = toDate(ev.end)
      var past = (end || start) && (end || start) < new Date()
      var clickable = Boolean(ev.href) || typeof this.onEventClick === 'function'
      var node = h(ev.href && !this.onEventClick ? 'a' : 'div', {
        class: 'cal-event' + (clickable ? ' clickable' : '') + (past && ev.done !== false ? ' past' : ''),
        style: ev.color ? 'border-left-color:' + ev.color : null,
        href: ev.href && !this.onEventClick ? ev.href : null,
        target: ev.href ? '_blank' : null,
        rel: ev.href ? 'noreferrer' : null,
        title: [ev.title, ev.subtitle].filter(Boolean).join(' — '),
      },
        h('div', { class: 'cal-event-title truncate', text: (start && !ev.allDay && ev.showTime !== false ? fmtTime(start) + ' · ' : '') + (ev.title || '') }),
        ev.subtitle ? h('div', { class: 'cal-event-sub truncate', text: ev.subtitle }) : null,
      )
      node.addEventListener('click', function () {
        self.dispatchEvent(new CustomEvent('event-click', { detail: { event: ev }, bubbles: true }))
        if (typeof self.onEventClick === 'function') self.onEventClick(ev)
      })
      return node
    }
    render() {
      var self = this
      var view = this.getAttribute('view') || 'week'
      var weekStart = this.getAttribute('week-start') === 'sun' ? 0 : 1
      var anchor = this._anchor()
      var today = dayKey(new Date())
      var byDay = {}
      this.events.forEach(function (ev) {
        var d = toDate(ev.start || ev.date)
        if (!d) return
        var key = dayKey(d)
        ;(byDay[key] = byDay[key] || []).push(ev)
      })
      Object.keys(byDay).forEach(function (key) {
        byDay[key].sort(function (a, b) { return (toDate(a.start || a.date) || 0) - (toDate(b.start || b.date) || 0) })
      })

      var days = []
      var title
      if (view === 'month') {
        var first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
        var offset = (first.getDay() - weekStart + 7) % 7
        var cursor = new Date(first)
        cursor.setDate(1 - offset)
        for (var i = 0; i < 42; i++) {
          days.push({ date: new Date(cursor), other: cursor.getMonth() !== anchor.getMonth() })
          cursor.setDate(cursor.getDate() + 1)
        }
        title = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      } else {
        var start = new Date(anchor)
        start.setDate(anchor.getDate() - ((anchor.getDay() - weekStart + 7) % 7))
        for (var j = 0; j < 7; j++) {
          var d = new Date(start)
          d.setDate(start.getDate() + j)
          days.push({ date: d, other: false })
        }
        var endDay = days[6].date
        title = fmtDate(start, { month: 'short', day: 'numeric' }) + ' – ' + fmtDate(endDay, { month: 'short', day: 'numeric', year: 'numeric' })
      }

      var maxPerDay = view === 'month' ? 3 : Infinity
      var grid = h('div', { class: 'cal-grid' }, days.map(function (day) {
        var key = dayKey(day.date)
        var list = byDay[key] || []
        var shown = list.slice(0, maxPerDay)
        return h('div', { class: 'cal-day' + (day.other ? ' other' : '') + (key === today ? ' today' : ''), 'data-date': key },
          h('div', { class: 'cal-dayhead' },
            h('span', { text: day.date.toLocaleDateString(undefined, { weekday: 'short' }) }),
            h('span', { class: 'cal-daynum', text: String(day.date.getDate()) }),
          ),
          shown.map(function (ev) { return self._eventNode(ev) }),
          list.length > shown.length ? h('div', { class: 'cal-more', text: '+' + (list.length - shown.length) + ' more' }) : null,
        )
      }))

      this._replace(h('div', { class: 'cal' + (view === 'month' ? ' cal-month' : ' cal-week') },
        h('div', { class: 'cal-toolbar' },
          h('div', { class: 'row' },
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', text: '‹', 'aria-label': 'Previous', onclick: function () { self._shift(-1) } }),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Today', onclick: function () { self._anchorDate = new Date(); self._schedule() } }),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', text: '›', 'aria-label': 'Next', onclick: function () { self._shift(1) } }),
          ),
          h('div', { class: 'cal-title', text: title }),
          h('div', { class: 'tabs' },
            h('button', { class: 'tab', type: 'button', 'aria-selected': view === 'week' ? 'true' : 'false', text: 'Week', onclick: function () { self.setAttribute('view', 'week') } }),
            h('button', { class: 'tab', type: 'button', 'aria-selected': view === 'month' ? 'true' : 'false', text: 'Month', onclick: function () { self.setAttribute('view', 'month') } }),
          ),
        ),
        grid,
      ))
    }
  }

  /* ---------------- <ai-live> ---------------- */

  class AiLive extends KitElement {
    static get observedAttributes() {
      return ['every', 'label', 'src']
    }
    constructor() {
      super()
      this._state = 'idle'
      this._updatedAt = 0
      this._error = ''
      this._timer = 0
      this._tick = 0
    }
    connectedCallback() {
      super.connectedCallback()
      var self = this
      var start = function () {
        self._tick = setInterval(function () { self._renderBar() }, 30000)
        if (typeof self.load === 'function' || self.getAttribute('src')) self.refresh()
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
      else start()
    }
    disconnectedCallback() {
      clearTimeout(this._timer)
      clearInterval(this._tick)
    }
    set load(fn) {
      this._load = fn
      if (this.isConnected) this.refresh()
    }
    get load() {
      return this._load
    }
    set render(fn) {
      this._renderFn = fn
    }
    get render() {
      return this._renderFn
    }
    _paint() {
      this._ensureShell()
      this._renderBar()
    }
    _ensureShell() {
      if (this._body) return
      if (!this._children) this._captureChildren()
      var content = this._content()
      this._bar = h('div', { class: 'live-bar' })
      this._body = h('div', { class: 'live-body' }, content)
      this._replace(this._bar, this._body)
    }
    _renderBar() {
      var self = this
      if (!this._bar) return
      var state = this._state
      var every = parseDuration(this.getAttribute('every'))
      var stale = every && this._updatedAt && Date.now() - this._updatedAt > every * 1.5
      var dotClass = state === 'loading' ? 'busy' : state === 'error' ? 'error' : stale ? 'stale' : ''
      var status = state === 'loading' ? 'Refreshing…' : state === 'error' ? 'Failed: ' + this._error : this._updatedAt ? 'Updated ' + timeAgo(this._updatedAt) : 'Not loaded yet'
      this._bar.textContent = ''
      append(this._bar, [
        h('span', null, h('span', { class: 'live-dot ' + dotClass }), (this.getAttribute('label') ? this.getAttribute('label') + ' · ' : '') + status),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Refresh', disabled: state === 'loading' ? true : null, onclick: function () { self.refresh() } }),
      ])
    }
    get body() {
      this._ensureShell()
      return this._body
    }
    refresh() {
      var self = this
      clearTimeout(this._timer)
      this._ensureShell()
      this._state = 'loading'
      this._renderBar()
      var run = Promise.resolve().then(function () {
        if (typeof self._load === 'function') return self._load(self._body, self)
        var src = self.getAttribute('src')
        if (!src) return undefined
        if (!window.ai) throw new Error('ai runtime unavailable')
        return window.ai.fetch(src).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          var data
          try { data = JSON.parse(res.text) } catch (e) { data = res.text }
          self.data = data
          self.dispatchEvent(new CustomEvent('data', { detail: data, bubbles: true }))
          if (typeof self._renderFn === 'function') {
            var out = self._renderFn(data, self._body, self)
            if (typeof out === 'string') self._body.innerHTML = out
            else if (out instanceof Node) { self._body.textContent = ''; self._body.appendChild(out) }
          }
        })
      })
      run.then(function (out) {
        if (typeof out === 'string') self._body.innerHTML = out
        else if (out instanceof Node) { self._body.textContent = ''; self._body.appendChild(out) }
        self._state = 'ok'
        self._updatedAt = Date.now()
        self._error = ''
        self.dispatchEvent(new CustomEvent('refreshed', { bubbles: true }))
      }, function (err) {
        self._state = 'error'
        self._error = err && err.message ? err.message : String(err)
        console.error('<ai-live> refresh failed:', self._error)
      }).then(function () {
        self._renderBar()
        var every = parseDuration(self.getAttribute('every'))
        if (every > 0) self._timer = setTimeout(function () { self.refresh() }, Math.max(every, 60000))
      })
      return run
    }
  }

  /* ---------------- markdown ---------------- */
  /*
   * Kit markdown: GFM-style blocks (headings, nested/task lists, tables with
   * alignment, fences, quotes, GitHub alerts) plus `::: name args {flags}`
   * directives that expand into kit components, and inline `:badge[…]`,
   * `:kbd[…]`, `:icon[…]`, `==mark==`. Lines that start with an HTML tag pass
   * through untouched, so <ai-*> elements can sit between markdown blocks.
   */

  var INLINE_TAG_RE = /<\/?(?:a|abbr|b|br|code|del|em|i|kbd|mark|s|small|span|strong|sub|sup|u|ai-badge|ai-icon|kit-slot)(?:\s[^<>]*)?\/?>/gi
  var FENCE_OPEN = /^\s*(```+|~~~+)\s*([\w+#.-]*)/
  var FENCE_CLOSE = /^\s*(```+|~~~+)\s*$/
  var DIRECTIVE_OPEN = /^\s*:::\s*([a-zA-Z][\w-]*)\s*(.*?)\s*$/
  var DIRECTIVE_CLOSE = /^\s*:::\s*$/
  var HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/
  var HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
  var LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
  var TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
  var HTML_BLOCK = /^\s*<\/?[a-zA-Z][\w-]*(\s|\/?>|$)/
  var QUOTE = /^\s{0,3}>/

  var TONES = [
    ['success', /^(done|complete|completed|submitted|paid|passed|approved|accepted|active|on track|ready|shipped|graded|confirmed|applied|offer|won|resolved|verified|✓)\b/i],
    ['destructive', /^(overdue|late|missing|failed|fail|blocked|rejected|declined|error|urgent|cancell?ed|expired|closed|lost|not submitted)\b/i],
    ['warning', /^(due soon|due today|due tomorrow|pending|in progress|waiting|in review|needs review|review|draft|at risk|todo|to do|partial|tentative|unverified|follow up|next up)\b/i],
    ['brand', /^(new|next|upcoming|scheduled|interview|planned|in queue|queued)\b/i],
  ]

  /** Badge variant inferred from status wording ("Overdue" → destructive). */
  function toneFor(text) {
    var value = String(text == null ? '' : text).trim()
    for (var i = 0; i < TONES.length; i++) if (TONES[i][1].test(value)) return TONES[i][0]
    return ''
  }

  function badgeHtml(text, variant) {
    var tone = variant === undefined ? toneFor(text) : variant
    return '<span class="badge' + (tone ? ' badge-' + tone : '') + '">' + text + '</span>'
  }

  function safeHref(href) {
    return /^(https?:|\/workspace\/|\/skills\/|#|mailto:|tel:)/i.test(href) ? href : '#'
  }

  function inlineMd(text) {
    var stash = []
    function keep(html) {
      stash.push(html)
      return '\u0000' + (stash.length - 1) + '\u0000'
    }
    var s = String(text == null ? '' : text)
    s = s.replace(/`([^`]+)`/g, function (_m, code) { return keep('<code>' + esc(code) + '</code>') })
    s = s.replace(INLINE_TAG_RE, function (tag) { return keep(tag) })
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|~=:<>])/g, function (_m, c) { return keep(esc(c)) })
    s = esc(s)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_m, alt, src) {
      return keep(/^\/(workspace|skills)\//.test(src) ? '<ai-image src="' + src + '" alt="' + alt + '"></ai-image>' : '<img src="' + safeHref(src) + '" alt="' + alt + '" loading="lazy">')
    })
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_m, label, href) {
      return keep('<a href="' + safeHref(href) + '" target="_blank" rel="noreferrer">') + label + keep('</a>')
    })
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])/g, function (_m, lead, url) {
      return lead + keep('<a href="' + url + '" target="_blank" rel="noreferrer">' + url.replace(/^https?:\/\/(www\.)?/, '') + '</a>')
    })
    s = s.replace(/:(badge(?:-(?:brand|success|warning|destructive|outline|muted))?|kbd|icon|mark)\[([^\]]+)\]/g, function (_m, kind, body) {
      if (kind === 'kbd') return keep('<kbd>' + body + '</kbd>')
      if (kind === 'icon') return keep(iconSvg(body.trim()))
      if (kind === 'mark') return '<mark>' + body + '</mark>'
      var variant = kind.indexOf('-') > 0 ? kind.slice(6) : undefined
      return badgeHtml(body, variant === 'muted' ? '' : variant)
    })
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
    s = s.replace(/(^|[^*\w])\*([^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
    s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    s = s.replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>')
    return s.replace(/\u0000(\d+)\u0000/g, function (_m, i) { return stash[Number(i)] })
  }

  /** Visible text of inline markdown (tab labels, sort keys, anchors). */
  function plainMd(text) {
    return String(text == null ? '' : text)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/:(?:badge(?:-\w+)?|kbd|mark)\[([^\]]*)\]/g, '$1')
      .replace(/:icon\[[^\]]*\]/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/[*_`~=]/g, '')
      .trim()
  }

  function isBlank(line) {
    return !line || /^\s*$/.test(line)
  }

  function indentOf(line) {
    return /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length
  }

  /** Remove `n` columns of leading whitespace (tabs count as four). */
  function dedentBy(line, n) {
    var lead = /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ')
    return lead.slice(Math.min(n, lead.length)) + line.replace(/^[ \t]*/, '')
  }

  function dedentText(text) {
    var indent = text.match(/^[ \t]*(?=\S)/gm)
    if (!indent || !indent.length) return text
    var min = Math.min.apply(null, indent.map(function (s) { return s.length }))
    return min > 0 ? text.replace(new RegExp('^[ \\t]{' + min + '}', 'gm'), '') : text
  }

  function isTableStart(lines, i) {
    return lines[i].indexOf('|') >= 0 && i + 1 < lines.length && lines[i + 1].indexOf('|') >= 0 && TABLE_SEP.test(lines[i + 1])
  }

  function startsBlock(lines, i) {
    var line = lines[i]
    return HEADING.test(line) || FENCE_OPEN.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || DIRECTIVE_OPEN.test(line) ||
      DIRECTIVE_CLOSE.test(line) || HTML_BLOCK.test(line) || HR.test(line) || isTableStart(lines, i)
  }

  function splitCells(row) {
    var cells = []
    var cur = ''
    var code = false
    var text = row.trim().replace(/^\|/, '').replace(/\|$/, '')
    for (var i = 0; i < text.length; i++) {
      var c = text[i]
      if (c === '\\' && text[i + 1] === '|') { cur += '|'; i++; continue }
      if (c === '`') code = !code
      if (c === '|' && !code) { cells.push(cur.trim()); cur = ''; continue }
      cur += c
    }
    cells.push(cur.trim())
    return cells
  }

  var NUMERIC = /^[-+−]?[$€£¥]?\s?\d[\d,]*(\.\d+)?\s?(%|[kKmMbB]|x)?$/

  /** Pipe table → { head, aligns, rows, end }. Numeric columns align right. */
  function parseTable(lines, i) {
    var head = splitCells(lines[i])
    var aligns = splitCells(lines[i + 1]).map(function (spec) {
      var left = /^:/.test(spec)
      var right = /:$/.test(spec)
      return right && left ? 'center' : right ? 'right' : left ? 'left' : ''
    })
    var rows = []
    var j = i + 2
    while (j < lines.length && !isBlank(lines[j]) && lines[j].indexOf('|') >= 0 && !DIRECTIVE_CLOSE.test(lines[j])) rows.push(splitCells(lines[j++]))
    head.forEach(function (_h, c) {
      if (aligns[c]) return
      var values = rows.map(function (r) { return plainMd(r[c] || '') }).filter(Boolean)
      if (values.length && values.every(function (v) { return NUMERIC.test(v) })) aligns[c] = 'right'
    })
    return { head: head, aligns: aligns, rows: rows, end: j }
  }

  function tableHtml(t) {
    function cell(tag, value, c) {
      var align = t.aligns[c]
      return '<' + tag + (align === 'right' ? ' class="num"' : align === 'center' ? ' class="center"' : '') + '>' + inlineMd(value || '') + '</' + tag + '>'
    }
    return '<div class="table-wrap"><table class="table"><thead><tr>' + t.head.map(function (v, c) { return cell('th', v, c) }).join('') +
      '</tr></thead><tbody>' + t.rows.map(function (r) { return '<tr>' + t.head.map(function (_v, c) { return cell('td', r[c], c) }).join('') + '</tr>' }).join('') +
      '</tbody></table></div>'
  }

  /** Body of a ::: directive up to its matching close (nesting and fences respected). */
  function takeDirective(lines, i) {
    var depth = 1
    var fence = null
    var j = i + 1
    for (; j < lines.length; j++) {
      var line = lines[j]
      if (fence) {
        if (FENCE_CLOSE.test(line) && line.trim()[0] === fence[0] && line.trim().length >= fence.length) fence = null
        continue
      }
      var f = FENCE_OPEN.exec(line)
      if (f) { fence = f[1]; continue }
      if (DIRECTIVE_CLOSE.test(line)) {
        if (--depth === 0) break
      } else if (DIRECTIVE_OPEN.test(line)) depth++
    }
    return { body: lines.slice(i + 1, j), end: j + 1 }
  }

  /** Calls fn(line, index, top) where top = outside fences and nested directives. */
  function scanTop(lines, fn) {
    var depth = 0
    var fence = null
    lines.forEach(function (line, index) {
      if (fence) {
        if (FENCE_CLOSE.test(line) && line.trim()[0] === fence[0]) fence = null
        return fn(line, index, false)
      }
      var f = FENCE_OPEN.exec(line)
      var top = depth === 0 && !f
      if (f) fence = f[1]
      else if (DIRECTIVE_CLOSE.test(line)) { depth = Math.max(0, depth - 1); top = false }
      else if (DIRECTIVE_OPEN.test(line)) { top = depth === 0 && top; depth++; return fn(line, index, false, depth === 1) }
      fn(line, index, top)
    })
  }

  /** Split on the shallowest top-level heading: { lead, items: [{ title, lines }] } or null. */
  function sectionsOf(lines) {
    var level = 7
    scanTop(lines, function (line, _i, top) {
      var m = top && HEADING.exec(line)
      if (m) level = Math.min(level, m[1].length)
    })
    if (level === 7) return null
    var lead = []
    var items = []
    var cur = null
    scanTop(lines, function (line, _i, top) {
      var m = top && HEADING.exec(line)
      if (m && m[1].length === level) {
        cur = { title: m[2], lines: [] }
        items.push(cur)
      } else (cur ? cur.lines : lead).push(line)
    })
    return { lead: lead, items: items }
  }

  /** List at lines[i] → { items: [{ lines, task, checked }], ordered, start, end }. */
  function takeList(lines, i) {
    var first = LIST_ITEM.exec(lines[i])
    var base = indentOf(lines[i])
    var ordered = /\d/.test(first[2])
    var items = []
    var cur = null
    var blank = false
    var j = i
    for (; j < lines.length; j++) {
      var line = lines[j]
      if (isBlank(line)) {
        if (cur) cur.lines.push('')
        blank = true
        continue
      }
      var m = LIST_ITEM.exec(line)
      var ind = indentOf(line)
      if (m && ind <= base + 1) {
        if (/\d/.test(m[2]) !== ordered) break
        cur = { lines: [m[3]], offset: line.length - m[3].length }
        items.push(cur)
        blank = false
        continue
      }
      if (DIRECTIVE_CLOSE.test(line) && ind <= base) break
      if (ind > base) {
        cur.lines.push(dedentBy(line, cur.offset))
        blank = false
        continue
      }
      if (!blank && !startsBlock(lines, j)) {
        cur.lines.push(line.trim())
        continue
      }
      break
    }
    items.forEach(function (item) {
      while (item.lines.length && isBlank(item.lines[item.lines.length - 1])) item.lines.pop()
      var task = /^\[( |x|X)\]\s+/.exec(item.lines[0])
      if (task) {
        item.task = true
        item.checked = task[1] !== ' '
        item.lines[0] = item.lines[0].slice(task[0].length)
      }
    })
    return { items: items, ordered: ordered, start: ordered ? parseInt(first[2], 10) : 1, end: j }
  }

  function hashText(text) {
    var h = 5381
    for (var i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
    return (h >>> 0).toString(36)
  }

  function slugify(text, ctx) {
    var base = plainMd(text).toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'section'
    var slug = base
    for (var n = 2; ctx.slugs[slug]; n++) slug = base + '-' + n
    ctx.slugs[slug] = true
    return slug
  }

  /** Item body: first paragraph unwrapped so tight lists stay tight. */
  function itemBody(lines, ctx) {
    return renderBlocks(lines, ctx).replace(/^<p>([\s\S]*?)<\/p>/, '$1')
  }

  function listHtml(list, ctx) {
    var tasks = list.items.some(function (item) { return item.task })
    var tag = list.ordered ? 'ol' : 'ul'
    return '<' + tag + (tasks ? ' class="task-list"' : '') + (list.ordered && list.start !== 1 ? ' start="' + list.start + '"' : '') + '>' +
      list.items.map(function (item) {
        var body = itemBody(item.lines, ctx)
        if (!item.task) return '<li>' + body + '</li>'
        var key = hashText(plainMd(item.lines[0]))
        ctx.tasks[key] = (ctx.tasks[key] || 0) + 1
        if (ctx.tasks[key] > 1) key += '-' + ctx.tasks[key]
        return '<li class="task' + (item.checked ? ' checked' : '') + '"><input type="checkbox" class="checkbox" data-task="' + key + '"' + (item.checked ? ' checked' : '') + '><div class="task-text">' + body + '</div></li>'
      }).join('') + '</' + tag + '>'
  }

  function parseFlags(raw) {
    var flags = {}
    var m = /\{([^{}]*)\}\s*$/.exec(raw)
    if (m) {
      raw = raw.slice(0, m.index).trim()
      m[1].trim().split(/\s+/).forEach(function (part) {
        if (!part) return
        var eq = part.indexOf('=')
        if (eq > 0) flags[part.slice(0, eq)] = part.slice(eq + 1).replace(/^["']|["']$/g, '')
        else flags[part.replace(/^\./, '')] = true
      })
    }
    return { text: raw, flags: flags }
  }

  var CALLOUTS = {
    note: ['info', 'info'], info: ['info', 'info'], tip: ['success', 'lightbulb'], success: ['success', 'circle-check'],
    important: ['brand', 'sparkles'], warning: ['warning', 'alert-triangle'], caution: ['warning', 'alert-triangle'],
    danger: ['destructive', 'circle-x'], error: ['destructive', 'circle-x'], callout: ['', ''],
  }

  function calloutHtml(tone, icon, title, body) {
    return '<div class="callout' + (tone ? ' tone-' + tone : '') + '" role="note">' + (icon ? iconSvg(icon) : '') +
      '<div class="callout-body">' + (title ? '<div class="callout-title">' + inlineMd(title) + '</div>' : '') + body + '</div></div>'
  }

  function cardHtml(title, body, flags, extraClass) {
    var parts = String(title || '').split(/\s+\|\s+/)
    var tone = flags.tone ? ' tone-' + esc(flags.tone) : ''
    var head = parts[0]
      ? '<div class="card-header"><div class="grow"><div class="card-title">' + (flags.icon ? iconSvg(flags.icon) : '') + inlineMd(parts[0]) + '</div>' +
        (parts[1] ? '<div class="card-description">' + inlineMd(parts.slice(1).join(' | ')) + '</div>' : '') + '</div></div>'
      : ''
    return '<section class="card' + (flags.flush ? ' card-flush' : '') + tone + (extraClass ? ' ' + extraClass : '') + '">' + head + '<div class="card-content">' + body + '</div></section>'
  }

  function gridClass(text, flags, count) {
    var cols = Number(flags.cols || text) || (count && count <= 4 ? count : 0)
    return 'grid' + (cols >= 2 && cols <= 4 ? ' cols-' + cols : '')
  }

  /** Lines "a | b | c" (optional leading "- ") → cell arrays; "a: b" when no pipes. */
  function rowsOf(lines) {
    return lines.filter(function (l) { return !isBlank(l) }).map(function (l) {
      var line = l.replace(/^\s*[-*+]\s+/, '').trim()
      if (line.indexOf('|') >= 0) return splitCells(line)
      var m = /^(\*\*)?([^:*]+?)(\*\*)?:\s*(?:\*\*)?\s*(.*)$/.exec(line)
      return m ? [m[2].trim(), m[4].trim()] : [line]
    })
  }

  var DIRECTIVES = {
    card: function (d, ctx) { return cardHtml(d.text, renderBlocks(d.body, ctx), d.flags) },
    details: function (d, ctx) {
      return '<details class="disclosure' + (d.flags.tone ? ' tone-' + esc(d.flags.tone) : '') + '"' + (d.flags.open ? ' open' : '') + '><summary>' + inlineMd(d.text || 'Details') +
        '</summary><div class="disclosure-body">' + renderBlocks(d.body, ctx) + '</div></details>'
    },
    accordion: function (d, ctx) {
      var s = sectionsOf(d.body)
      if (!s) return DIRECTIVES.details(d, ctx)
      return renderBlocks(s.lead, ctx) + '<div class="accordion">' + s.items.map(function (item, index) {
        return '<details class="disclosure"' + (d.flags.open === true || (d.flags.open === 'first' && index === 0) ? ' open' : '') + '><summary>' + inlineMd(item.title) +
          '</summary><div class="disclosure-body">' + renderBlocks(item.lines, ctx) + '</div></details>'
      }).join('') + '</div>'
    },
    grid: function (d, ctx) {
      var cells = []
      var loose = []
      var i = 0
      function flush() {
        if (loose.some(function (l) { return !isBlank(l) })) cells.push('<div class="grid-cell">' + renderBlocks(loose, ctx) + '</div>')
        loose = []
      }
      while (i < d.body.length) {
        if (DIRECTIVE_OPEN.test(d.body[i])) {
          flush()
          var inner = takeDirective(d.body, i)
          cells.push(renderBlocks(d.body.slice(i, inner.end), ctx))
          i = inner.end
        } else loose.push(d.body[i++])
      }
      flush()
      return '<div class="' + gridClass(d.text, d.flags, cells.length) + '">' + cells.join('') + '</div>'
    },
    cards: function (d, ctx) {
      var s = sectionsOf(d.body)
      if (!s) return DIRECTIVES.grid(d, ctx)
      return renderBlocks(s.lead, ctx) + '<div class="' + gridClass(d.text, d.flags) + ' card-grid">' + s.items.map(function (item) {
        return cardHtml(item.title, renderBlocks(item.lines, ctx), d.flags, 'card-item')
      }).join('') + '</div>'
    },
    tabs: function (d, ctx) {
      var s = sectionsOf(d.body)
      if (!s) return renderBlocks(d.body, ctx)
      return renderBlocks(s.lead, ctx) + '<ai-tabs>' + s.items.map(function (item, index) {
        return '<ai-tab name="t' + index + '" label="' + esc(plainMd(item.title)) + '"><div class="md">' + renderBlocks(item.lines, ctx) + '</div></ai-tab>'
      }).join('') + '</ai-tabs>'
    },
    steps: function (d, ctx) { return sequenceHtml(d, ctx, 'steps') },
    timeline: function (d, ctx) { return sequenceHtml(d, ctx, 'timeline') },
    stats: function (d, ctx) {
      var rows = rowsOf(d.body)
      return '<div class="' + gridClass(d.text, d.flags, rows.length) + ' stats">' + rows.map(function (r) {
        var delta = r[2] || ''
        var trend = /^\s*[-−↓]/.test(delta) ? ' down' : /^\s*[+↑]/.test(delta) ? ' up' : ''
        if (d.flags.invert && trend) trend = trend === ' up' ? ' down' : ' up'
        var foot = [delta ? '<span class="stat-trend' + trend + '">' + inlineMd(delta) + '</span>' : '', r[3] ? inlineMd(r[3]) : ''].filter(Boolean).join(' · ')
        return '<div class="stat"><div class="stat-label">' + inlineMd(r[0]) + '</div><div class="stat-value">' + inlineMd(r[1] == null ? '—' : r[1]) + '</div>' +
          (foot ? '<div class="stat-delta">' + foot + '</div>' : '') + '</div>'
      }).join('') + '</div>'
    },
    kv: function (d) {
      return '<dl class="kv">' + rowsOf(d.body).map(function (r) {
        return '<dt>' + inlineMd(r[0]) + '</dt><dd>' + inlineMd(r.slice(1).join(' · ') || '—') + '</dd>'
      }).join('') + '</dl>'
    },
    bars: function (d) {
      var rows = rowsOf(d.body).map(function (r) {
        var raw = plainMd(r[1] || '')
        var frac = /^([\d.,]+)\s*\/\s*([\d.,]+)/.exec(raw)
        var value = frac ? Number(frac[1].replace(/,/g, '')) / Number(frac[2].replace(/,/g, '')) : Number(raw.replace(/[^\d.-]/g, ''))
        return { label: r[0], shown: r[1] || '', note: r[2] || '', value: isFinite(value) ? value : 0, frac: Boolean(frac) }
      })
      var max = Number(d.flags.max) || Math.max.apply(null, rows.map(function (r) { return r.frac ? 1 : r.value }).concat([0])) || 1
      return '<div class="bars' + (d.flags.tone ? ' tone-' + esc(d.flags.tone) : '') + '">' + rows.map(function (r) {
        var pct = Math.max(0, Math.min(100, ((r.frac ? r.value * (d.flags.max ? max : 1) : r.value) / max) * 100))
        return '<div class="bar-row"><div class="bar-label">' + inlineMd(r.label) + (r.note ? '<span class="bar-note">' + inlineMd(r.note) + '</span>' : '') + '</div>' +
          '<div class="bar-track"><span class="bar-fill" style="width:' + pct.toFixed(1) + '%"></span></div><div class="bar-value">' + inlineMd(r.shown) + '</div></div>'
      }).join('') + '</div>'
    },
    sources: function (d, ctx) {
      return '<aside class="sources"><div class="sources-title">' + inlineMd(d.text || 'Sources') + '</div>' + renderBlocks(d.body, ctx) + '</aside>'
    },
    table: function (d) {
      var attrs = Object.keys(d.flags).map(function (k) { return ' ' + esc(k) + (d.flags[k] === true ? '' : '="' + esc(d.flags[k]) + '"') }).join('')
      return '<ai-table' + attrs + (d.text ? ' caption="' + esc(d.text) + '"' : '') + '>' + esc(d.body.join('\n')) + '</ai-table>'
    },
  }
  DIRECTIVES.columns = DIRECTIVES.grid
  DIRECTIVES.reveal = function (d, ctx) { return DIRECTIVES.details({ text: d.text || 'Reveal answer', body: d.body, flags: d.flags }, ctx) }
  Object.keys(CALLOUTS).forEach(function (name) {
    DIRECTIVES[name] = function (d, ctx) {
      var tone = d.flags.tone || CALLOUTS[name][0]
      return calloutHtml(tone, d.flags.icon || CALLOUTS[name][1], d.text, renderBlocks(d.body, ctx))
    }
  })

  function sequenceHtml(d, ctx, kind) {
    var entries = []
    var s = sectionsOf(d.body)
    if (s) {
      entries = s.items.map(function (item) { return { label: item.title, body: renderBlocks(item.lines, ctx) } })
    } else {
      var start = d.body.findIndex(function (l) { return LIST_ITEM.test(l) })
      if (start < 0) return renderBlocks(d.body, ctx)
      var list = takeList(d.body, start)
      entries = list.items.map(function (item) {
        var lines = item.lines.slice()
        var label = ''
        var m = /^\*\*(.+?)\*\*\s*(?:[—–:·|-]\s*)?(.*)$/.exec(lines[0])
        if (m) {
          label = m[1]
          lines[0] = m[2]
        }
        return { label: label, body: itemBody(lines, ctx), done: item.task && item.checked, pending: item.task && !item.checked }
      })
    }
    return '<ol class="' + kind + '">' + entries.map(function (e) {
      var label = e.label ? '<div class="' + (kind === 'steps' ? 'step-title' : 'tl-time') + '">' + inlineMd(e.label) + '</div>' : ''
      return '<li' + (e.done ? ' class="done"' : e.pending ? ' class="pending"' : '') + '><div class="seq-body">' + label + (e.body ? '<div class="seq-text">' + e.body + '</div>' : '') + '</div></li>'
    }).join('') + '</ol>'
  }

  function renderBlocks(lines, ctx) {
    var out = []
    var i = 0
    while (i < lines.length) {
      var line = lines[i]
      var m
      if (isBlank(line)) { i++; continue }
      if ((m = FENCE_OPEN.exec(line))) {
        var fence = m[1]
        var code = []
        i++
        while (i < lines.length && !(FENCE_CLOSE.test(lines[i]) && lines[i].trim()[0] === fence[0] && lines[i].trim().length >= fence.length)) code.push(lines[i++])
        i++
        out.push('<div class="code-block"><pre><code' + (m[2] ? ' class="language-' + esc(m[2]) + '"' : '') + '>' + esc(dedentText(code.join('\n'))) +
          '</code></pre><button type="button" class="code-copy" data-copy aria-label="Copy">' + iconSvg('copy') + '</button></div>')
        continue
      }
      if ((m = DIRECTIVE_OPEN.exec(line))) {
        var block = takeDirective(lines, i)
        var args = parseFlags(m[2])
        var name = m[1].toLowerCase()
        var fn = DIRECTIVES[name]
        if (!fn) console.warn('artifact kit: unknown ::: ' + name + ' (rendered as a card). Known: ' + Object.keys(DIRECTIVES).join(', '))
        out.push(fn ? fn({ text: args.text, flags: args.flags, body: block.body }, ctx) : cardHtml(args.text || name, renderBlocks(block.body, ctx), args.flags))
        i = block.end
        continue
      }
      if (DIRECTIVE_CLOSE.test(line)) { i++; continue }
      if ((m = HEADING.exec(line))) {
        var level = m[1].length
        out.push('<h' + level + ' id="' + slugify(m[2], ctx) + '">' + inlineMd(m[2]) + '</h' + level + '>')
        i++
        continue
      }
      if (HR.test(line)) { out.push('<hr>'); i++; continue }
      if (QUOTE.test(line)) {
        var quote = []
        while (i < lines.length && QUOTE.test(lines[i])) quote.push(lines[i++].replace(/^\s{0,3}>\s?/, ''))
        var alert = /^\s*\[!(\w+)\]\s*(.*)$/.exec(quote[0] || '')
        var kind = alert && CALLOUTS[alert[1].toLowerCase()]
        if (kind) out.push(calloutHtml(kind[0], kind[1], alert[2], renderBlocks(quote.slice(1), ctx)))
        else out.push('<blockquote>' + renderBlocks(quote, ctx) + '</blockquote>')
        continue
      }
      if (isTableStart(lines, i)) {
        var table = parseTable(lines, i)
        out.push(tableHtml(table))
        i = table.end
        continue
      }
      if (LIST_ITEM.test(line)) {
        var list = takeList(lines, i)
        out.push(listHtml(list, ctx))
        i = list.end
        continue
      }
      if (HTML_BLOCK.test(line)) {
        var html = []
        while (i < lines.length && !isBlank(lines[i])) html.push(lines[i++])
        out.push(html.join('\n'))
        continue
      }
      var para = []
      while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++])
      out.push('<p>' + para.map(function (l, n) {
        var hard = / {2,}$|\\$/.test(l) && n < para.length - 1
        return inlineMd(l.replace(/\\$/, '').trim()) + (hard ? '<br>' : '')
      }).join(' ').replace(/<br> /g, '<br>') + '</p>')
    }
    return out.join('\n')
  }

  function renderMarkdown(src) {
    var lines = String(src || '').replace(/\r\n?/g, '\n').split('\n')
    return renderBlocks(lines, { slugs: {}, tasks: {} })
  }

  /* Task checkboxes persist per artifact in ai.state under one key. */
  var taskStore = null
  function tasks() {
    if (!taskStore) {
      taskStore = window.ai && window.ai.state
        ? window.ai.state.get('kit:tasks').then(function (v) { return v && typeof v === 'object' ? v : {} }, function () { return {} })
        : Promise.resolve({})
    }
    return taskStore
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text) })
    }
    return Promise.resolve(legacyCopy(text))
  }
  function legacyCopy(text) {
    var area = h('textarea', { style: 'position:fixed;opacity:0' })
    area.value = text
    document.body.appendChild(area)
    area.select()
    try { document.execCommand('copy') } finally { area.remove() }
  }

  /** Wire behaviour into rendered markdown: tasks, copy buttons, source hosts. */
  function enhance(root) {
    var boxes = root.querySelectorAll('li.task > input[data-task]')
    if (boxes.length) {
      tasks().then(function (saved) {
        boxes.forEach(function (box) {
          var key = box.getAttribute('data-task')
          if (typeof saved[key] === 'boolean') box.checked = saved[key]
          box.parentNode.classList.toggle('checked', box.checked)
          box.addEventListener('change', function () {
            box.parentNode.classList.toggle('checked', box.checked)
            saved[key] = box.checked
            if (window.ai && window.ai.state) window.ai.state.set('kit:tasks', saved)
            root.dispatchEvent(new CustomEvent('task-change', { detail: { key: key, checked: box.checked, text: box.parentNode.textContent.trim() }, bubbles: true }))
          })
        })
      })
    }
    root.querySelectorAll('.code-copy[data-copy]').forEach(function (button) {
      button.addEventListener('click', function () {
        var code = button.parentNode.querySelector('code')
        copyText(code ? code.textContent : '').then(function () {
          button.classList.add('copied')
          button.innerHTML = iconSvg('check')
          setTimeout(function () { button.classList.remove('copied'); button.innerHTML = iconSvg('copy') }, 1400)
        })
      })
    })
    root.querySelectorAll('.sources a[href^="http"]').forEach(function (a) {
      if (a.querySelector('.source-host') || (a.nextSibling && a.nextSibling.className === 'source-host')) return
      var host = ''
      try { host = new URL(a.href).hostname.replace(/^www\./, '') } catch (e) { return }
      if (a.textContent.trim().toLowerCase().indexOf(host) >= 0) return
      a.insertAdjacentElement('afterend', h('span', { class: 'source-host', text: host }))
    })
  }

  var BLOCK_TAGS = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BUTTON|CANVAS|DETAILS|DIV|DL|FIELDSET|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|IMG|INPUT|LABEL|MAIN|NAV|OL|P|PRE|SECTION|SELECT|SVG|TABLE|TEXTAREA|UL|VIDEO)$|^AI-(?!BADGE$|ICON$)/

  /**
   * Author children as markdown source ({ text, nodes }), or null when they
   * are real HTML layout (block elements) that should be kept as-is. Element
   * children become <kit-slot> placeholders and the original nodes are moved
   * back in after rendering, so properties set by scripts (el.rows = …) survive.
   */
  function markdownSource(nodes, force) {
    if (!force && nodes.some(function (n) { return n.nodeType === 1 && BLOCK_TAGS.test(n.tagName) })) return null
    var kept = []
    var text = nodes.map(function (n) {
      if (n.nodeType === 3) return n.textContent
      if (n.nodeType !== 1) return ''
      kept.push(n)
      return '<kit-slot data-i="' + (kept.length - 1) + '"></kit-slot>'
    }).join('')
    return { text: dedentText(text).trim(), nodes: kept }
  }

  function markdownNode(src, extraClass) {
    var text = typeof src === 'string' ? src : src.text
    var node = h('div', { class: 'md' + (extraClass ? ' ' + extraClass : ''), html: renderMarkdown(text) })
    if (typeof src !== 'string') {
      node.querySelectorAll('kit-slot[data-i]').forEach(function (slot) {
        var original = src.nodes[Number(slot.getAttribute('data-i'))]
        if (original) slot.replaceWith(original)
        else slot.remove()
      })
    }
    enhance(node)
    return node
  }

  class AiMarkdown extends KitElement {
    static get observedAttributes() {
      return ['src']
    }
    set text(value) {
      this._text = value
      if (this.isConnected) this._schedule()
    }
    get text() {
      return this._text
    }
    /** Markdown to render: the text property, the src file, or authored children. */
    _source() {
      var self = this
      var src = this.getAttribute('src')
      if (src && this._text === undefined && !this._loading && window.ai) {
        this._loading = true
        window.ai.fs.readText(src).then(function (text) { self._text = text; self._loading = false; self._schedule() }, function (e) { self._text = '_Could not load ' + src + ': ' + e.message + '_'; self._loading = false; self._schedule() })
      }
      if (this._text !== undefined) return dedentText(String(this._text)).trim()
      return markdownSource(this._content(), true)
    }
    render() {
      this._replace(markdownNode(this._source()))
    }
  }

  /* ---------------- <ai-doc> ---------------- */

  /** Reading-first page: <ai-app> header + markdown body + auto table of contents. */
  class AiDoc extends AiMarkdown {
    static get observedAttributes() {
      return ['src', 'title', 'subtitle', 'updated', 'width', 'accent', 'toc']
    }
    render() {
      var src = this._source()
      var text = typeof src === 'string' ? src : src.text
      var title = this.getAttribute('title')
      if (!title) {
        var lead = /^#\s+(.+)\n?/.exec(text)
        if (lead) {
          title = lead[1]
          text = text.slice(lead[0].length).trim()
        }
      }
      var body = markdownNode(typeof src === 'string' ? text : { text: text, nodes: src.nodes }, 'md-doc')
      var heads = Array.from(body.children).filter(function (n) { return n.tagName === 'H2' })
      var toc = this.getAttribute('toc') !== 'off' && heads.length >= 3 ? tocNode(heads) : null
      var width = this.getAttribute('width') || (toc ? 'default' : 'narrow')
      applyAccent(this)
      if (!document.title && title) document.title = plainMd(title)
      this._replace(h('div', { class: 'container container-' + width },
        appHeader(this, title || document.title || 'Untitled', this._slot('actions')),
        toc ? h('div', { class: 'doc-layout' }, body, toc) : body,
      ))
      if (toc) watchToc(body, toc, heads)
    }
  }

  function tocNode(heads) {
    return h('nav', { class: 'doc-toc', 'aria-label': 'On this page' },
      h('div', { class: 'doc-toc-title', text: 'On this page' }),
      heads.map(function (head) {
        return h('a', {
          href: '#' + head.id, text: head.textContent, 'data-target': head.id,
          onclick: function (event) { event.preventDefault(); head.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
        })
      }),
    )
  }

  function watchToc(body, toc, heads) {
    if (typeof IntersectionObserver !== 'function') return
    var links = toc.querySelectorAll('a')
    if (links[0]) links[0].classList.add('active')
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return
        links.forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-target') === entry.target.id) })
      })
    }, { rootMargin: '0px 0px -70% 0px' })
    heads.forEach(function (head) { observer.observe(head) })
  }

  /* ---------------- <ai-card> ---------------- */

  class AiCard extends KitElement {
    static get observedAttributes() {
      return ['title', 'description', 'icon', 'collapsible', 'open', 'flush', 'tone', 'href']
    }
    render() {
      var content = this._content()
      var source = markdownSource(content)
      var body = source === null ? content : source.text ? markdownNode(source) : null
      var title = this.getAttribute('title')
      var href = this.getAttribute('href')
      var tone = this.getAttribute('tone')
      var actions = this._slot('actions')
      var footer = this._slot('footer')
      var heading = title || this.getAttribute('description')
        ? h('div', { class: 'grow' },
            title ? h('div', { class: 'card-title' }, this.getAttribute('icon') ? iconNode(this.getAttribute('icon')) : null, href ? h('a', { href: href, text: title, target: '_blank', rel: 'noreferrer' }) : title) : null,
            this.getAttribute('description') ? h('div', { class: 'card-description', text: this.getAttribute('description') }) : null,
          )
        : null
      var cls = 'card' + (this.hasAttribute('flush') ? ' card-flush' : '') + (tone ? ' tone-' + tone : '')
      var main = body ? h('div', { class: 'card-content' }, body) : null
      var foot = footer.length ? h('div', { class: 'card-footer' }, footer) : null
      var actionRow = actions.length ? h('div', { class: 'row' }, actions) : null
      if (this.hasAttribute('collapsible')) {
        this._replace(h('details', { class: cls + ' disclosure', open: this.hasAttribute('open') }, h('summary', null, heading, actionRow), main, foot))
      } else {
        this._replace(h('section', { class: cls }, heading || actionRow ? h('div', { class: 'card-header' }, heading, actionRow) : null, main, foot))
      }
    }
  }

  /* ---------------- <ai-image> ---------------- */

  class AiImage extends KitElement {
    static get observedAttributes() {
      return ['src', 'alt', 'fit', 'height']
    }
    render() {
      var self = this
      var src = this.getAttribute('src') || ''
      var img = h('img', { alt: this.getAttribute('alt') || '', style: [this.getAttribute('height') ? 'height:' + this.getAttribute('height') : '', this.getAttribute('fit') ? 'object-fit:' + this.getAttribute('fit') + ';width:100%' : '', 'border-radius:var(--radius)'].filter(Boolean).join(';') })
      if (/^\/(workspace|skills)\//.test(src) && window.ai) {
        if (this._resolvedFor === src && this._dataUrl) img.src = this._dataUrl
        else {
          window.ai.fs.dataUrl(src).then(function (url) { self._resolvedFor = src; self._dataUrl = url; img.src = url }, function (e) { console.error('<ai-image> could not load ' + src + ':', e.message) })
        }
      } else if (src) img.src = src
      this._replace(img)
    }
  }

  /* ---------------- <ai-empty> / <ai-alert> / <ai-skeleton> / <ai-progress> ---------------- */

  class AiEmpty extends KitElement {
    static get observedAttributes() {
      return ['title', 'description']
    }
    render() {
      this._replace(h('div', { class: 'empty' },
        this.getAttribute('title') ? h('div', { class: 'empty-title', text: this.getAttribute('title') }) : null,
        this.getAttribute('description') ? h('div', { text: this.getAttribute('description') }) : null,
        this._content().length ? h('div', { class: 'row', style: 'margin-top:8px;justify-content:center' }, this._content()) : null,
      ))
    }
  }

  class AiAlert extends KitElement {
    static get observedAttributes() {
      return ['variant', 'title', 'icon']
    }
    render() {
      var variant = this.getAttribute('variant') || 'info'
      var tone = variant === 'default' ? '' : variant
      var icon = this.getAttribute('icon') || { info: 'info', success: 'circle-check', warning: 'alert-triangle', destructive: 'circle-x', brand: 'sparkles' }[tone]
      var content = this._content()
      var source = markdownSource(content)
      this._replace(h('div', { class: 'callout' + (tone ? ' tone-' + tone : ''), role: variant === 'destructive' ? 'alert' : 'status' },
        icon ? iconNode(icon) : null,
        h('div', { class: 'callout-body' }, this.getAttribute('title') ? h('div', { class: 'callout-title', text: this.getAttribute('title') }) : null, source === null ? content : source.text ? markdownNode(source) : null),
      ))
    }
  }

  class AiSkeleton extends KitElement {
    static get observedAttributes() {
      return ['lines', 'height']
    }
    render() {
      var lines = Math.max(1, Number(this.getAttribute('lines') || 3))
      var height = this.getAttribute('height')
      var nodes = []
      for (var i = 0; i < lines; i++) nodes.push(h('span', { class: 'skeleton', style: (height ? 'height:' + height + ';' : '') + 'width:' + (i === lines - 1 && lines > 1 ? '60%' : '100%') }))
      this._replace(h('div', { class: 'stack stack-sm' }, nodes))
    }
  }

  class AiProgress extends KitElement {
    static get observedAttributes() {
      return ['value', 'max']
    }
    render() {
      var max = Number(this.getAttribute('max') || 100) || 100
      var value = Math.min(max, Math.max(0, Number(this.getAttribute('value') || 0)))
      this._replace(h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(value), 'aria-valuemax': String(max) }, h('span', { style: 'width:' + (value / max) * 100 + '%' })))
    }
  }

  class AiIcon extends KitElement {
    static get observedAttributes() {
      return ['name']
    }
    render() {
      this._replace(iconNode(this.getAttribute('name') || (this._children || []).map(function (n) { return n.textContent }).join('').trim()))
    }
  }

  /* ---------------- register ---------------- */

  var registry = {
    'ai-app': AiApp,
    'ai-doc': AiDoc,
    'ai-card': AiCard,
    'ai-icon': AiIcon,
    'ai-stat': AiStat,
    'ai-badge': AiBadge,
    'ai-table': AiTable,
    'ai-list': AiList,
    'ai-kv': AiKv,
    'ai-tabs': AiTabs,
    'ai-calendar': AiCalendar,
    'ai-live': AiLive,
    'ai-markdown': AiMarkdown,
    'ai-image': AiImage,
    'ai-empty': AiEmpty,
    'ai-alert': AiAlert,
    'ai-skeleton': AiSkeleton,
    'ai-progress': AiProgress,
  }
  Object.keys(registry).forEach(function (name) {
    if (!customElements.get(name)) customElements.define(name, registry[name])
  })
  if (!customElements.get('ai-tab')) customElements.define('ai-tab', class extends HTMLElement {})

  var kit = { h: h, esc: esc, icon: iconNode, tone: toneFor, inline: inlineMd, timeAgo: timeAgo, fmtDate: fmtDate, fmtTime: fmtTime, fmtDateTime: fmtDateTime, fmtNumber: fmtNumber, markdown: renderMarkdown, open: openHref }
  // Saving a component preserves its authored children, not generated wrappers.
  kit.sourceChildren = function (node) { return node instanceof KitElement && node._rendered ? node._children : undefined }
  // Also reachable as ai.ui (the runtime resolves that name to window.AiKit).
  window.AiKit = kit
})()
