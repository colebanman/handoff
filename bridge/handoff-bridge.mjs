#!/usr/bin/env node
// handoff-bridge CLI — the human/agent-facing skin over the daemon HTTP API.
//
//   handoff-bridge start        run the daemon (foreground)
//   handoff-bridge mcp          stdio MCP server for Claude Code / Cursor
//   handoff-bridge ask "..."    one-shot task for the browser agent
//
// Zero npm dependencies: Node 22+ built-ins only.

import { VERSION, defaultPort, stateDir, tokenPath, ensureToken } from './src/paths.mjs'
import { call, ensureDaemon, health, BridgeError } from './src/client.mjs'
import { FileError, normalizeVfsPath, pullFile, pushFile } from './src/files.mjs'

const USAGE = `handoff-bridge ${VERSION} — drive the Handoff Chrome extension from local coding agents

Usage
  handoff-bridge start [--port N]              Run the bridge daemon in the foreground
  handoff-bridge mcp [--port N]                Run the stdio MCP server (auto-starts the daemon)
  handoff-bridge status [--json]               Daemon + extension + side-panel state
  handoff-bridge ask "<prompt>" [--wait N] [--label L] [--json]
  handoff-bridge follow <chatId> "<message>" [--wait N] [--json]
  handoff-bridge wait <chatId> [--wait N] [--json]
  handoff-bridge get <chatId> [--full] [--json]
  handoff-bridge tools <chatId> [--limit N] [--json]
  handoff-bridge list [--limit N] [--json]
  handoff-bridge cancel <chatId>

  handoff-bridge ls [--root workspace|skills] [--json]     Handoff's virtual filesystem
  handoff-bridge push <localFile> [--as <vfsPath>] [--json]
  handoff-bridge pull <vfsPath> [--out <localPath>] [--force] [--json]
  handoff-bridge cat <vfsPath> [--json]        Read a file as text (pdf/docx extracted)
  handoff-bridge rm <vfsPath>

  handoff-bridge stop                          Shut the daemon down

Options
  --port N     Daemon port (default ${defaultPort()}, env HANDOFF_BRIDGE_PORT)
  --wait N     Seconds to wait for a turn to finish (default 90, max 600, 0 = don't wait)
  --as PATH    Destination in Handoff's filesystem for push (default /workspace/inbox/<name>)
  --out PATH   Local destination for pull (default the filename in the cwd)
  --force      Let pull overwrite an existing local file
  --json       Print the raw JSON response
  --help       This text

Environment
  HANDOFF_BRIDGE_PORT   default port
  HANDOFF_BRIDGE_HOME   state dir (default ~/.handoff-bridge; holds token + daemon.json, mode 0600)

The Handoff side panel must be open in Chrome for work to run.`

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq)
      const valueFlags = new Set(['port', 'wait', 'limit', 'label', 'as', 'out', 'root'])
      if (eq !== -1) flags[name] = a.slice(eq + 1)
      else if (valueFlags.has(name)) flags[name] = argv[++i]
      else flags[name] = true
    } else {
      positional.push(a)
    }
  }
  return { flags, positional }
}

