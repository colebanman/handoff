---
name: google-docs
description: Write, format, and structure Google Docs reliably — enter text, change font/size/spacing, build MLA/APA papers, add page numbers and headers, and read the document back. Use whenever the task involves docs.google.com/document (writing an essay, formatting a paper, editing a doc).
metadata:
  version: "1"
  short-description: Reliable Google Docs authoring & formatting
---

# Google Docs

Google Docs renders the page to a **canvas**, so the document body is INVISIBLE to `browser_snapshot` — you will see the menus, toolbar, and dialogs but NOT the text you are writing. Do not fight this. You drive the doc with two things the snapshot *can* see (the menubar + toolbar) and one thing it can't (the editing surface, which you write to with keyboard/CDP input). This skill tells you exactly how.

Everything below is verified working in the extension. Follow it and formatting a paper is easy.

## The one rule that fixes most failures

**The editor body is never in the accessibility snapshot.** After any action that moves focus to a menu, dialog, toolbar field, or the font box, focus is NOT in the document. To type into the document again you MUST return focus to the body first:

- Press **Escape** — the single most reliable way to return focus to the document body. Press it once after closing any menu/dialog; press twice if a submenu was open.
- Then optionally `browser_press_key("cmd+ArrowDown")` (Mac) / `"ctrl+ArrowDown"` to jump the caret to the very end of the document before appending.

If text "disappears" or nothing seems to happen when you type, you are almost certainly typing into a closed menu — press Escape and try again. Verify with the readback trick below, never by snapshot.

## Reading the document back (your eyes)

Since you can't see the body, confirm your work by exporting the doc as plain text. Run this in `sandbox_exec` — it uses the user's logged-in session:

```js
// docId = the /d/<ID> segment of the CURRENT tab url. IMPORTANT: a brand-new
// doc's id CHANGES after the first edit/save, so always re-read it from the
// live url, don't cache the one from docs.new.
const url = (await api.tabs.list()).find(t => t.active)?.url || ''
const docId = url.match(/\/d\/([^/]+)/)?.[1]
const r = await api.fetch(`https://docs.google.com/document/d/${docId}/export?format=txt&t=${Date.now()}`)
return r.text.slice(0, 2000)   // the document's text content
```

Export formats: `txt` (plain text — best for verifying content), `html` (see inline formatting/bold/italic), `pdf` (final layout). Always add `&t=${Date.now()}` to dodge caching. There is a few-seconds lag between typing and export catching up — `browser_wait 2500` before reading.

## Opening a doc

- New blank doc: `browser_navigate` to `https://docs.new` (redirects to the real `/d/<id>/edit` url). Then `browser_wait forLoad` — Docs takes a few seconds to boot.
- After it loads, the hidden editing target already has focus, so you can start typing immediately. If unsure, press Escape then `cmd/ctrl+ArrowDown` first.

## Typing text

The document accepts normal key events. For normal writing, use `browser_type` for fields/short passages or raw CDP `Input.insertText` for reliable bulk insertion. Do not hand-roll per-character key-event loops; if the user explicitly requests visible paced entry, use small meaningful chunks with ordinary typing and waits, then verify the resulting text.

**Bulk insertion:** use raw CDP `Input.insertText` via `sandbox_exec` — it drops the whole string in at the caret in one call (tens of ms), including punctuation, quotes, and unicode like em dashes:

```js
const url = (await api.tabs.list()).find(t => t.active)?.url || ''
const tabId = (await api.tabs.list()).find(t => t.active)?.id
await api.cdp(tabId, 'Input.insertText', { text: 'A whole paragraph inserted at once, with "quotes" and — dashes.' })
```

Newlines: `Input.insertText` with `\n` DOES create new paragraphs. With `browser_type`, a literal `\n` may not — press Enter between paragraphs instead (`browser_press_key("Enter")`), or use `Input.insertText`.

Do not paste via clipboard — it silently fails in Docs.

## Formatting: the mental model

The **toolbar and menubar are fully in the snapshot** with stable ids and their keyboard shortcuts shown in the labels. So you have three ways to format, in order of preference:

1. **Keyboard shortcuts on selected text** — fastest, no focus juggling. Select first (`cmd/ctrl+a` for whole doc, or Shift+Arrows for a range), then:
   - Bold `cmd/ctrl+b`, Italic `cmd/ctrl+i`, Underline `cmd/ctrl+u`
   - Align: left `cmd/ctrl+shift+l`, center `cmd/ctrl+shift+e`, right `cmd/ctrl+shift+r`, justify `cmd/ctrl+shift+j`
   - These act on the current selection/caret, so selection state matters — verify what's selected.
2. **The menu search box ("present the menus")** — press `alt+/` (Option+/), type what you want (e.g. "double spacing", "word count", "insert page number", "hanging indent"), and press Enter on the top match. This is the MOST robust way to reach any command without hunting through nested menus, and it works for nearly everything. Prefer it when a shortcut doesn't exist.
3. **Clicking toolbar/menu items by ref** — snapshot, then click. Use for the font family and font size controls (below) and anything visual.

