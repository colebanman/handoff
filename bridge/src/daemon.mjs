// handoff-bridge daemon: the hub every other piece talks to.
//
//   Chrome extension  --WebSocket client-->  /ext        (the only thing that can run work)
//   MCP / CLI / curl  --HTTP-------------->  /ask, /get, ...
//
// The daemon is a dumb relay + waiter. It never parses chat content: whatever
// JSON the extension returns is passed through verbatim.

import http from 'node:http'
import { EventEmitter } from 'node:events'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createWsServer } from './ws-server.mjs'
import {
  VERSION,
  defaultPort,
  ensureToken,
  writeDaemonInfo,
  clearDaemonInfo,
  stateDir,
} from './paths.mjs'

export const PANEL_CLOSED_MESSAGE =
  "Handoff's side panel is closed. Ask the user to open the Handoff side panel in Chrome, then retry."

const DEFAULT_REQ_TIMEOUT_MS = 30_000 // per spec: a req without a res dies at 30s
const DEFAULT_OFFLINE_WAIT_MS = 10_000 // the extension SW reconnects on a 30s alarm
const RUNNING_GRACE_MS = 3_000 // how long we allow a turn to take to start
const DEFAULT_WAIT_SEC = 90
const MAX_WAIT_SEC = 600
// File pushes travel as base64 in the JSON body, so the ceiling is the file
// limit inflated by 4/3 plus room for the envelope.
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_BODY_BYTES = 32 * 1024 * 1024
const APP_PING_MS = 25_000

const EXT_CODE_STATUS = {
  panel_closed: 409,
  bad_request: 400,
  not_found: 404,
  internal: 500,
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code)
    this.status = status
    this.code = code
  }
}

const offlineError = () =>
  new HttpError(
    503,
    'extension_offline',
    'The Handoff Chrome extension is not connected to the bridge. Make sure Chrome is running with the extension installed and enabled.',
  )

