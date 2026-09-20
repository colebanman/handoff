---
name: artifacts
version: 1
description: How to build HTML artifacts with the bundled artifact kit (design system + <ai-*> components), load live data, and verify them before presenting.
---

# Artifacts — the kit

Every `.html` artifact you write is rendered with the **artifact kit** injected: a stylesheet (shadcn-style tokens and classes) and a set of `<ai-*>` web components. You never include the kit yourself. Compose it; do not restyle it. Your job is data and structure, not CSS.

Theme follows the side panel (dark by default). Never hard-code colors; use tokens (`var(--brand)`, `var(--muted-foreground)`, `var(--border)`) if you must style something custom.

## Starter template

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Week of Sep 14</title></head>
<body>
<ai-app title="Week of Sep 14" subtitle="Canvas · 4 courses" updated="2026-09-11T15:00:00Z">
  <div slot="actions">
    <button class="btn btn-outline btn-sm" id="refresh">Refresh</button>
  </div>

  <div class="grid cols-3">
    <ai-stat label="Due this week" value="7"></ai-stat>
    <ai-stat label="Overdue" value="1" trend="down"></ai-stat>
    <ai-stat label="Submitted" value="12" delta="+3"></ai-stat>
  </div>

  <ai-calendar id="cal" view="week"></ai-calendar>

  <div class="card">
    <div class="card-header"><div><div class="card-title">Assignments</div><div class="card-description">Sorted by due date</div></div></div>
    <div class="card-content card-flush"><ai-table id="table" sortable empty="No assignments found."></ai-table></div>
  </div>
</ai-app>

<script>
  const assignments = [/* data you fetched in your turn, or fetch here with ai.fetch */]
  const table = document.getElementById('table')
  table.columns = [
    { key: 'course', label: 'Course' },
    { key: 'name', label: 'Assignment', type: 'link', hrefKey: 'url' },
    { key: 'due', label: 'Due', type: 'datetime' },
    { key: 'status', label: 'Status', type: 'badge' },
  ]
  table.rows = assignments
  document.getElementById('cal').events = assignments.map(a => ({ start: a.due, title: a.name, subtitle: a.course, href: a.url }))
  document.getElementById('refresh').onclick = () => ai.invoke('Refresh this week view from Canvas and update the artifact in place.')
