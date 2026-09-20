#!/usr/bin/env node
// stdio MCP server (JSON-RPC 2.0, protocol 2025-06-18), hand-rolled.
//
// STDOUT IS SACRED: only newline-delimited JSON-RPC messages go there.
// Everything else must go to stderr.

import { pathToFileURL } from 'node:url'
import { VERSION, defaultPort } from './paths.mjs'
import { call, ensureDaemon, BridgeError } from './client.mjs'
import { FileError, pullFile, pushFile, normalizeVfsPath } from './files.mjs'

const PROTOCOL_VERSION = '2025-06-18'

export const NATURAL_INVOCATION_GUIDANCE =
  'Treat natural delegation language as a direct request to use Handoff. When the user says "ask Handoff", "have Handoff", ' +
  '"tell Handoff", "send this to Handoff", "check with Handoff", or similar, call handoff_ask without requiring an MCP tool name ' +
  'or asking them to restate the request. Preserve their intent; put relevant URLs, page context, quoted text, and the ' +
  'desired output in the prompt, and provide local files through attach. For example, "Ask Handoff to look at this Google Doc and send it to you" means: ' +
  'call handoff_ask with the Google Doc URL or other available page context, wait for Handoff, then use the returned answer.'

const HANDOFF_BLURB =
  'Handoff is an AI agent that lives inside the user\'s Chrome browser and can actually drive it: ' +
  'open tabs, read pages, click, type, and use web apps with the user\'s own logged-in sessions. ' +
  'Use it for anything you cannot reach from the local machine: looking things up about the user, ' +
  'reading their email/calendar/docs/dashboards, operating a web app on their behalf, or fetching ' +
  'pages behind a login. Handoff runs asynchronously; calls return a chat_id you can poll or follow up on. ' +
  "Requires the Handoff side panel to be open in Chrome — if a call returns panel_closed, ask the user to open it and retry."

export const MCP_INSTRUCTIONS =
  `${NATURAL_INVOCATION_GUIDANCE} ${HANDOFF_BLURB} ` +
  'Use handoff_follow only to continue a chat_id returned by handoff_ask. A web link such as a Google Doc belongs in the ' +
  'prompt; attach is only for files on the coding agent\'s local disk. The handoff_ask result is Handoff\'s handoff back to ' +
  'you. If Handoff instead saves an artifact under /workspace and the user wants a local copy, retrieve it with handoff_pull_file. '

const FS_BLURB =
  "Handoff has its own virtual filesystem inside Chrome (roots /workspace and /skills) — it is not your disk, and Handoff " +
  'cannot see your files unless you put them there. The round trip is: handoff_push_file a local document in, ask Handoff to ' +
  'work on it by path, then handoff_pull_file whatever it wrote back to your machine.'

