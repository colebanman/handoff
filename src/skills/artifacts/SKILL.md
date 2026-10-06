---
name: artifacts
version: 3
description: How to build HTML artifacts with the bundled artifact kit — markdown-first <ai-doc>, ::: directives, <ai-*> components, live data, and verification before presenting.
---

# Artifacts — the kit

Every `.html` artifact loads the **artifact kit**: shadcn-style CSS plus `<ai-*>` components. Never include, restyle, or re-theme it. Your job is content and structure, not CSS. No `<style>`, no `style=`, no forced `data-theme`, no hand-built card/badge markup: the kit already has them, and they look better and cost fewer tokens.

**Write markdown, not HTML.** Kit markdown turns into polished components (tables, callouts, cards, steps, checklists, sources). A file can be only this (no `<html>`/`<head>` boilerplate needed):

```html
<ai-doc subtitle="Project brief · working draft" updated="2026-09-30T22:22:00Z" accent="violet">
# Example product — experiment plan

::: details How the feedback shaped this draft
- **Earlier review feedback:** keep case evidence and tables.
:::

## 1. Scientific testing
| Stage | Application |
|-|-|
| Hypothesis | Predict which features appeal to a user segment. |

::: note Customer feedback
Testing measures useful outcomes, not just sign-ups.
:::

- [ ] Review the proposed experiment
- [ ] Share the reviewed plan

::: sources
- [Example brief](https://example.com/brief)
:::
</ai-doc>
```

`<ai-doc>` = page header + reading column + automatic "On this page" nav when there are 3+ `##` sections. A leading `# Title` becomes the page title. Attributes: `title`, `subtitle` (inline markdown), `updated` (ISO), `accent`, `width` (`narrow`/`default`/`wide`/`full`), `toc="off"`, `src` (VFS .md path). Children with `slot="actions"` go in the header.

For dashboards and apps, use `<ai-app title subtitle updated accent width>` and put `<ai-markdown>` blocks, `<ai-*>` components, and your own `<script>` inside it.

## Pick a shape (don't make every artifact a stack of cards)

| Content | Shape |
|-|-|
| Draft, notes, brief, study guide, review | `<ai-doc>` with `##` sections, tables, callouts, `::: details`/`::: accordion` for supporting material, `::: sources` last |
| Dashboard or status | `<ai-app>` → `::: stats` row, then a `::: grid 2` of cards (bars, timeline, lists), then a table |
| Plan, itinerary, or process | `::: timeline` (times/dates) or `::: steps` (ordered actions), task lists for things to tick off |
| Listings (jobs, options, products) | `::: cards` (one `###` per item) or a `::: table {sortable filter}` when there are more than ~8 items |
| Comparison or decision | a table with the options as columns, a `::: tip` stating the recommendation, and the reasoning in `::: details` |
| Practice or Q&A | `::: accordion`, one `###` per question and the answer as its body |

Lead with the answer (a summary callout or stats), then detail. Use one or two component types per section. Leave plain prose as prose, and don't wrap a single paragraph in a card. Pick an `accent` that fits the subject (`blue` default, `violet`, `green`, `amber`, `rose`, `teal`, `orange`, `slate`) so artifacts don't all look the same.

## Kit markdown

Standard GFM works: headings, **bold**/*italic*/~~strike~~/`code`, links, images (VFS paths too), nested lists, `> quotes`, fenced code (gets a copy button), `---`, and tables. Tables accept `|-|` separators and `:-:`/`-:` alignment, and numeric columns right-align on their own. Lines that start with an HTML tag pass through, so `<ai-calendar id="cal"></ai-calendar>` can sit between markdown blocks.

- `- [ ] task` / `- [x] done`: real checkboxes, **saved per artifact automatically** (event `task-change`). Don't hand-roll checklist state.
- Inline: `:badge[Overdue]` (tone is inferred from the wording: done/submitted → green, pending/draft/in progress → amber, overdue/missing/blocked → red, new/upcoming/scheduled → accent), `:badge-success[…]`/`-warning`/`-destructive`/`-brand`/`-outline`/`-muted` to force a tone, `:kbd[⌘K]`, `:icon[calendar]`, `==highlight==`.
- `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]` (optional title after the tag).

### Directives

`::: name args {flags}` … `:::`. They nest; each bare `:::` closes the innermost one.

| Directive | Body → result |
|-|-|
| `note`/`info`, `tip`/`success`, `important`, `warning`, `danger` + optional title | callout with an icon |
| `card Title \| description {flush tone=success icon=calendar}` | card with a markdown body |
| `details Summary {open}` / `reveal [label]` | collapsible section (`reveal` defaults to "Reveal answer") |
| `accordion {open}` | one collapsible per `###` heading |
| `cards [cols]` | one card per `###` heading; the heading can be a link. Use it for listings |
| `grid [2-4]` | nested directives side by side (any loose markdown becomes its own cell) |
| `tabs` | one tab per `##`/`###` heading |
| `stats [cols] {invert}` | lines `Label \| Value \| delta \| hint`. A delta starting with +/- colors itself; `invert` means down is good |
| `bars {max=100 tone=success}` | lines `Label \| value \| note`, where the value is `18/20`, `72%`, or a number |
| `steps` | list items or `###` sections. `**Title** — text` becomes the step title; `[x]` marks the step done |
| `timeline` | list items like `- **9:50 AM** Lecture — room 300`, or `###` headings as the time labels |
| `kv` | lines `Label: value` → a definition list |
| `table [caption] {sortable filter dense}` | a pipe table becomes an interactive `<ai-table>` (sort, search box) |
| `sources [title]` | a muted footer; each link gets its host chip |

## Components (for data you set from JS)