</script>
</body>
</html>
```

Rules of thumb: one `<ai-app>` per page; stats in a `.grid`; tables inside a `.card` with `card-flush`; keep source URLs and a retrieval time (`updated=`) visible.

## Layout & primitives (classes)

- Layout: `.container` (inside `<ai-app>` already), `.stack` / `.stack-sm` / `.stack-lg`, `.row` / `.row-between` / `.row-end`, `.grow`, `.grid` (+ `.cols-2/3/4`, collapses on narrow screens).
- Surfaces: `.card` > `.card-header` (`.card-title`, `.card-description`) + `.card-content` + `.card-footer`; `.card-flush` removes content padding (for tables/lists).
- Controls: `.btn` (+ `.btn-secondary`, `.btn-outline`, `.btn-ghost`, `.btn-brand`, `.btn-destructive`, `.btn-sm`, `.btn-lg`, `.btn-icon`), `.input`, `.select`, `.textarea`, `.label`, `.checkbox`.
- Signals: `.badge` (+ `-outline`, `-brand`, `-success`, `-warning`, `-destructive`), `.alert` (+ `-info`, `-success`, `-warning`, `-destructive`, with `.alert-title`), `.progress > span`, `.skeleton`, `.kbd`.
- Data: `.table-wrap > table.table` (`.num` for numeric cells, `.table-dense`), `.list > .list-item` (`.list-item-body`, `-title`, `-subtitle`, `-meta`), `dl.kv`, `.stat`.
- Text: `.h1`–`.h4`, `.muted`, `.text-xs/.text-sm/.text-lg`, `.mono`, `.truncate`, `.separator`.

## Components (`<ai-*>`)

All render into light DOM (inspectable with `document.querySelector(...)` from `api.artifacts.eval`). Data goes in via **properties** (`el.rows = [...]`) or **JSON attributes** (`rows='[...]'`). Setting a property re-renders.

| Element | Attributes | Properties / events |
|-|-|-|
| `<ai-app>` | `title`, `subtitle`, `updated` (ISO), `width` = `narrow`/`default`/`wide`/`full` | children = page content; `slot="actions"` child = header buttons |
| `<ai-stat>` | `label`, `value`, `delta` ("+3"), `hint`, `trend` = `up`/`down` | — |
| `<ai-table>` | `sortable`, `dense`, `empty`, `caption`, `columns`, `rows` | `columns: [{ key, label, type?: 'date'|'datetime'|'number'|'badge'|'link', align?: 'right', width?, hrefKey?, variant?, format?, render?(row) → string|Node }]`, `rows: object[]`, `onRowClick(row)`; event `row-click` |
| `<ai-list>` | `items`, `empty` | `items: [{ title, subtitle?, meta?, badge?, badgeVariant?, href?, initials? }]`, `onItemClick(item)`; event `item-click` |
| `<ai-kv>` | `items` | `items: [{ label, value }]` or `{ label: value }` |
| `<ai-tabs>` + `<ai-tab label name>` | `active` (tab name) | event `tab-change` |
| `<ai-calendar>` | `view` = `week`/`month`, `date` (anchor), `week-start` = `mon`/`sun`, `events` | `events: [{ start (ISO), end?, title, subtitle?, href?, color?, allDay? }]`, `onEventClick(ev)`; event `event-click`; has prev/today/next + view toggle |
| `<ai-live>` | `every` ("10m"), `label`, `src` (URL fetched with `ai.fetch`, JSON parsed) | `load = async (body, el) => string|Node|void` (fills `el.body`), `render = (data, body) => …` for `src`; `refresh()`; events `refreshed`, `data`. Shows "Updated 2m ago" + Refresh. Minimum 1 minute. |
| `<ai-markdown>` | `src` (VFS path) or inline text | `text` property. Headings, lists, tasks, tables, code, links. |
| `<ai-image>` | `src` (VFS path or URL), `alt`, `height`, `fit` | VFS paths resolve through `ai.fs.dataUrl` |
| `<ai-empty>` | `title`, `description` | children = action buttons |
| `<ai-alert>` | `variant`, `title` | children = message |
| `<ai-skeleton>` | `lines`, `height` | placeholder while loading |
| `<ai-progress>` | `value`, `max` | — |
| `<ai-badge>` | `variant` | children = text |

Helpers on `ai.ui` (also `window.AiKit`): `h(tag, attrs, ...children)`, `esc(text)`, `fmtDate`, `fmtTime`, `fmtDateTime`, `fmtNumber`, `timeAgo(ms)`, `markdown(text)`, `open(href)`.

## Data loading pattern

Static snapshot (most artifacts): fetch and shape data in **your** turn, embed it as a JS literal, set `updated=`. Reliable, testable, no runtime failures for the user.

Live data (feeds, inbox, announcements): use `<ai-live>` so the page refreshes itself:

```html
<ai-live id="ann" every="15m" label="Announcements"><ai-skeleton lines="4"></ai-skeleton></ai-live>
<script>
  document.getElementById('ann').load = async (body) => {
    const res = await ai.fetch('https://school.instructure.com/api/v1/announcements?context_codes[]=course_123&per_page=20')
    if (!res.ok) throw new Error('Canvas ' + res.status)
    const items = JSON.parse(res.text).map(a => ({ title: a.title, subtitle: a.context_name, meta: ai.ui.fmtDate(a.posted_at), href: a.html_url }))
    const list = ai.ui.h('ai-list', { empty: 'No announcements.' })
    list.items = items
    return list
  }
</script>
```

Judgment work (summaries, drafting, browsing) belongs behind a button that calls `ai.invoke(prompt)`; never call `ai.invoke` on load or on a timer.

Persist user edits with `ai.autosave()` (checklists, notes) and per-artifact values with `ai.state`.

## Before presenting

1. `api.artifacts.reset(path)` — first-open state.
2. `api.artifacts.eval(path, "await ai.waitFor(() => document.querySelectorAll('ai-table tbody tr').length > 0, { timeoutMs: 15000 }); return document.body.innerText.slice(0, 1200)")` — real content, no `undefined`/`NaN`/`[object Object]`.
3. `api.artifacts.logs(path)` empty of errors; `api.artifacts.trace(path)` shows expected calls with 2xx.
4. `filesystem_view(path)` — layout, overflow, empty states.
5. Link it once: `[Week view](/workspace/artifacts/week.html)`.

## Custom visuals

Whiteboards, diagrams, charts: keep `<ai-app>` for the frame and put your SVG/canvas inside a `.card`. Charting via CDN (`<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>`) works — the viewer inlines it. Read colors from tokens (`getComputedStyle(document.documentElement).getPropertyValue('--brand')`). Opt out of the kit entirely only for full-bleed custom pages: `<meta name="artifact-kit" content="off">`.
