# handoff-bridge

A tiny local daemon that lets **local coding agents** (Claude Code, Cursor, anything
that speaks MCP or curl) drive the **Handoff Chrome extension's browser agent**.

Handoff runs inside the user's real Chrome with their logged-in sessions, so a local
agent can hand it work it cannot do itself: read the user's mail/calendar/dashboards,
operate a web app, or fetch a page behind a login.

**Zero npm dependencies.** Node 22+ built-ins only — the WebSocket server and the
MCP JSON-RPC server are hand-rolled. Nothing to install, no build step.

```
Chrome extension  ──WebSocket client──▶  ┌──────────────┐
                                         │  handoff-bridge  │
Claude Code / Cursor ──stdio MCP──────▶  │    daemon    │
CLI / curl ───────────HTTP────────────▶  └──────────────┘
                                          127.0.0.1:8787
```

The bridge only accepts tasks from local clients and returns results. Handoff cannot
invoke local agents, and there are no shared rooms.

## Quick start

```bash
node bridge/handoff-bridge.mjs start          # foreground daemon (or let it auto-start)
node bridge/handoff-bridge.mjs status         # is the extension connected? panel open?
node bridge/handoff-bridge.mjs ask "what's the top item in my inbox?"
node bridge/handoff-bridge.mjs stop
```

The daemon auto-starts (detached) the first time the CLI or the MCP server needs it.
If another local bridge uses port 8787, choose a free port in Handoff Settings and
set the same `HANDOFF_BRIDGE_PORT` for the daemon and its clients.
The Handoff **side panel must be open in Chrome** to accept new work; otherwise calls
come back `panel_closed`. Accepted turns run in the service worker and can continue
after the panel closes.

## Register with Claude Code

```bash
claude mcp add handoff -- node /absolute/path/to/handoff/bridge/handoff-bridge.mjs mcp
```

Cursor (`~/.cursor/mcp.json`):

```json
{ "mcpServers": { "handoff": { "command": "node", "args": ["/absolute/path/to/handoff/bridge/handoff-bridge.mjs", "mcp"] } } }
```

MCP tools: `handoff_ask`, `handoff_follow`, `handoff_wait`, `handoff_get`, `handoff_tool_calls`,
`handoff_list_chats`, `handoff_cancel`, `handoff_status`, `handoff_push_file`, `handoff_pull_file`,
`handoff_fs_list`, `handoff_fs_read`, `handoff_fs_write`, `handoff_fs_delete`.

## Handoff's filesystem

Handoff keeps its own filesystem inside Chrome (`/workspace` and `/skills`, backed by
IndexedDB). It is not your disk — but the bridge moves files both ways, so a local
agent can hand Handoff a document and collect what Handoff made of it:

```bash
handoff-bridge push ~/docs/resume.pdf                     # -> /workspace/inbox/resume.pdf
handoff-bridge ask "Review /workspace/inbox/resume.pdf, revise it, save it under /workspace"
handoff-bridge pull /workspace/resume-revised.md --out ./resume.md
```

Over MCP that is `handoff_push_file` / `handoff_pull_file`, or `attach: ["<local path>"]` on
`handoff_ask`, which pushes each file into `/workspace/inbox/` and appends the paths to
the prompt. `handoff_fs_read` returns text and runs the extension's extractors, so PDFs
and `.docx` come back as readable text rather than bytes. One transfer carries at
most 20 MB; anything larger stays in the browser.

## CLI

|command|what it does|
|-|-|
|`start [--port N]`|Run the daemon in the foreground (exits 0 if one is already healthy)|
|`mcp [--port N]`|stdio MCP server; stdout carries JSON-RPC only|
|`status [--json]`|Daemon + extension + side-panel state|
|`ask "<prompt>" [--wait N] [--label L] [--json]`|Start a task and wait for the answer|
|`follow <chatId> "<msg>" [--wait N] [--json]`|Continue a chat|
|`wait <chatId> [--wait N]`|Wait for an in-flight turn|
|`get <chatId> [--full] [--json]`|Read a chat|
|`tools <chatId> [--limit N]`|The chat's browser tool calls|
|`list [--limit N]`|Recent chats|
|`cancel <chatId>`|Stop a running turn|
|`ls [--root workspace\|skills]`|List Handoff's files|
|`push <localFile> [--as <vfsPath>]`|Copy a local file into Handoff's filesystem|
|`pull <vfsPath> [--out <local>] [--force]`|Copy a file back to local disk|
|`cat <vfsPath>`|Read a file as text (pdf/docx extracted)|
|`rm <vfsPath>`|Delete a file|
|`stop`|Shut the daemon down|