export const TOOLS = [
  {
    name: 'handoff_ask',
    description:
      `Natural-language entry point for delegating work to Handoff. ${NATURAL_INVOCATION_GUIDANCE} ` +
      `Start a new task in the user's Chrome browser and wait for Handoff's answer. ${HANDOFF_BLURB}`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'What Handoff should do or find out, written naturally. Include URLs or page context from the user\'s request. Handoff can inspect the user\'s open Chrome tabs, but cannot see local files unless they are supplied with attach.',
        },
        wait_seconds: { type: 'number', description: 'How long to wait for the turn to finish (default 90, max 600, 0 = return immediately with a chat_id).' },
        label: { type: 'string', description: 'Optional short label shown in the Handoff UI for this chat.' },
        attach: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Local file paths to hand Handoff along with the prompt. Each is copied into /workspace/inbox/<name> in Handoff\'s filesystem and listed at the end of the prompt, so Handoff can open it by path.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'handoff_follow',
    description:
      `Continue an existing Handoff chat after handoff_ask returned its chat_id; use handoff_ask for a new natural-language request. ` +
      `Send the follow-up and wait for the reply. ${HANDOFF_BLURB}`,
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat id returned by handoff_ask.' },
        message: { type: 'string', description: 'The follow-up message.' },
        wait_seconds: { type: 'number', description: 'Seconds to wait for the reply (default 90, max 600).' },
        attach: {
          type: 'array',
          items: { type: 'string' },
          description: "Local file paths to copy into Handoff's filesystem before sending the message.",
        },
      },
      required: ['chat_id', 'message'],
    },
  },
  {
    name: 'handoff_wait',
    description: 'Wait for an in-progress Handoff turn to finish and return the fresh summary. Use after handoff_ask with wait_seconds:0, or when a previous wait timed out while status was still "running".',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat id to wait on.' },
        wait_seconds: { type: 'number', description: 'Seconds to wait (default 120, max 600).' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'handoff_get',
    description: 'Read a Handoff chat: the summary (last assistant text + status) or the full transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        include: { type: 'string', enum: ['summary', 'full'], description: 'summary (default) or full transcript.' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'handoff_tool_calls',
    description: 'List the browser tool calls Handoff made in a chat (navigations, clicks, reads) — useful for auditing what actually happened in the browser.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        limit: { type: 'number', description: 'Max tool calls to return (default 50).' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'handoff_list_chats',
    description: 'List recent Handoff chats with their ids, titles and running state.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max chats to return (default 20).' } },
    },
  },
  {
    name: 'handoff_cancel',
    description: 'Stop a Handoff turn that is currently running.',
    inputSchema: {
      type: 'object',
      properties: { chat_id: { type: 'string' } },
      required: ['chat_id'],
    },
  },
  {
    name: 'handoff_push_file',
    description:
      `Copy a file from your local disk into Handoff's filesystem so Handoff can read it. ${FS_BLURB} Returns the path Handoff will see it at.`,
    inputSchema: {
      type: 'object',
      properties: {
        local_path: { type: 'string', description: 'Path on your machine, absolute or relative to your cwd.' },
        dest: {
          type: 'string',
          description:
            "Destination in Handoff's filesystem. Default /workspace/inbox/<filename>. A trailing slash means a directory; a bare path is rooted at /workspace.",
        },
      },
      required: ['local_path'],
    },
  },
  {
    name: 'handoff_pull_file',
    description:
      `Copy a file out of Handoff's filesystem onto your local disk — how you collect a document Handoff produced or edited. ${FS_BLURB}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "Path in Handoff's filesystem, e.g. /workspace/resume-revised.docx." },
        local_path: {
          type: 'string',
          description: 'Where to write it locally (a directory is allowed). Default: the filename in your cwd.',
        },
        overwrite: { type: 'boolean', description: 'Replace an existing local file (default false).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'handoff_fs_list',
    description: `List the files in Handoff's filesystem with their sizes and types. ${FS_BLURB}`,
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string', enum: ['workspace', 'skills'], description: 'Restrict to one root.' } },
    },
  },
  {
    name: 'handoff_fs_read',
    description:
      "Read a file in Handoff's filesystem as text. PDFs and .docx are extracted to text automatically. Use handoff_pull_file instead when you want the actual bytes on disk.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number', description: 'Character offset to start at (default 0).' },
        max_chars: { type: 'number', description: 'Characters to return (default 100000).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'handoff_fs_write',
    description:
      "Write text straight into Handoff's filesystem — notes, instructions, a spec for Handoff to follow. Use handoff_push_file for files that already exist on disk.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'e.g. /workspace/notes/brief.md (a bare path is rooted at /workspace).' },
        text: { type: 'string' },
        media_type: { type: 'string', description: 'Optional MIME type; inferred from the extension otherwise.' },
      },
      required: ['path', 'text'],
    },
  },
  {
    name: 'handoff_fs_delete',
    description: "Delete a file from Handoff's filesystem.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'handoff_status',
    description:
      'Check whether the Handoff extension is connected to the bridge and whether its side panel is open. Call this first if other Handoff tools fail.',
    inputSchema: { type: 'object', properties: {} },
  },

]

function logErr(...args) {
  process.stderr.write(`[handoff-bridge] ${args.join(' ')}\n`)
}