All render into light DOM. Data goes in via **properties** (`el.rows = [...]`) or JSON attributes.

| Element | Use |
|-|-|
| `<ai-table sortable filter dense empty columns rows>` | `columns` = compact spec `"Course, name=Assignment:link(url), due=Due:datetime, Status:badge, Pts:number"` (types: `date` `datetime` `number` `badge` `link(hrefKey)`, default = inline markdown), or objects `{ key, label, type, align, render(row) }`. `rows` = objects, or **arrays** (no repeated keys; with no `columns`, the first row is the header). A pipe table as children also works. `badge` cells infer their tone; `variant: {Late: 'destructive'}` overrides. `onRowClick(row)` |
| `<ai-card title description icon href tone collapsible open flush>` | card; text-only children render as markdown; `slot="actions"`/`slot="footer"` |
| `<ai-stat label value delta hint icon trend>` | one metric |
| `<ai-list items>` | `[{ title, subtitle?, meta?, badge?, badgeVariant?, href?, initials? }]` |
| `<ai-calendar view=week\|month date events>` | `events: [{ start, end?, title, subtitle?, href?, color?, allDay? }]` |
| `<ai-live every="15m" label src>` | self-refreshing section: `el.load = async (body) => Node\|string` |
| `<ai-markdown src>` / `el.text = md` | kit markdown anywhere |
| `<ai-alert variant title>` | callout (`info` `success` `warning` `destructive` `brand`); text children are markdown |
| `<ai-tabs>` + `<ai-tab label name>`, `<ai-kv items>`, `<ai-image src>`, `<ai-empty title description>`, `<ai-skeleton lines>`, `<ai-progress value max>`, `<ai-badge variant>`, `<ai-icon name>` | as named |

Icons (`:icon[x]`, `icon=`): info, alert-triangle, circle-check, circle-x, lightbulb, sparkles, check, x, plus, chevron-right, chevron-down, arrow-right, external-link, link, copy, clock, calendar, map-pin, user, users, mail, file-text, book, graduation-cap, briefcase, dollar, trending-up, trending-down, target, flag, star, zap, search, refresh, list, check-square, home, plane, shopping-cart, code, message-square, heart, lock.

Classes, when you need raw HTML: `.stack`/`.row`/`.grid .cols-2..4`, `.card`/`.card-header`/`.card-title`/`.card-content`, `.btn` (`-outline` `-ghost` `-secondary` `-brand` `-destructive` `-sm`), `.input`, `.badge-*`, `.muted`, `.text-sm`, `.mono`. Helpers: `ai.ui.h(tag, attrs, ...children)`, `esc`, `markdown(text)`, `inline(text)`, `icon(name)`, `tone(text)`, `fmtDate`, `fmtDateTime`, `fmtNumber`, `timeAgo`.

## Token discipline

- Prose and tables go in markdown. Never build `<div class="card"><div class="card-header">…` chains or `<span class="badge">` by hand.
- Data tables: array rows plus a column spec string. Put constant values (source, retrieval note) in a caption or subtitle once, not in every row.
- Put repeated items (jobs, problems, edits) in `::: cards` / `::: accordion` / a table. Never write the same HTML shape 20 times, and never keep content in both HTML and a JS array.
- To copy a snippet, use a fenced code block; the copy button comes free.

## Data loading

Static snapshot (most artifacts): fetch and shape the data in **your** turn, embed it, set `updated=`. Live data (feeds, inbox): `<ai-live>` with `ai.fetch`. Judgment work (summaries, drafting, browsing) goes behind a button that calls `ai.invoke(prompt)`, never on load or on a timer. Persist edits with `ai.autosave()` / `ai.state` (task lists already persist).

```html
<ai-app title="Announcements" accent="teal">
<ai-live id="ann" every="15m" label="Canvas"><ai-skeleton lines="4"></ai-skeleton></ai-live>
</ai-app>
<script>
  document.getElementById('ann').load = async () => {
    const res = await ai.fetch('https://school.instructure.com/api/v1/announcements?context_codes[]=course_123')
    if (!res.ok) throw new Error('Canvas ' + res.status)
    const t = ai.ui.h('ai-table', { sortable: true, filter: 'Search announcements' })
    t.columns = 'Title:link(3), Course, Posted:date'
    t.rows = JSON.parse(res.text).map(a => [a.title, a.context_name, a.posted_at, a.html_url])
    return t
  }
</script>
```

## Before presenting

1. `api.artifacts.reload(path)` to verify the saved document without clearing durable state. Never reset an existing artifact during verification: reset deletes saved checkboxes/preferences. If first-open behavior needs testing, use a disposable copy at a different path.
2. `api.artifacts.eval(path, "await ai.waitFor(() => document.querySelector('.md, ai-table tbody tr'), { timeoutMs: 15000 }); return document.body.innerText.slice(0, 1200)")`: real content, with no `undefined`/`NaN`/`[object Object]` and no leftover `:::` or `|` lines (either one means a directive or table didn't parse).
3. `api.artifacts.logs(path)` has no errors (an unknown `:::` name logs a warning). `api.artifacts.trace(path)` shows the expected calls returning 2xx.
4. `filesystem_view(path)`: check hierarchy, spacing, overflow, and empty states.
5. Link it once: `[Week view](/workspace/artifacts/week.html)`.

## Custom visuals

Charts, diagrams, whiteboards: keep `<ai-app>` as the frame and put the SVG/canvas in a `.card`. Chart libraries via CDN (`<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>`) are inlined for you. Read colors from tokens (`getComputedStyle(document.documentElement).getPropertyValue('--brand')`). For simple comparisons, prefer `::: bars` over a chart library. Opt out of the kit only for full-bleed custom pages: `<meta name="artifact-kit" content="off">`.