function log(...args) {
  process.stderr.write(`[handoff-bridge] ${args.join(' ')}\n`)
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function clampWaitSec(value, fallback = DEFAULT_WAIT_SEC) {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(Math.floor(n), MAX_WAIT_SEC)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(400, 'bad_request', 'Request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new HttpError(400, 'bad_request', 'Body must be JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Start the bridge daemon.
 *
 * @param {object} [options]
 * @param {number} [options.port]            0 picks an ephemeral port (tests).
 * @param {string} [options.home]            overrides HANDOFF_BRIDGE_HOME / ~/.handoff-bridge
 * @param {number} [options.offlineWaitMs]   how long a write op waits for the extension
 * @param {number} [options.reqTimeoutMs]    per-request extension timeout
 * @param {boolean} [options.writeInfo]      write daemon.json (default true)
 * @param {() => void} [options.onShutdown]  called after POST /shutdown responds
 * @param {boolean} [options.quiet]
 */
export async function startDaemon(options = {}) {
  const {
    home,
    offlineWaitMs = DEFAULT_OFFLINE_WAIT_MS,
    reqTimeoutMs = DEFAULT_REQ_TIMEOUT_MS,
    writeInfo = true,
    onShutdown,
    quiet = false,
  } = options
  const wantedPort = options.port === undefined ? defaultPort() : options.port
  const token = ensureToken(home)
  const startedAt = Date.now()
  const say = quiet ? () => {} : log

  // ---- state ---------------------------------------------------------------
  /** @type {import('node:events').EventEmitter} */
  const events = new EventEmitter()
  events.setMaxListeners(0)
  const pending = new Map() // req id -> { resolve, reject, timer }
  const runningChats = new Set()
  const seenChats = new Set()
  let extConn = null
  let extInfo = null
  let panelOpen = false

  // ---- extension plumbing --------------------------------------------------
  function rejectAllPending(err) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      pending.delete(id)
      entry.reject(err())
    }
  }

  function handleExtMessage(conn, raw) {
    if (conn !== extConn) return
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return // tolerate junk
    }
    if (!msg || typeof msg !== 'object') return
    switch (msg.t) {
      case 'hello':
        extInfo = { extensionId: msg.extensionId, version: msg.version }
        panelOpen = !!msg.panelOpen
        say(`extension hello id=${msg.extensionId ?? '?'} v=${msg.version ?? '?'} panelOpen=${panelOpen}`)
        events.emit('hello', extInfo)
        return
      case 'res': {
        const entry = pending.get(msg.id)
        if (!entry) return // late/duplicate response
        clearTimeout(entry.timer)
        pending.delete(msg.id)
        entry.resolve(msg)
        return
      }
      case 'ev': {
        if (msg.ev === 'panel') {
          panelOpen = !!msg.open
          events.emit('panel', panelOpen)
        } else if (msg.ev === 'chat' && typeof msg.chatId === 'string') {
          seenChats.add(msg.chatId)
          if (msg.running) runningChats.add(msg.chatId)
          else runningChats.delete(msg.chatId)
          events.emit('chat', msg.chatId, msg)
        }
        return // unknown ev: ignore
      }
      case 'dreq':
        // Older extensions may still send reverse requests after an update.
        // Reject them without dispatching any local operation.
        conn.send(JSON.stringify({ t: 'dres', id: msg.id, ok: false, code: 'bad_request', error: 'Extension-initiated operations are not supported.' }))
        return
      case 'ping':
        conn.send(JSON.stringify({ t: 'pong' }))
        return
      case 'pong':
        return
      default:
        return // unknown t: ignore, never crash
    }
  }

  function waitForExtension(ms) {
    if (extConn) return Promise.resolve(extConn)
    if (!(ms > 0)) return Promise.reject(offlineError())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        events.off('ext-online', onOnline)
        reject(offlineError())
      }, ms)
      const onOnline = () => {
        clearTimeout(timer)
        events.off('ext-online', onOnline)
        resolve(extConn)
      }
      events.once('ext-online', onOnline)
    })
  }

  /** Send one `req` frame and resolve with the matching `res` message. */
  async function callExt(payload, { waitForExtensionMs = 0 } = {}) {
    const conn = extConn || (await waitForExtension(waitForExtensionMs))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new HttpError(504, 'extension_timeout', `The extension did not answer "${payload.op}" within ${Math.round(reqTimeoutMs / 1000)}s`))
      }, reqTimeoutMs)
      pending.set(id, { resolve, reject, timer })
      const ok = conn.send(JSON.stringify({ t: 'req', id, ...payload }))
      if (!ok) {
        clearTimeout(timer)
        pending.delete(id)
        reject(offlineError())
      }
    })
  }

  /** callExt + throw on `ok:false`, returning the opaque result. */
  async function callExtOk(payload, opts) {
    const res = await callExt(payload, opts)
    if (res && res.ok === false) {
      const code = typeof res.code === 'string' ? res.code : 'internal'
      const status = EXT_CODE_STATUS[code] ?? 500
      const message = code === 'panel_closed' ? PANEL_CLOSED_MESSAGE : res.error || code
      throw new HttpError(status, code, message)
    }
    return res && 'result' in res ? res.result : undefined
  }

  // ---- chat waiting --------------------------------------------------------
  function waitChatEvent(chatId, predicate, ms) {
    if (!(ms > 0)) return Promise.resolve(false)
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer)
        events.off('chat', onChat)
        events.off('ext-offline', onOffline)
        resolve(value)
      }
      const timer = setTimeout(() => done(false), ms)
      const onChat = (id, ev) => {
        if (id === chatId && predicate(ev)) done(true)
      }
      const onOffline = () => done(false)
      events.on('chat', onChat)
      events.on('ext-offline', onOffline)
    })
  }

  /**
   * Resolve when the chat's turn finishes.
   * The turn may not have started when `ask` returns, so first give it a grace
   * window to go running:true; if it never does and it is not already running,
   * treat the chat as already idle.
   */
  async function waitForIdle(chatId, deadline) {
    const remaining = () => deadline - Date.now()
    if (!runningChats.has(chatId)) {
      const started = await waitChatEvent(chatId, (ev) => ev.running === true, Math.min(RUNNING_GRACE_MS, Math.max(remaining(), 0)))
      if (!started && !runningChats.has(chatId)) {
        return { timedOut: false, offline: !extConn }
      }
    }
    while (remaining() > 0) {
      if (!extConn) return { timedOut: true, offline: true }
      if (!runningChats.has(chatId) && seenChats.has(chatId)) return { timedOut: false }
      const idle = await waitChatEvent(chatId, (ev) => ev.running === false, remaining())
      if (idle) return { timedOut: false }
    }
    return { timedOut: !runningChats.has(chatId) ? false : true, offline: !extConn }
  }

  /**
   * Shared tail of /ask, /follow and /wait: optionally wait for the turn, then
   * re-issue a summary `get` so the caller sees the freshest state.
   * @returns {Promise<object>} `{ ...summary, chatId, status }`
   */
  async function settleTurn(chatId, waitSec, seed = {}) {
    if (!(waitSec > 0)) return { ...seed, chatId, status: 'running' }
    const outcome = await waitForIdle(chatId, Date.now() + waitSec * 1000)
    let status = outcome.offline ? 'extension_offline' : outcome.timedOut ? 'running' : 'completed'
    let summary = seed
    try {
      const fresh = await callExtOk({ op: 'get', chatId, include: 'summary' })
      if (fresh && typeof fresh === 'object') summary = { ...seed, ...fresh }
    } catch (err) {
      if (err instanceof HttpError && err.code === 'panel_closed') status = 'panel_closed'
      // Otherwise keep whatever the accept call gave us; the wait result stands.
    }
    return { ...summary, chatId, status }
  }

  function requireString(body, field) {
    const v = body[field]
    if (typeof v !== 'string' || !v.trim()) {
      throw new HttpError(400, 'bad_request', `"${field}" is required`)
    }
    return v
  }

  // ---- HTTP ----------------------------------------------------------------
  function authorize(req) {
    // A real local client never sends Origin; a web page always does. This is
    // the check that stops a malicious page from driving the browser agent.
    if (req.headers.origin) {
      throw new HttpError(403, 'forbidden_origin', 'Origin header is not allowed on the handoff-bridge API')
    }
    const header = req.headers.authorization || ''
    const m = /^Bearer[ \t]+(.+)$/i.exec(header)
    if (!m || !safeEqual(m[1].trim(), token)) {
      throw new HttpError(401, 'unauthorized', 'Missing or invalid bearer token')
    }
  }

  function healthPayload() {
    return {
      ok: true,
      version: VERSION,
      port: actualPort,
      extensionConnected: !!extConn,
      panelOpen,
      uptimeMs: Date.now() - startedAt,
    }
  }

  const routes = {
    '/status': async () => {
      const base = {
        ...healthPayload(),
        extension: extInfo,
        runningChats: [...runningChats],
        stateDir: stateDir(home),
      }
      if (!extConn) return base
      try {
        const result = await callExtOk({ op: 'status' })
        return { ...(result && typeof result === 'object' ? result : {}), ...base }
      } catch (err) {
        if (err instanceof HttpError && err.code === 'panel_closed') {
          return { ...base, panelOpen: false, note: PANEL_CLOSED_MESSAGE }
        }
        throw err
      }
    },
    '/list': async (body) => {
      const result = await callExtOk({ op: 'list', limit: body.limit ?? 30 })
      return Array.isArray(result) ? { chats: result } : result ?? { chats: [] }
    },
    '/get': async (body) => {
      const chatId = requireString(body, 'chatId')
      const include = body.include === 'full' ? 'full' : 'summary'
      return await callExtOk({ op: 'get', chatId, include })
    },
    '/tools': async (body) => {
      const chatId = requireString(body, 'chatId')
      return await callExtOk({ op: 'tools', chatId, limit: body.limit ?? 50 })
    },
    '/ask': async (body) => {
      const prompt = requireString(body, 'prompt')
      const waitSec = clampWaitSec(body.waitSec)
      const accepted = await callExtOk(
        {
          op: 'ask',
          prompt,
          client: body.client || 'local-agent',
          label: body.label,
          cwd: body.cwd,
        },
        { waitForExtensionMs: offlineWaitMs },
      )
      const chatId = accepted && accepted.chatId
      if (typeof chatId !== 'string' || !chatId) {
        throw new HttpError(500, 'internal', 'The extension accepted the ask but returned no chatId')
      }
      return await settleTurn(chatId, waitSec, accepted)
    },
    '/follow': async (body) => {
      const chatId = requireString(body, 'chatId')
      const text = requireString(body, 'text')
      const waitSec = clampWaitSec(body.waitSec)
      const accepted = await callExtOk({ op: 'follow', chatId, text }, { waitForExtensionMs: offlineWaitMs })
      return await settleTurn(chatId, waitSec, accepted && typeof accepted === 'object' ? accepted : {})
    },
    '/wait': async (body) => {
      const chatId = requireString(body, 'chatId')
      const waitSec = clampWaitSec(body.waitSec, 120)
      return await settleTurn(chatId, Math.max(waitSec, 1), {})
    },
    // ---- virtual filesystem -------------------------------------------------
    // Handoff's files live in the extension's IndexedDB, not on disk. These four
    // endpoints are the import/export path: a local agent pushes a document in,
    // asks Handoff to work on it, and pulls the result back out by path.
    '/fs/list': async (body) => {
      const root = body.root === 'skills' || body.root === 'workspace' ? body.root : undefined
      const result = await callExtOk({ op: 'fs_list', root }, { waitForExtensionMs: offlineWaitMs })
      return Array.isArray(result) ? { files: result } : result ?? { files: [] }
    },
    '/fs/read': async (body) => {
      const path = requireString(body, 'path')
      const encoding = body.encoding === 'base64' ? 'base64' : 'text'
      return await callExtOk(
        {
          op: 'fs_read',
          path,
          encoding,
          offset: body.offset,
          maxChars: body.maxChars,
        },
        { waitForExtensionMs: offlineWaitMs },
      )
    },
    '/fs/write': async (body) => {
      const path = requireString(body, 'path')
      const hasText = typeof body.text === 'string'
      const hasBase64 = typeof body.base64 === 'string'
      if (!hasText && !hasBase64) {
        throw new HttpError(400, 'bad_request', 'Provide either "text" or "base64"')
      }
      if (hasBase64) {
        // 4 base64 chars carry 3 bytes; close enough to catch an oversized push
        // before it occupies the extension's socket.
        const bytes = Math.floor((body.base64.length * 3) / 4)
        if (bytes > MAX_FILE_BYTES) {
          throw new HttpError(400, 'bad_request', `File is ~${bytes} bytes, above the ${MAX_FILE_BYTES}-byte transfer limit`)
        }
      }
      return await callExtOk(
        {
          op: 'fs_write',
          path,
          text: hasBase64 ? undefined : body.text,
          base64: hasBase64 ? body.base64 : undefined,
          mediaType: body.mediaType,
        },
        { waitForExtensionMs: offlineWaitMs },
      )
    },
    '/fs/delete': async (body) => {
      const path = requireString(body, 'path')
      await callExtOk({ op: 'fs_delete', path }, { waitForExtensionMs: offlineWaitMs })
      return { ok: true, path }
    },
    '/cancel': async (body) => {
      const chatId = requireString(body, 'chatId')
      await callExtOk({ op: 'cancel', chatId }, { waitForExtensionMs: offlineWaitMs })
      return { ok: true, chatId }
    },

  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }
    try {
      if (url.pathname === '/health' && req.method === 'GET') return send(200, healthPayload())
      if (url.pathname === '/health') return send(405, { error: 'bad_request', message: 'Use GET /health' })

      authorize(req)

      if (url.pathname === '/shutdown') {
        send(200, { ok: true })
        setTimeout(() => {
          say('shutting down on request')
          close().then(() => onShutdown?.())
        }, 10)
        return
      }

      const handler = routes[url.pathname]
      if (!handler) return send(404, { error: 'not_found', message: `No such endpoint: ${url.pathname}` })
      if (req.method !== 'POST') {
        return send(405, { error: 'bad_request', message: `${url.pathname} requires POST` })
      }
      const body = await readBody(req)
      const payload = await handler(body)
      send(200, payload ?? {})
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.code, message: err.message })
      say('internal error:', err?.stack || String(err))
      send(500, { error: 'internal', message: String(err?.message || err) })
    }
  })

  const ws = createWsServer(httpServer, {
    path: '/ext',
    // The extension has no filesystem access, so it cannot present the token.
    // Origin is the gate instead: absent (non-browser) or chrome-extension://.
    verifyOrigin: (origin) => (!origin || origin.startsWith('chrome-extension://')) &&
      (!extConn || extConn.origin === (origin ?? null)),
  })

  ws.on('connection', (conn) => {
    // Reconnects from the same installation replace its old socket. A different
    // live extension origin is rejected at upgrade so dev/prod cannot bounce
    // each other offline or receive one another's requests.
    if (extConn && extConn !== conn) {
      // Keep ownership until close runs the normal pending-request cleanup.
      extConn.close(1000, 'replaced by a newer extension connection')
    }
    extConn = conn
    say('extension connected')
    events.emit('ext-online')

    conn.on('message', (raw) => handleExtMessage(conn, raw))
    conn.on('error', (err) => say('extension socket error:', String(err?.message || err)))
    conn.on('close', () => {
      if (extConn !== conn) return // already replaced
      extConn = null
      extInfo = null
      panelOpen = false
      runningChats.clear()
      say('extension disconnected')
      rejectAllPending(offlineError)
      events.emit('ext-offline')
    })
  })

  const appPing = setInterval(() => {
    extConn?.send(JSON.stringify({ t: 'ping' }))
  }, APP_PING_MS)
  appPing.unref?.()

  let closed = false
  async function close() {
    if (closed) return
    closed = true
    clearInterval(appPing)
    rejectAllPending(offlineError)
    ws.closeAll(1001, 'daemon shutting down')
    if (writeInfo) clearDaemonInfo(home)
    await new Promise((resolve) => {
      httpServer.close(() => resolve())
      // keep-alive HTTP sockets would otherwise hold the server open
      httpServer.closeIdleConnections?.()
      const hard = setTimeout(() => {
        httpServer.closeAllConnections?.()
        resolve()
      }, 250)
      hard.unref?.()
    })
  }

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(wantedPort, '127.0.0.1', () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  })
  const actualPort = httpServer.address().port

  if (writeInfo) {
    writeDaemonInfo({ port: actualPort, pid: process.pid, startedAt, version: VERSION }, home)
  }
  say(`listening on http://127.0.0.1:${actualPort} (ws ${'/ext'}) state=${stateDir(home)}`)

  return {
    port: actualPort,
    token,
    httpServer,
    events,
    close,
    get extensionConnected() {
      return !!extConn
    },
  }
}