export async function runMcp({ port = defaultPort() } = {}) {
  const opts = { port }
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })

  const text = (value) => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  })
  const errText = (message) => ({ content: [{ type: 'text', text: message }], isError: true })

  async function api(path, body) {
    await ensureDaemon({ port, log: logErr })
    return await call(path, body, opts)
  }

  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

  /**
   * Copy the caller's local files into Handoff's filesystem and return the note
   * that tells Handoff where they landed. Handoff has no access to the caller's disk,
   * so an attachment is really "push, then mention the path".
   */
  async function stageAttachments(attach) {
    const list = Array.isArray(attach) ? attach.filter((v) => typeof v === 'string' && v.trim()) : []
    if (list.length === 0) return ''
    const entries = []
    for (const localPath of list) {
      entries.push(await pushFile(api, localPath, undefined))
    }
    const lines = entries.map((e) => `- ${e.path}${e.size ? ` (${e.mediaType || 'file'}, ${e.size} bytes)` : ''}`)
    return (
      `\n\nFiles placed in your filesystem for this task:\n${lines.join('\n')}\n` +
      'Read them from those paths. If you produce a file for me, write it under /workspace and tell me the exact path.'
    )
  }

  // Reported by the MCP client in `initialize`. It becomes the chat's origin
  // badge in the side panel, so "claude-code" beats a generic "mcp".
  let clientName = 'mcp'
  const str = (v) => (typeof v === 'string' ? v : '')

  async function callTool(name, args = {}) {
    switch (name) {
      case 'handoff_ask': {
        if (!str(args.prompt)) return errText('handoff_ask requires a "prompt".')
        const note = await stageAttachments(args.attach)
        return text(
          await api('/ask', {
            prompt: `${args.prompt}${note}`,
            label: args.label,
            client: clientName,
            cwd: process.cwd(),
            waitSec: num(args.wait_seconds, 90),
          }),
        )
      }
      case 'handoff_follow': {
        if (!str(args.chat_id) || !str(args.message)) return errText('handoff_follow requires "chat_id" and "message".')
        const note = await stageAttachments(args.attach)
        return text(
          await api('/follow', {
            chatId: args.chat_id,
            text: `${args.message}${note}`,
            waitSec: num(args.wait_seconds, 90),
          }),
        )
      }
      case 'handoff_wait':
        if (!str(args.chat_id)) return errText('handoff_wait requires a "chat_id".')
        return text(await api('/wait', { chatId: args.chat_id, waitSec: num(args.wait_seconds, 120) }))
      case 'handoff_get':
        if (!str(args.chat_id)) return errText('handoff_get requires a "chat_id".')
        return text(await api('/get', { chatId: args.chat_id, include: args.include === 'full' ? 'full' : 'summary' }))
      case 'handoff_tool_calls':
        if (!str(args.chat_id)) return errText('handoff_tool_calls requires a "chat_id".')
        return text(await api('/tools', { chatId: args.chat_id, limit: num(args.limit, 50) }))
      case 'handoff_list_chats':
        return text(await api('/list', { limit: num(args.limit, 20) }))
      case 'handoff_cancel':
        if (!str(args.chat_id)) return errText('handoff_cancel requires a "chat_id".')
        return text(await api('/cancel', { chatId: args.chat_id }))
      case 'handoff_push_file': {
        if (!str(args.local_path)) return errText('handoff_push_file requires a "local_path".')
        const entry = await pushFile(api, args.local_path, args.dest)
        return text({
          ...entry,
          note: `Handoff can now read this at ${entry.path}. Mention that path in your prompt.`,
        })
      }
      case 'handoff_pull_file': {
        if (!str(args.path)) return errText('handoff_pull_file requires a "path".')
        const result = await pullFile(api, args.path, args.local_path, { overwrite: args.overwrite === true })
        return text(result)
      }
      case 'handoff_fs_list':
        return text(await api('/fs/list', { root: args.root }))
      case 'handoff_fs_read':
        if (!str(args.path)) return errText('handoff_fs_read requires a "path".')
        return text(
          await api('/fs/read', {
            path: normalizeVfsPath(args.path),
            encoding: 'text',
            offset: num(args.offset, undefined),
            maxChars: num(args.max_chars, undefined),
          }),
        )
      case 'handoff_fs_write':
        if (!str(args.path) || typeof args.text !== 'string') return errText('handoff_fs_write requires "path" and "text".')
        return text(await api('/fs/write', { path: normalizeVfsPath(args.path), text: args.text, mediaType: args.media_type }))
      case 'handoff_fs_delete':
        if (!str(args.path)) return errText('handoff_fs_delete requires a "path".')
        return text(await api('/fs/delete', { path: normalizeVfsPath(args.path) }))
      case 'handoff_status':
        return text(await api('/status', {}))
      default:
        return errText(`Unknown tool: ${name}`)
    }
  }

  async function handle(msg) {
    const { id, method, params } = msg
    const isNotification = id === undefined || id === null
    switch (method) {
      case 'initialize': {
        const declared = params?.clientInfo?.name
        if (typeof declared === 'string' && declared.trim()) clientName = declared.trim().slice(0, 40)
        // Warm the daemon up so the first tool call is fast. Never block init.
        ensureDaemon({ port, log: logErr }).catch((err) => logErr('daemon warmup failed:', String(err?.message || err)))
        return reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'handoff-bridge', version: VERSION },
          instructions: MCP_INSTRUCTIONS,
        })
      }
      case 'notifications/initialized':
      case 'initialized':
        return // notification: no response
      case 'ping':
        return reply(id, {})
      case 'tools/list':
        return reply(id, { tools: TOOLS })
      case 'tools/call': {
        const name = params?.name
        try {
          return reply(id, await callTool(name, params?.arguments || {}))
        } catch (err) {
          if (err instanceof FileError) {
            return reply(id, { content: [{ type: 'text', text: err.message }], isError: true })
          }
          const code = err instanceof BridgeError ? err.code : 'internal'
          return reply(id, { content: [{ type: 'text', text: `${code}: ${err?.message || err}` }], isError: true })
        }
      }
      default:
        if (isNotification) return
        return fail(id, -32601, `Method not found: ${method}`)
    }
  }

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        continue
      }
      Promise.resolve(handle(msg)).catch((err) => {
        logErr('handler crashed:', String(err?.stack || err))
        if (msg && msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, String(err?.message || err))
      })
    }
  })
  process.stdin.on('end', () => process.exit(0))
  process.stdin.resume()
  logErr(`mcp server ready (protocol ${PROTOCOL_VERSION}, daemon port ${port})`)
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const i = process.argv.indexOf('--port')
  const port = i !== -1 ? Number(process.argv[i + 1]) : defaultPort()
  runMcp({ port })
}
