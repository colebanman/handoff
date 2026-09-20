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

  /* ---------------- <ai-app> ---------------- */

  class AiApp extends KitElement {
    static get observedAttributes() {
      return ['title', 'subtitle', 'width', 'updated']
    }
    render() {
      var width = this.getAttribute('width') || 'default'
      var content = this._content()
      var actions = this._slot('actions')
      var updated = this.getAttribute('updated')
      var header = h(
        'header',
        { class: 'app-header' },
        h(
          'div',
          null,
          h('h1', { class: 'app-title', text: this.getAttribute('title') || document.title || 'Untitled' }),
          this.getAttribute('subtitle') ? h('div', { class: 'app-subtitle', text: this.getAttribute('subtitle') }) : null,
          updated ? h('div', { class: 'app-subtitle text-xs', text: 'Updated ' + (toDate(updated) ? fmtDateTime(updated) : updated) }) : null,
        ),
        actions.length ? h('div', { class: 'app-actions' }, actions) : null,
      )
      this._replace(h('div', { class: 'container' + (width !== 'default' ? ' container-' + width : '') }, header, h('div', { class: 'stack stack-lg app-content' }, content)))
    }
  }

  /* ---------------- <ai-stat> ---------------- */

  class AiStat extends KitElement {
    static get observedAttributes() {
      return ['label', 'value', 'delta', 'hint', 'trend']
    }
    render() {
      var delta = this.getAttribute('delta')
      var trend = this.getAttribute('trend') || (delta && delta.trim().startsWith('-') ? 'down' : delta && delta.trim().startsWith('+') ? 'up' : '')
      this._replace(
        h('div', { class: 'stat' },
          h('div', { class: 'stat-label', text: this.getAttribute('label') || '' }),
          h('div', { class: 'stat-value', text: this.getAttribute('value') || '—' }),
          delta || this.getAttribute('hint')
            ? h('div', { class: 'stat-delta ' + trend, text: [delta, this.getAttribute('hint')].filter(Boolean).join(' · ') })
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
      var variant = this.getAttribute('variant')
      this._replace(h('span', { class: 'badge' + (variant ? ' badge-' + variant : '') }, this._content()))
    }
  }

  /* ---------------- <ai-table> ---------------- */

  class AiTable extends KitElement {
    static get observedAttributes() {
      return ['columns', 'rows', 'empty', 'dense', 'sortable', 'caption']
    }
    constructor() {
      super()
      this._sort = null
    }
    get columns() {
      return this._columns || parseJsonAttr(this, 'columns', null) || this._inferColumns()
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
      return Object.keys(first).map(function (key) {
        return { key: key, label: key.replace(/[_-]+/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase() }) }
      })
    }
    _cell(col, row) {
      var value = typeof col.render === 'function' ? col.render(row) : row[col.key]
      var td = h('td', { class: [col.align === 'right' || col.type === 'number' ? 'num' : '', col.className || ''].join(' ').trim() || null })
      if (value instanceof Node) td.appendChild(value)
      else if (typeof col.render === 'function' && typeof value === 'string' && col.html !== false) td.innerHTML = value
      else if (col.type === 'date') td.textContent = fmtDate(value)
      else if (col.type === 'datetime') td.textContent = fmtDateTime(value)
      else if (col.type === 'number') td.textContent = fmtNumber(value, col.format)
      else if (col.type === 'badge') td.appendChild(h('span', { class: 'badge' + (col.variant ? ' badge-' + col.variant : ''), text: value }))
      else if (col.type === 'link' && value) td.appendChild(h('a', { href: String(row[col.hrefKey || 'href'] || value), text: String(value), target: '_blank', rel: 'noreferrer' }))
      else td.textContent = value == null ? '' : String(value)
      return td
    }
    render() {
      var self = this
      var columns = this.columns || []
      var rows = this.rows.slice()
      var sortable = this.hasAttribute('sortable')
      if (this._sort) {
        var key = this._sort.key
        var dir = this._sort.dir
        rows.sort(function (a, b) {
          var x = a[key], y = b[key]
          if (x == null) return 1
          if (y == null) return -1
          var r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
          return dir === 'desc' ? -r : r
        })
      }
      var thead = h('thead', null, h('tr', null, columns.map(function (col) {
        var th = h('th', {
          class: [col.align === 'right' || col.type === 'number' ? 'num' : '', sortable ? 'sortable' : ''].join(' ').trim() || null,
          style: col.width ? 'width:' + col.width : null,
          text: col.label || col.key,
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
      var tbody = h('tbody', null, rows.length
        ? rows.map(function (row, index) {
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
        : [h('tr', null, h('td', { colspan: String(Math.max(1, columns.length)) }, h('div', { class: 'empty', text: this.getAttribute('empty') || 'Nothing here yet.' })))])
      var table = h('table', { class: 'table' + (this.hasAttribute('dense') ? ' table-dense' : '') }, this.getAttribute('caption') ? h('caption', { class: 'sr-only', text: this.getAttribute('caption') }) : null, thead, tbody)
      this._replace(h('div', { class: 'table-wrap' }, table))
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

  /* ---------------- <ai-markdown> ---------------- */

  function renderMarkdown(src) {
    var lines = String(src || '').replace(/\r\n?/g, '\n').split('\n')
    var out = []
    var i = 0
    function inline(text) {
      var s = esc(text)
      s = s.replace(/`([^`]+)`/g, function (_m, code) { return '<code>' + code + '</code>' })
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_m, label, href) {
        var safe = /^(https?:|\/workspace\/|\/skills\/|#|mailto:)/i.test(href) ? href : '#'
        return '<a href="' + safe + '" target="_blank" rel="noreferrer">' + label + '</a>'
      })
      return s
    }
    while (i < lines.length) {
      var line = lines[i]
      if (/^\s*$/.test(line)) { i++; continue }
      var m
      if ((m = /^```(\w*)\s*$/.exec(line))) {
        var code = []
        i++
        while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++])
        i++
        out.push('<pre><code' + (m[1] ? ' class="language-' + esc(m[1]) + '"' : '') + '>' + esc(code.join('\n')) + '</code></pre>')
        continue
      }
      if ((m = /^(#{1,4})\s+(.+)$/.exec(line))) {
        out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>')
        i++
        continue
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue }
      if (/^\s*>/.test(line)) {
        var quote = []
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
        out.push('<blockquote>' + renderMarkdown(quote.join('\n')) + '</blockquote>')
        continue
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        var ordered = /^\s*\d+[.)]\s+/.test(line)
        var items = []
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          var text = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')
          var task = /^\[( |x|X)\]\s+/.exec(text)
          if (task) text = '<input type="checkbox" class="checkbox" disabled' + (task[1] !== ' ' ? ' checked' : '') + '> ' + inline(text.slice(task[0].length))
          else text = inline(text)
          items.push('<li>' + text + '</li>')
          i++
        }
        out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'))
        continue
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        var cells = function (row) { return row.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim() }) }
        var head = cells(line)
        i += 2
        var body = []
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(cells(lines[i++]))
        out.push('<table><thead><tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>' }).join('') + '</tr></thead><tbody>' +
          body.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>' }).join('') + '</tr>' }).join('') + '</tbody></table>')
        continue
      }
      var para = []
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s|```|\s*>|\s*([-*+]|\d+[.)])\s+|\s*\|)/.test(lines[i])) para.push(lines[i++])
      if (para.length) out.push('<p>' + inline(para.join(' ')) + '</p>')
      else i++
    }
    return out.join('\n')
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
    render() {
      var self = this
      var src = this.getAttribute('src')
      if (src && this._text === undefined && !this._loading && window.ai) {
        this._loading = true
        window.ai.fs.readText(src).then(function (text) { self._text = text; self._loading = false; self._schedule() }, function (e) { self._text = '_Could not load ' + src + ': ' + e.message + '_'; self._loading = false; self._schedule() })
      }
      var text = this._text !== undefined ? this._text : this._children ? this._children.map(function (n) { return n.textContent }).join('') : ''
      // Strip common indentation from inline authored markdown.
      var indent = text.match(/^[ \t]*(?=\S)/gm)
      if (indent && indent.length) {
        var min = Math.min.apply(null, indent.map(function (s) { return s.length }))
        if (min > 0) text = text.replace(new RegExp('^[ \\t]{' + min + '}', 'gm'), '')
      }
      this._replace(h('div', { class: 'md', html: renderMarkdown(text.trim()) }))
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
      return ['variant', 'title']
    }
    render() {
      var variant = this.getAttribute('variant')
      this._replace(h('div', { class: 'alert' + (variant ? ' alert-' + variant : ''), role: variant === 'destructive' ? 'alert' : 'status' },
        h('div', { class: 'grow' }, this.getAttribute('title') ? h('div', { class: 'alert-title', text: this.getAttribute('title') }) : null, this._content()),
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

  /* ---------------- register ---------------- */

  var registry = {
    'ai-app': AiApp,
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

  var kit = { h: h, esc: esc, timeAgo: timeAgo, fmtDate: fmtDate, fmtTime: fmtTime, fmtDateTime: fmtDateTime, fmtNumber: fmtNumber, markdown: renderMarkdown, open: openHref }
  // Saving a component preserves its authored children, not generated wrappers.
  kit.sourceChildren = function (node) { return node instanceof KitElement && node._rendered ? node._children : undefined }
  // Also reachable as ai.ui (the runtime resolves that name to window.AiKit).
  window.AiKit = kit
})()
