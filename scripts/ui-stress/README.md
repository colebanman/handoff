# UI state and animation stress tests

Run from the repository root:

```sh
npm run test:ui
npx tsc --noEmit -p scripts/ui-stress/tsconfig.json
```

The runner starts a local Vite fixture and a **new temporary Chrome profile**.
Chrome's sandbox stays enabled. The profile is removed when the run ends. No
personal Chrome profile, account, or provider credential is loaded. External
fixture requests are intercepted; no tool actually drives another website or
calls a model.

`CHROME_PATH` overrides the Chrome executable. The runner discovers a standard
Chrome installation or a Playwright-managed Chromium installation. Reports and screenshots go to `/tmp/handoff-ui-stress`, or to
`UI_STRESS_OUTPUT`. A failed assertion, uncaught exception, or console error makes
the command fail.

## Coverage

The fixture imports the production React components, CSS, reducer, and store.
Only Chrome/service boundaries and store initialization are controlled. The
Vite-only store adapter is never included in an extension build.

- `matrix`: discovers every tool in `src/agent/tools.ts`; exercises empty and
  partial arguments, null/primitive/array/object inputs, success/error results,
  image results (including invalid images), long content, and unknown tools.
- `transitions`: feeds actual reducer events through argument streaming,
  execution, and completion; checks block, row, and busy-indicator identity.
- `actions`: discovers sandbox API/CDP action branches and covers additional
  filesystem, artifact, app, extension, PDF, archive, and partial-code cases.
- `markdown`: streams prose, headings, lists, links, code, tables, math, and
  Unicode; checks caret uniqueness, reveal completion, and earlier-word identity.
- `surfaces`: empty states, suggestions, composer states, task statuses,
  questions, recovery/rate limits, settings, onboarding, files, attachments,
  compaction, long names/options, and legacy timestamps.
- `delegation`: nested subagent and workflow states, terminal child streams,
  dialogs, and Escape dismissal.
- `continuity`: clustering, rapid disclosure reversals, connection-restart
  removals, replacement history, scroll detachment, and repinning.
- `app`: real App/store composition, including chat switching and model-menu
  state isolation.
- `reasoning`: growing headings, reasoning disclosure, and Thinking-row timing.
- `interactions`: model picker keyboard navigation, Settings tabs, IndexedDB
  file listing, and retained/reset question selections.
- `stress`: deterministic seeded bursts, stops during incomplete calls,
  compaction, snapshot rehydration, and stale animation detection.
- `motion` and `motion-change`: ambient phase continuity, interrupted phase
  swaps, reduced motion, and changing the motion preference while mounted.

Default modes are 400px dark, 320px light, 1200px full-tab dark, and 400px dark
with reduced motion. Tests measure containment, compositor animation state,
DOM identity, scroll positions, and settled outgoing elements. Screenshots are
also available for visual inspection.

This is a finite regression matrix, not a proof over arbitrary data and every
possible event interleaving. Provider execution, OAuth completion, and arbitrary
artifact JavaScript are outside this fixture; their service tests remain separate.

## Focused runs

```sh
UI_STRESS_SUITES=transitions,reasoning,motion,motion-change npm run test:ui

# width:motion:theme[:height]
UI_STRESS_MODES=320:reduce:light:400 \
UI_STRESS_SUITES=surfaces,app,interactions npm run test:ui

# Leave the owned profile open after tests for inspection, then Ctrl+C to close.
UI_STRESS_KEEP_OPEN=1 npm run test:ui
```

`connection.json` in the output directory contains the temporary browser's CDP
port and local fixture URL. `window.uiStress.render(...)` can display a specific
scenario for inspection. The seeded stress sequence is reproducible.

## Built-extension smoke test

This second runner loads the actual MV3 build into a fresh Chrome for Testing
profile and uses real Chrome storage, IndexedDB, the background worker, and panel
ownership. It checks onboarding, restored transcripts, expansion, chat switching,
Settings, Files, and a second panel. It tightens **only the disposable build's**
network CSP and disables the bridge, so external connections cannot reach real
services or an existing local bridge.

```sh
npx vite build --outDir /tmp/handoff-ui-built --emptyOutDir
node scripts/ui-stress/extension.mjs /tmp/handoff-ui-built
```

Set `CHROME_EXTENSION_PATH` to an extension-capable Chrome for Testing executable
if it is not discovered in the local Playwright cache. Both runners
leave the browser sandbox enabled.