`--wait` is seconds: default 90, max 600, `0` returns immediately with a chat id.
Errors go to stderr and exit 1.

## HTTP API

Bind is `127.0.0.1` only. Every endpoint except `GET /health` needs
`Authorization: Bearer <token>`, and any request carrying an `Origin` header is
rejected 403 — that is what stops a malicious web page from driving the browser.

```
GET  /health                                    → { ok, version, port, extensionConnected, panelOpen, uptimeMs }
POST /status                                    → extension status + daemon fields
POST /list     { limit? }                       → { chats: [...] }
POST /get      { chatId, include? }             → extension result
POST /tools    { chatId, limit? }
POST /ask      { prompt, client?, label?, cwd?, waitSec? }
POST /follow   { chatId, text, waitSec? }
POST /wait     { chatId, waitSec? }
POST /cancel   { chatId }
POST /fs/list  { root? }                        → { files: [VfsEntry] }
POST /fs/read  { path, encoding?, offset?, maxChars? }  → { path, mediaType, size, text|base64 }
POST /fs/write { path, text? | base64?, mediaType? }    → VfsEntry
POST /fs/delete { path }
POST /shutdown
```

`/ask`, `/follow` and `/wait` return `{ ...extension summary, chatId, status }` where
`status` is `completed` (the turn went idle), `running` (still going when the wait
elapsed), `panel_closed`, or `extension_offline`.

Error bodies are `{ error: "<code>", message: "<text>" }` with codes
`unauthorized`(401), `forbidden_origin`(403), `bad_request`(400),
`extension_offline`(503), `panel_closed`(409), `extension_timeout`(504),
`not_found`(404), `internal`(500).

## Extension side (`ws://127.0.0.1:<port>/ext`)

The extension connects **out** to the daemon and is accepted when its `Origin` is
absent or starts with `chrome-extension://` (it has no filesystem access, so it
cannot present the token). Only one connection at a time — a new one replaces the old.

Daemon → extension: `{t:"req", id, op:"status"|"list"|"get"|"tools"|"ask"|"follow"|"cancel"|"fs_list"|"fs_read"|"fs_write"|"fs_delete", ...}`, `{t:"ping"}`.
Extension → daemon: `{t:"hello",...}`, `{t:"res", id, ok, result|error, code?}`,
`{t:"ev", ev:"panel"|"chat", ...}`, `{t:"pong"}`.

Every `req` gets exactly one `res` or times out after 30s (→ `extension_timeout`).
On disconnect all pending requests fail with `extension_offline`; write ops wait up
to 10s for a reconnect first.

## Files & environment

- `~/.handoff-bridge/token` — 32-byte hex shared secret, mode `0600`, created on first start.
- `~/.handoff-bridge/daemon.json` — `{ port, pid, startedAt, version }`, mode `0600`.
- `HANDOFF_BRIDGE_PORT` — default port (8787). `HANDOFF_BRIDGE_HOME` — state dir override (used by tests).

## Layout

```
handoff-bridge.mjs      CLI entrypoint / arg parsing
src/ws-server.mjs   hand-rolled RFC 6455 server (handshake, framing, keepalive)
src/daemon.mjs      HTTP API + /ext WebSocket + pending-request map + wait logic
src/client.mjs      HTTP client + ensureDaemon() auto-spawn
src/mcp.mjs         stdio JSON-RPC MCP server
src/files.mjs       local disk <-> Handoff's virtual filesystem (push/pull)
src/paths.mjs       state dir, token, daemon.json
test/               vitest (`npx vitest run bridge/`)
```