After ANY of these that opened a menu/box, press **Escape** to get focus back to the body.

### Font family and size (toolbar comboboxes)

These are the two controls people always want (e.g. Times New Roman 12 for MLA). Select the target text first (`cmd/ctrl+a` for the whole doc).

- **Font family:** click the font combobox in the toolbar (snapshot shows it as a listbox labeled "Font", currently e.g. "Arial", id `#docs-font-family`). A menu of fonts opens as `menuitemcheckbox` items ("Times New Roman", "Arial", "Georgia", "Calibri", …) — click the one you want by its name.
- **Font size:** the toolbar has a font-size box (`#fontSizeSelect`, a textbox labeled "Font size"). Click it, select-all its contents (triple-click or `cmd/ctrl+a`), type the number (e.g. `12`), press Enter.
- Same textbox pattern works for the Zoom box (`#zoomSelect`, "Zoom") if zoom ever gets changed accidentally — set it back to `100%`.

Then Escape to return to the body. Confirm via the `format=html` export if you need to be sure it took.

### Line spacing

Menu search (`alt+/` → "line spacing" → pick) is easiest. Or Format menu → "Line & paragraph spacing" → choose Single / 1.15 / 1.5 / Double (they're `menuitemradio` items; the checked one shows `aria-checked`). Double spacing is the MLA/APA default.

## Pages vs Pageless — READ THIS before adding headers or page numbers

New Google Docs often open in **Pageless** mode, which has NO pages, NO headers/footers, and NO page numbers — the Insert menu simply won't offer them. If "Header", "Footer", or "Page numbers" are missing from Insert → Page elements, you are in Pageless mode.

**Switch to Pages first:** Format menu → "Switch to Pages format" (or menu search `alt+/` → "pages format"). Now headers/footers/page numbers are available. (This is the #1 reason models fail to add MLA page numbers.)

## Headers, footers, and page numbers

(In Pages mode.) Insert menu → **Page elements** → then:
- **Header** / **Footer** — inserts and moves the caret INTO the header/footer region; type there, then Escape to return to the body.
- **Page numbers** — opens a small picker of four position tiles, each with a clear aria-label you can click directly:
  - "Row 1. Column 1. Page number in header starting on the first page"
  - "Row 1. Column 2. Page number in header starting on the second page"
  - "Row 2. Column 1. Page number in footer starting on the first page"
  - "Row 2. Column 2. Page number in footer starting on the second page"
  - Plus "More options" (dialog with numbering start value, etc.) and "Page count" (inserts the total-pages field, for "Page X of Y").
- After inserting a page number the caret is in the header/footer, next to the number field. For an **MLA header** ("Lastname 1", flush right): insert the page number into the header on page 1 (Row 1 Col 1), then with the caret just before the number type the last name and a space, and right-align the header line (`cmd/ctrl+shift+r`). Escape back to the body when done.

## Recipe: a complete MLA paper

1. Open `https://docs.new`, wait for load.
2. **Switch to Pages format** (Format → Switch to Pages format) — required for the header.
3. Select all (`cmd/ctrl+a`), set font **Times New Roman**, size **12**, line spacing **Double**. Escape.
4. Insert → Page elements → Page numbers → "Row 1. Column 1." tile (header, from first page). With the caret before the number, type the student's last name + space; right-align the header line. Escape.
5. `cmd/ctrl+ArrowDown` to the body. Type the four MLA heading lines (Name / Instructor / Course / Date), each followed by Enter.
6. Center the title line (`cmd/ctrl+shift+e`), type the title, Enter, then left-align (`cmd/ctrl+shift+l`) for the body.
7. Type the essay body with `Input.insertText` per paragraph, pressing Enter between paragraphs.
8. For a Works Cited page: Insert → Break → Page break; center + type "Works Cited"; then apply a **hanging indent** (menu search `alt+/` → "indentation options" → Special indentation → "Hanging" → Apply).
9. Verify with the `format=txt` export.

## Word count, find/replace, other commands

- **Word count:** `alt+/` → "word count" → Enter (or `cmd/ctrl+shift+c`). Reads back in a dialog; you can also just count from the `format=txt` export.
- **Find & replace:** `cmd/ctrl+h`.
- Anything else you can't find: `alt+/` and search the menus — it covers essentially every command.

## Gotchas checklist

- Body is invisible in snapshots — verify with the txt export, not the snapshot.
- Lost focus after a menu/dialog → press Escape (twice if a submenu was open), then `cmd/ctrl+ArrowDown`.
- Missing Header/Page-number options → you're in Pageless mode → Format → Switch to Pages format.
- New doc's id changes after first save → always read docId from the current tab url.
- Don't paste via clipboard; use `browser_type` or `Input.insertText`.
- Formatting shortcuts act on the current selection — set the selection first and confirm it.
- Give the export a couple seconds to catch up after typing (`browser_wait 2500`).
