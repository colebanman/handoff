# Architecture

Handoff is a Chrome Manifest V3 extension built with TypeScript, React, Vite, and the AI SDK. A separate Node.js bridge connects local agents through MCP or HTTP.

```text
sidepanel.html — chat, files, settings, and task UI
    │ Chrome runtime messages
background/index.ts — service worker
    ├── agent-host: model turns, checkpoints, task execution
    ├── memory-host: evidence capture, background observation and consolidation
    ├── automation-host: scheduled work
    ├── panel-view: side-panel/full-tab handoff
    ├── CDP: snapshots and browser interaction
    └── bridge: loopback client and panel request forwarding
    │
offscreen.html — DOM-dependent work and sandbox host
    ├── sandbox.html: JavaScript execution realm
    └── IndexedDB virtual filesystem

local coding agent → handoff-bridge → extension → model/browser work
```

## Source layout

| Directory | Responsibility |
| --- | --- |
| `src/agent/` | Provider routing, prompts, model loops, memory, workflows, subagents |
| `src/background/` | Execution ownership, automation, bridge and artifact coordination |
| `src/cdp/` | Chrome debugger protocol, page snapshots, browser interaction |
| `src/sandbox/` | Sandboxed execution and privileged API dispatch |
| `src/storage/` | Settings, chats, files, memory setup, automations |
| `src/ui/` | Side-panel state and React components |
| `src/artifact/` | Interactive artifact runtime and viewer |
| `src/stickies/` | Page notes and overlays |
| `src/shared/` | Contracts, protocols, context, diagnostics, redaction |
| `src/skills/` | Bundled skills seeded into the workspace |
| `bridge/` | Dependency-free Node.js CLI, HTTP daemon, and MCP server |

## Execution and persistence

The service worker owns active turns. Closing the panel does not itself cancel accepted work. Chrome can still terminate the worker or browser; persisted checkpoints allow interrupted work to be presented accurately, not a byte-for-byte continuation of a provider stream.

New bridge requests currently enter through the open side panel. This acceptance requirement is separate from ownership of an already-started turn. Read-only bridge operations can use persisted chats while the panel is closed.

The virtual filesystem uses `handoff-vfs`; derived memory uses `handoff-memory`; the bridge uses `~/.handoff-bridge`. Saved workflow sources begin with a Handoff metadata header. These identifiers describe this distribution's fresh installation, not an automatic migration from another extension.

## Providers and request context

Provider resolution separates subscription credentials from explicit API-key billing. Claude uses native Messages streaming, OAuth refresh, signed thinking replay, prompt-cache boundaries, and request-only image limits. Scoped declarative network rules apply only to this extension's Anthropic message and OAuth-token requests.

The context meter measures the most recent main-agent request rather than accumulated billed tokens. Context limits follow the actual provider/authentication route; account and gateway catalogs are used when available. Unknown custom models do not inherit another provider's advertised limit. Tool media is projected into each transport's supported format without rewriting saved history.

## Memory and continuity

Committed execution records feed a durable evidence journal. Sources retain their origin, outcome, timing, and actual harness version; reasoning and injected context are excluded. Background observation proposes schema-checked updates, and idle consolidation reconciles related memories. Legacy memory files remain compatible and supply source fingerprints and activation cues during migration.

Foreground recall is local, scoped to the task and observed pages, and bounded to 10,000 tokens of supplied memory context. Stable IDs and revisions avoid repeated deliveries within retained history. Expiry, correction, forgetting, chat deletion, and a privacy revision invalidate stale context and opaque checkpoints. User-edited entries are protected from automatic rewriting. The memory inspector exposes sources, connections, lifecycle controls, and separate learning/recall switches. See [PRIVACY.md](../PRIVACY.md) for provider routing, defaults, exports, and deletion limits.

## Browser actions and sandbox isolation

Verified form operations resolve supplied references before acting, handle text/select/checked intentions, verify values locally, and stop at uncertainty or structural changes. Pointer and focus checks prevent dispatch to stale or covered targets. Lost responses do not authorize replay of an action that may already have executed. Page evaluation is compiled first to distinguish expression/statement syntax without executing a mutation twice.

Browser ownership belongs to a chat/run, with leases held during actual operations and explicit handoff to delegated agents. A user message's captured page and the agent's working tab are distinct. Sandbox scratch storage and supported legacy global aliases are isolated by session; offline subagents retain local computation/filesystem access through an explicit API allowlist. These convenience boundaries do not create a new security realm.

## UI and artifacts

The panel and expanded chat tab share one writer lock. Drafts and staged attachments transfer through session storage while service-worker execution continues. The activity feed groups tool/thinking work, derives action receipts from code, and respects reduced motion. Streaming Markdown preserves completed content while handling incomplete tables, inline markup, and math.

The artifact kit supplies markdown-first documents, automatic navigation, directives, tables, cards, callouts, and persistent task lists. Verification reloads saved artifacts while preserving their durable state. General file attachments use collision-safe imports into the virtual filesystem; full reads and searches report truncation and directory scope explicitly.

## Build variants

`npm run build` creates the production extension in `dist/`. `npm run build:dev` creates a separate installation in `dist-dev/` with `HANDOFF_DEV=1`. The inspector and storage-reset code are development-only. The optional `HANDOFF_REPL_E2E` entry is also restricted to development builds.
