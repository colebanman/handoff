---
name: repl-extensions
description: Create, inspect, test, repair, or retire persistent apps.* REPL functions when a verified shortcut offers substantial reuse or a tactical advantage.
version: 1
---

# Personal REPL extensions

Persist capability, not a transcript. A good function replaces repeated reasoning/tool round trips with a stable input, useful result, and an observable success condition. One hard-won API discovery can justify saving a function; a one-off click usually cannot. Finish the task first or use the task itself as validation. Never manufacture abstractions to meet a quota. Respect instructions not to save, and the learning setting.

Context is a cost: unnecessary docs compete with the user's task, increase latency, and can reinforce stale assumptions. Only concise relevant signatures and brief optional guidance are injected, including after compaction. Inspect `api.extensions.get({id})` for exact source, tests, configuration, and full schemas. Edit only what improves future execution. Facts/preferences belong in memory; current records should be fetched afresh.

## Use and inspect

```js
await api.extensions.list({query: "canvas"});
const saved = await api.extensions.get({id: "canvas"});
const canvas = apps.canvas.for({tabId: 42});
return await canvas.api.searchModules({classId: "123", text: "quiz"});
```

`apps` is injected fresh in every cell. Do not retain an app handle, `ctx`, or its `api` in `state`. Published source survives new chats, compaction, and reloads. Transient JS objects and page refs do not. A function receives `ctx.api` (normal REPL API), `ctx.binding` (`tabId`, `origin`, `url`, optional `accountId`), `ctx.config`, and `ctx.console`. It may compose API requests, snapshots, clicks, navigation, and tab activation normally. It inherits the caller's scope and cancellation.

## Author

Call `stage` with either `{path:'/skills/<id>', expectedRevision}` or `{bundle:{manifest,source,tests}, expectedRevision}`. Use `0` for a new package. Inline staging writes editable files; path staging captures `extension.json`, `index.js`, and `tests.json` together. Source uses CommonJS `module.exports`; public functions take `(ctx, input)`. Public exports must match `manifest.actions` exactly. Initialize no browser actions at module load. Use private helpers for common code. No Node APIs or ESM imports.

Minimal complete example (local operation; use your actual observed method for real tasks):

```js
const draft = await api.extensions.stage({
  expectedRevision: 0,
  bundle: {
    manifest: {
      version: 1, id: "textHelpers", description: "Reusable text cleanup",
      triggers: ["normalize whitespace"], sites: [],
      actions: {
        normalize: {
          description: "Collapse repeated whitespace and trim edges",
          effects: "local",
          input: {type:"object", properties:{text:{type:"string"}}, required:["text"]},
          output: {type:"string"}
        }
      }
    },
    source: 'module.exports = {normalize: async (ctx, {text}) => text.replace(/\\s+/g, " ").trim()};',
    tests: [{name:"collapse", action:"normalize", input:{text:" a   b "}, mode:"fixture", assert:[{equals:"a b"}]}]
  }
});
const tested = await api.extensions.test({draftId:draft.draftId});
if (!tested.ok) return tested; // inspect, repair source, stage and retest
return await api.extensions.publish({draftId:draft.draftId, expectedRevision:0});
```

Schema fields: `type` is object/array/string/number/boolean/null; optional `properties`, `required`, `items`, `enum`. Export paths can be dotted, such as `api.searchModules` and `browser.showAnnouncement`. Effects are `local`, `read`, `browser`, or `write`; these are descriptive, not an arbitrary-code read-only sandbox. Browser effects need a matching live tab. Bind targets explicitly when multiple accounts/sites are plausible. Read/write methods without a tab must use an explicit known origin; never guess another account.

When the user enables experimental TypeSafe, the harness may invoke familiar published `read`/`local` actions before the first model step. Eligibility requires passing tests (live for `read`), a matching HTTP(S) tab for reads, and inputs whose required fields are enums/booleans or absent. Open-ended required inputs and browser/write effects stay with the agent. Describe defaults and purpose accurately; use enums only for genuinely closed sets, never hard-code changing course IDs or dates just to qualify. Results are delivered as ordinary tool results: use them without repeating the call. TypeSafe extraction checks still need original source evidence, not a function's unsupported summary.

Matching metadata:

- `sites`: host/path globs, e.g. `school.instructure.com/**` or an exact custom domain. Scheme/port matter when specified; paths are case-sensitive. These also validate bound tabs.
- `triggers`: explicit task aliases that surface the package even before navigation.
- `when`: nested `{all:[...]}`, `{any:[...]}`, `{not:...}` with leaves `{url:"host/path/**"}`, `{task:"alias"}`, `{dom:{selector:"...", text?:"...", visible?:true, frame?:"any"}}`, or `{time:{from:"07:00",to:"10:00",timeZone:"America/New_York",days:[1,2,3,4,5]}}`. URL/DOM clauses in a conjunction refer to the same tab. An unavailable observation is unknown. Time windows affect suggestions, never schedule execution or forbid explicit calls. Explicit `sites` are the target boundary; `when` is a suggestion signal.
- `instructions`: at most 400 characters of supplemental future guidance. Correct useful calling assumptions here, remove outdated advice, and keep detailed explanation in source or SKILL.md. This is the editable part of future prompt context; it cannot override the user's task or host boundaries.

Keep metadata terse. Do not save bearer tokens, cookies, CSRF values, signed URLs, DOM refs, or tab IDs. Obtain them from the current session when needed. Handle pagination, auth, non-JSON login pages, and meaningful empty results. Do not mistake a 200 status for success. A UI helper must verify it displayed the intended record.

## Test and improve

Every public action needs a passing named test. Cases contain `name`, `action`, `input`, `mode`, and nonempty `assert`. Assertions support dotted `path`, `equals`, string `includes`, and array `minItems`. Fixture `replies` maps RPC paths (e.g. `page.fetch`) to arrays of sequential results. Fixtures test logic; they are not live validation. Each case gets fresh module and fixture state.

Live tests require `api.extensions.test({draftId, live:true, bindings:{tabId}})` and call the real APIs. Add assertions on the final result; inspect the real page independently when appropriate. Use only actions already authorized by the current task. Never duplicate a submission, email, purchase, or deletion merely to get a passing test. For such actions use a test environment or fixtures, and keep the live-validation limitation visible.

To improve an extension: inspect `get({id})`, edit the working source/manifest/tests, stage against its current revision, test, then publish. A conflict means another writer published first: inspect and merge. Publishing preserves existing handles' revision for the current execution; later steps discover the new signatures. Preserve compatible action names and inputs. Shared helper changes require retesting affected actions.

Disable: `api.extensions.disable({id})`; re-enable: `api.extensions.disable({id,disabled:false})`. Undo: `api.extensions.rollback({id,revision,expectedRevision})`. Remove: `api.extensions.remove({id})`. Neither rollback nor removal undoes past browser actions. Do not retry uncertain writes: inspect the actual external result first.

Account configuration: `api.extensions.configure({id,origin,accountId?,value})`. Values are small scoped preferences, not credentials or durable API results. Supply `accountId` through `.for({tabId,accountId})` when needed; no automatic identity inference is promised.

Learning preference: `api.extensions.settings()` or `api.extensions.settings({learningEnabled:false})`. Disabled learning preserves existing callable functions. Users can inspect/edit working files and disable/undo published extensions in Files → Skills. Package-directory downloads export working source; publishing always requires local staging/tests. Keep user-disabled extensions disabled.