const die = (message) => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** The extension result is opaque, so probe the fields it plausibly uses. */
function pickText(obj) {
  if (!obj || typeof obj !== 'object') return ''
  for (const key of ['text', 'finalText', 'answer', 'reply', 'lastAssistantText', 'lastMessage', 'summary', 'content']) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function printTurn(result) {
  const chatId = result.chatId ?? '(unknown)'
  const status = result.status ?? '(unknown)'
  process.stdout.write(`chat: ${chatId}\nstatus: ${status}\n`)
  if (result.title) process.stdout.write(`title: ${result.title}\n`)
  const body = pickText(result)
  process.stdout.write('\n' + (body || '(no text returned — try `handoff-bridge get ' + chatId + ' --full`)') + '\n')
  if (status === 'running') {
    process.stdout.write(`\nStill running. Resume with: handoff-bridge get ${chatId}\n`)
  }
}

function asList(result, keys) {
  if (Array.isArray(result)) return result
  for (const key of keys) if (Array.isArray(result?.[key])) return result[key]
  return null
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const cmd = positional[0]
  if (!cmd || flags.help || cmd === 'help') {
    process.stdout.write(USAGE + '\n')
    return
  }
  const port = flags.port ? num(flags.port, defaultPort()) : defaultPort()
  const json = !!flags.json
  const out = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
  const api = async (path, body) => {
    await ensureDaemon({ port, log: (m) => process.stderr.write(`[handoff-bridge] ${m}\n`) })
    return await call(path, body, { port })
  }
  const waitSec = flags.wait !== undefined ? num(flags.wait, 90) : 90

  switch (cmd) {
    case 'start': {
      const existing = await health(port)
      if (existing) {
        process.stderr.write(`[handoff-bridge] already running on port ${port} (pid unknown, uptime ${Math.round(existing.uptimeMs / 1000)}s)\n`)
        return
      }
      const { startDaemon } = await import('./src/daemon.mjs')
      let daemon
      try {
        daemon = await startDaemon({ port, onShutdown: () => process.exit(0) })
      } catch (err) {
        if (err?.code === 'EADDRINUSE') {
          // Someone else grabbed the port between the probe and listen().
          const now = await health(port)
          if (now) {
            process.stderr.write(`[handoff-bridge] already running on port ${port}\n`)
            return
          }
        }
        throw err
      }
      const bye = () => {
        daemon.close().finally(() => process.exit(0))
      }
      process.on('SIGINT', bye)
      process.on('SIGTERM', bye)
      return new Promise(() => {}) // run until signalled
    }

    case 'mcp': {
      const { runMcp } = await import('./src/mcp.mjs')
      await runMcp({ port })
      return new Promise(() => {})
    }

    case 'status': {
      const info = await health(port)
      if (!info) {
        if (json) return out({ running: false, port })
        process.stdout.write(`daemon: not running (port ${port})\nstart it with: handoff-bridge start\n`)
        return
      }
      const detail = await api('/status', {})
      if (json) return out(detail)
      process.stdout.write(
        [
          `daemon:     running v${detail.version ?? VERSION} on port ${detail.port ?? port}`,
          `uptime:     ${Math.round((detail.uptimeMs ?? 0) / 1000)}s`,
          `extension:  ${detail.extensionConnected ? 'connected' : 'NOT connected'}${detail.extension?.version ? ` (v${detail.extension.version})` : ''}`,
          `side panel: ${detail.panelOpen ? 'open' : 'CLOSED — open the Handoff side panel in Chrome to run work'}`,
          `running:    ${(detail.runningChats ?? []).length} chat(s)`,
          `state dir:  ${detail.stateDir ?? stateDir()}`,
        ].join('\n') + '\n',
      )
      return
    }

    case 'ask': {
      const prompt = positional[1]
      if (!prompt) die('usage: handoff-bridge ask "<prompt>" [--wait N]')
      const result = await api('/ask', {
        prompt,
        client: 'cli',
        label: typeof flags.label === 'string' ? flags.label : undefined,
        cwd: process.cwd(),
        waitSec,
      })
      return json ? out(result) : printTurn(result)
    }

    case 'follow': {
      const [, chatId, message] = positional
      if (!chatId || !message) die('usage: handoff-bridge follow <chatId> "<message>" [--wait N]')
      const result = await api('/follow', { chatId, text: message, waitSec })
      return json ? out(result) : printTurn(result)
    }

    case 'wait': {
      const chatId = positional[1]
      if (!chatId) die('usage: handoff-bridge wait <chatId> [--wait N]')
      const result = await api('/wait', { chatId, waitSec: flags.wait !== undefined ? waitSec : 120 })
      return json ? out(result) : printTurn(result)
    }

    case 'get': {
      const chatId = positional[1]
      if (!chatId) die('usage: handoff-bridge get <chatId> [--full]')
      const result = await api('/get', { chatId, include: flags.full ? 'full' : 'summary' })
      if (json || flags.full) return out(result)
      return printTurn({ chatId, status: result?.status ?? 'idle', ...result })
    }

    case 'tools': {
      const chatId = positional[1]
      if (!chatId) die('usage: handoff-bridge tools <chatId>')
      const result = await api('/tools', { chatId, limit: num(flags.limit, 50) })
      if (json) return out(result)
      const list = asList(result, ['toolCalls', 'tools', 'calls', 'items'])
      if (!list) return out(result)
      if (!list.length) return void process.stdout.write('(no tool calls)\n')
      for (const t of list) {
        // Field names come from BridgeToolCall in src/shared/bridge-protocol.ts.
        const name = t?.toolName ?? t?.name ?? t?.tool ?? '?'
        const detail = t?.input ?? t?.summary ?? t?.args ?? ''
        const status = t?.status ? ` [${t.status}]` : ''
        const took = typeof t?.durationMs === 'number' ? ` ${Math.round(t.durationMs)}ms` : ''
        const agent = t?.agentId && t.agentId !== 'main' ? ` (${t.agentId})` : ''
        const rendered = typeof detail === 'string' ? detail : JSON.stringify(detail)
        process.stdout.write(`- ${name}${agent}${status}${took} ${rendered.slice(0, 160)}\n`)
      }
      return
    }

    case 'list': {
      const result = await api('/list', { limit: num(flags.limit, 20) })
      if (json) return out(result)
      const chats = asList(result, ['chats', 'items'])
      if (!chats) return out(result)
      if (!chats.length) return void process.stdout.write('(no chats)\n')
      for (const c of chats) {
        const id = c?.chatId ?? c?.id ?? '?'
        const title = c?.title ?? '(untitled)'
        const mark = c?.running ? '* ' : '  '
        // origin is set on chats an external agent opened (ChatOrigin).
        const via = c?.origin?.client ? `  via ${c.origin.client}` : ''
        process.stdout.write(`${mark}${id}  ${title}${via}\n`)
        if (c?.preview) process.stdout.write(`     ${String(c.preview).slice(0, 72)}\n`)
      }
      return
    }

    case 'cancel': {
      const chatId = positional[1]
      if (!chatId) die('usage: handoff-bridge cancel <chatId>')
      const result = await api('/cancel', { chatId })
      return json ? out(result) : void process.stdout.write(`cancelled ${chatId}\n`)
    }

    case 'ls': {
      const root = typeof flags.root === 'string' ? flags.root : undefined
      const result = await api('/fs/list', { root })
      if (json) return out(result)
      const files = asList(result, ['files', 'entries', 'items'])
      if (!files) return out(result)
      if (!files.length) return void process.stdout.write('(no files)\n')
      for (const f of files) {
        const size = typeof f?.size === 'number' ? `${f.size}`.padStart(9) : '        ?'
        process.stdout.write(`${size}  ${f?.mediaType ?? ''}  ${f?.path ?? '?'}\n`)
      }
      return
    }

    case 'push': {
      const local = positional[1]
      if (!local) die('usage: handoff-bridge push <localFile> [--as /workspace/dir/name]')
      const entry = await pushFile(api, local, typeof flags.as === 'string' ? flags.as : undefined)
      return json ? out(entry) : void process.stdout.write(`${entry.localPath} -> ${entry.path}\n`)
    }

    case 'pull': {
      const path = positional[1]
      if (!path) die('usage: handoff-bridge pull <vfsPath> [--out <localPath>] [--force]')
      const result = await pullFile(api, path, typeof flags.out === 'string' ? flags.out : undefined, {
        overwrite: !!flags.force,
      })
      return json ? out(result) : void process.stdout.write(`${result.path} -> ${result.localPath} (${result.bytes} bytes)\n`)
    }

    case 'cat': {
      const path = positional[1]
      if (!path) die('usage: handoff-bridge cat <vfsPath>')
      const result = await api('/fs/read', { path: normalizeVfsPath(path), encoding: 'text' })
      if (json) return out(result)
      process.stdout.write(`${result?.text ?? ''}\n`)
      if (result?.truncated) process.stderr.write('[truncated]\n')
      return
    }

    case 'rm': {
      const path = positional[1]
      if (!path) die('usage: handoff-bridge rm <vfsPath>')
      const result = await api('/fs/delete', { path: normalizeVfsPath(path) })
      return json ? out(result) : void process.stdout.write(`deleted ${result?.path ?? path}\n`)
    }

    case 'stop': {
      const info = await health(port)
      if (!info) {
        process.stdout.write(`daemon: not running (port ${port})\n`)
        return
      }
      await call('/shutdown', {}, { port })
      process.stdout.write(`stopped daemon on port ${port}\n`)
      return
    }

    case 'token': {
      // Undocumented helper: print the shared secret path/value for debugging.
      const token = ensureToken()
      return json ? out({ token, path: tokenPath() }) : void process.stdout.write(`${token}\n${tokenPath()}\n`)
    }

    default:
      die(`unknown command: ${cmd}\n\n${USAGE}`)
  }
}

main().catch((err) => {
  if (err instanceof FileError) die(`handoff-bridge: ${err.message}`)
  if (err instanceof BridgeError) die(`handoff-bridge: ${err.code}: ${err.message}`)
  die(`handoff-bridge: ${err?.stack || err}`)
})
