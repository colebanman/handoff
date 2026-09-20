# Architecture

Handoff is a Chrome Manifest V3 extension built with TypeScript, React, Vite, and the AI SDK. A separate Node.js bridge connects local agents through MCP or HTTP.

```text
sidepanel.html — chat, files, settings, and task UI
    │ Chrome runtime messages
background/index.ts — service worker
    ├── agent-host: model turns, checkpoints, task execution
    ├── automation-host: scheduled work
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

The virtual filesystem uses `handoff-vfs`; the bridge uses `~/.handoff-bridge`. Saved workflow sources begin with a Handoff metadata header. These identifiers describe this distribution's fresh installation, not an automatic migration from another extension.

## Build variants

`npm run build` creates the production extension in `dist/`. `npm run build:dev` creates a separate installation in `dist-dev/` with `HANDOFF_DEV=1`. The inspector and storage-reset code are development-only. The optional `HANDOFF_REPL_E2E` entry is also restricted to development builds.
