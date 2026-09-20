import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { startDaemon } from '../src/daemon.mjs'

const OFFLINE_WAIT_MS = 150 // production default is 10s; keep the suite fast

async function waitFor(predicate, ms = 2000, label = 'condition') {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('daemon', () => {
  let home
  let daemon
  let ext
  let base
  let token
  let chatSeq = 0
  const sent = []
  /** Fake extension-side virtual filesystem: path -> { base64, mediaType }. */
  const files = new Map()

  /** Fake Chrome extension: answers `req` frames, emits chat events. */
  function connectExtension() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ext`)
      const emit = (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj))
      ws.addEventListener('open', () => {
        emit({ t: 'hello', extensionId: 'fake-ext', version: '9.9.9', panelOpen: true })
        resolve(ws)
      })
      ws.addEventListener('error', reject)
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data)
        if (msg.t === 'ping') return emit({ t: 'pong' })
        if (msg.t !== 'req') return
        sent.push(msg)
        const res = (body) => emit({ t: 'res', id: msg.id, ...body })
        switch (msg.op) {
          case 'ask': {
            if (msg.prompt === 'HOLD') return
            if (msg.prompt === 'PANEL_CLOSED') {
              return res({ ok: false, error: 'panel is closed', code: 'panel_closed' })
            }
            const chatId = `chat-${++chatSeq}`
            if (msg.prompt === 'RUN') {
              const beat = (running, delay) =>
                setTimeout(() => emit({ t: 'ev', ev: 'chat', chatId, running, title: 'Fake turn', updatedAt: Date.now() }), delay)
              beat(true, 20)
              beat(false, 90)
            }
            return res({ ok: true, result: { chatId, title: 'Fake turn', accepted: true } })
          }
          case 'get':
            return res({ ok: true, result: { chatId: msg.chatId, title: 'Fake turn', status: 'idle', text: 'the fake answer' } })
          case 'status':
            return res({ ok: true, result: { panelOpen: true, model: 'fake-model' } })
          case 'list':
            return res({ ok: true, result: { chats: [{ chatId: 'chat-1', title: 'Fake turn', running: false }] } })
          case 'fs_write': {
            const base64 =
              typeof msg.base64 === 'string' ? msg.base64 : Buffer.from(msg.text ?? '', 'utf8').toString('base64')
            const size = Buffer.from(base64, 'base64').length
            files.set(msg.path, { base64, mediaType: msg.mediaType ?? 'application/octet-stream', size })
            return res({ ok: true, result: { path: msg.path, size, mediaType: msg.mediaType ?? 'application/octet-stream' } })
          }
          case 'fs_read': {
            const file = files.get(msg.path)
            if (!file) return res({ ok: false, error: `no file at ${msg.path}`, code: 'not_found' })
            if (msg.encoding === 'base64') {
              return res({ ok: true, result: { path: msg.path, base64: file.base64, mediaType: file.mediaType, size: file.size } })
            }
            return res({
              ok: true,
              result: {
                path: msg.path,
                text: Buffer.from(file.base64, 'base64').toString('utf8'),
                mediaType: file.mediaType,
                size: file.size,
              },
            })
          }
          case 'fs_list':
            return res({
              ok: true,
              result: { files: [...files].map(([path, f]) => ({ path, size: f.size, mediaType: f.mediaType })) },
            })
          case 'fs_delete':
            files.delete(msg.path)
            return res({ ok: true, result: { ok: true, path: msg.path } })
          default:
            return res({ ok: true, result: { ok: true } })
        }
      })
    })
  }

  const post = (pathname, body, headers = {}) =>
    fetch(base + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body ?? {}),
    })

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-bridge-test-'))
    process.env.HANDOFF_BRIDGE_HOME = home
    daemon = await startDaemon({ port: 0, home, offlineWaitMs: OFFLINE_WAIT_MS, quiet: true })
    base = `http://127.0.0.1:${daemon.port}`
    token = daemon.token
    ext = await connectExtension()
    await waitFor(() => daemon.extensionConnected, 2000, 'extension connection')
  })

  afterAll(async () => {
    try {
      ext?.close()
    } catch {
      /* already gone */
    }
    await daemon?.close()
    fs.rmSync(home, { recursive: true, force: true })
    delete process.env.HANDOFF_BRIDGE_HOME
  })

  it('writes a 0600 token and daemon.json into HANDOFF_BRIDGE_HOME', () => {
    const tokenStat = fs.statSync(path.join(home, 'token'))
    expect(tokenStat.mode & 0o777).toBe(0o600)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const info = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8'))
    expect(info.port).toBe(daemon.port)
    expect(info.pid).toBe(process.pid)
  })

  it('serves GET /health without auth', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, port: daemon.port, extensionConnected: true, panelOpen: true })
    expect(typeof body.uptimeMs).toBe('number')
  })

  it('rejects a missing token with 401 and an Origin header with 403', async () => {
    const noToken = await fetch(`${base}/list`, { method: 'POST', body: '{}' })
    expect(noToken.status).toBe(401)
    expect((await noToken.json()).error).toBe('unauthorized')

    const withOrigin = await post('/list', {}, { origin: 'https://evil.example' })
    expect(withOrigin.status).toBe(403)
    expect((await withOrigin.json()).error).toBe('forbidden_origin')

    const ok = await post('/list', {})
    expect(ok.status).toBe(200)
    expect((await ok.json()).chats).toHaveLength(1)
  })

  it('POST /ask with waitSec:0 returns immediately with a chatId', async () => {
    const res = await post('/ask', { prompt: 'no waiting', waitSec: 0 })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.chatId).toMatch(/^chat-/)
    expect(body.status).toBe('running')
    expect(body.accepted).toBe(true) // accept payload passed through
    // No wait means no follow-up `get`.
    expect(sent.filter((m) => m.op === 'get' && m.chatId === body.chatId)).toHaveLength(0)
  })

  it('POST /ask waits for running:true -> running:false, then re-fetches the summary', async () => {
    const res = await post('/ask', { prompt: 'RUN', waitSec: 5 })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('completed') // daemon status wins over the extension's "idle"
    expect(body.text).toBe('the fake answer')
    expect(body.chatId).toMatch(/^chat-/)
    expect(sent.some((m) => m.op === 'get' && m.chatId === body.chatId && m.include === 'summary')).toBe(true)
  })

  it('maps a panel_closed extension error to HTTP 409 with actionable text', async () => {
    const res = await post('/ask', { prompt: 'PANEL_CLOSED' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('panel_closed')
    expect(body.message).toMatch(/side panel is closed/i)
  })

  it('rejects a bad request body with 400', async () => {
    const res = await post('/ask', { waitSec: 0 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('bad_request')
  })

  it('round-trips a file through /fs/write and /fs/read', async () => {
    const base64 = Buffer.from('%PDF-1.7 pretend resume').toString('base64')
    const wrote = await post('/fs/write', { path: '/workspace/inbox/resume.pdf', base64 })
    expect(wrote.status).toBe(200)
    expect((await wrote.json()).path).toBe('/workspace/inbox/resume.pdf')

    const read = await post('/fs/read', { path: '/workspace/inbox/resume.pdf', encoding: 'base64' })
    expect(read.status).toBe(200)
    expect((await read.json()).base64).toBe(base64)

    const listed = await (await post('/fs/list', {})).json()
    expect(listed.files.map((f) => f.path)).toContain('/workspace/inbox/resume.pdf')
  })

  it('reads a text file back as text and deletes it', async () => {
    await post('/fs/write', { path: '/workspace/brief.md', text: '# Brief' })
    const read = await (await post('/fs/read', { path: '/workspace/brief.md' })).json()
    expect(read.text).toBe('# Brief')

    const removed = await post('/fs/delete', { path: '/workspace/brief.md' })
    expect(removed.status).toBe(200)
    const gone = await post('/fs/read', { path: '/workspace/brief.md' })
    expect(gone.status).toBe(404)
    expect((await gone.json()).error).toBe('not_found')
  })

  it('rejects an fs_write with no content and one above the transfer limit', async () => {
    const empty = await post('/fs/write', { path: '/workspace/x.txt' })
    expect(empty.status).toBe(400)
    expect((await empty.json()).message).toMatch(/text.*base64/i)

    // 21 MiB of base64 characters describes ~15.75 MB… so overshoot properly:
    // 28 MiB of base64 is ~21 MB of bytes, just over the 20 MB ceiling.
    const huge = 'A'.repeat(28 * 1024 * 1024)
    const res = await post('/fs/write', { path: '/workspace/huge.bin', base64: huge })
    expect(res.status).toBe(400)
    expect((await res.json()).message).toMatch(/transfer limit/i)
    // Nothing that big ever reached the extension.
    expect(sent.some((m) => m.op === 'fs_write' && m.path === '/workspace/huge.bin')).toBe(false)
  })

  it('does not expose room endpoints', async () => {
    for (const endpoint of ['ensure', 'list', 'read', 'send', 'join', 'leave', 'interrupt', 'wait']) {
      const response = await post(`/rooms/${endpoint}`, { roomId: 'old-chat' })
      expect(response.status).toBe(404)
    }
  })

  it('rejects extension-initiated agent and room operations', async () => {
    for (const op of ['code_agents', 'code_run', 'code_cancel', 'room_ensure', 'room_join', 'room_send', 'room_sync']) {
      const id = `removed-${op}`
      const reply = new Promise((resolve) => {
        const listener = (event) => {
          const message = JSON.parse(event.data)
          if (message.id !== id) return
          ext.removeEventListener('message', listener)
          resolve(message)
        }
        ext.addEventListener('message', listener)
      })
      ext.send(JSON.stringify({ t: 'dreq', id, op, agent: 'codex', prompt: 'test', cwd: home }))
      expect(await reply).toMatchObject({ t: 'dres', id, ok: false, code: 'bad_request' })
    }
  })

  it('settles in-flight requests when the same extension reconnects', async () => {
    const pending = post('/ask', { prompt: 'HOLD', waitSec: 0 })
    await waitFor(() => sent.some(message => message.prompt === 'HOLD'))
    const previous = ext
    ext = await connectExtension()
    const response = await pending
    expect(response.status).toBe(503)
    expect((await response.json()).error).toBe('extension_offline')
    await waitFor(() => previous.readyState === WebSocket.CLOSED)
    expect(daemon.extensionConnected).toBe(true)
    expect((await post('/list', {})).status).toBe(200)
  })

  it('returns 503 extension_offline once the extension disconnects', async () => {
    ext.close()
    ext = null
    await waitFor(() => !daemon.extensionConnected, 2000, 'extension disconnect')

    const started = Date.now()
    const res = await post('/ask', { prompt: 'anybody home?', waitSec: 0 })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('extension_offline')
    // It waited for a reconnect (bounded by the override) before giving up.
    expect(Date.now() - started).toBeGreaterThanOrEqual(OFFLINE_WAIT_MS - 30)

    const health = await (await fetch(`${base}/health`)).json()
    expect(health.extensionConnected).toBe(false)
    // /status degrades gracefully instead of erroring when nothing is connected.
    const status = await (await post('/status', {})).json()
    expect(status.extensionConnected).toBe(false)
  })
})

it('keeps a live extension origin when another installation connects', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-bridge-origins-'))
  const daemon = await startDaemon({ port: 0, home, quiet: true })
  const sockets = []
  const connect = (origin) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: daemon.port, path: '/ext', headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', Origin: origin,
      'Sec-WebSocket-Key': Buffer.alloc(16).toString('base64'), 'Sec-WebSocket-Version': '13',
    } }, response => { response.resume(); resolve({ status: response.statusCode }) })
    request.on('upgrade', (response, socket) => {
      sockets.push(socket)
      socket.resume()
      resolve({ status: response.statusCode, socket })
    })
    request.on('error', reject)
    request.end()
  })
  try {
    const production = await connect('chrome-extension://production')
    expect(production.status).toBe(101)
    expect(daemon.extensionConnected).toBe(true)
    const reconnected = await connect('chrome-extension://production')
    expect(reconnected.status).toBe(101)
    await waitFor(() => production.socket.destroyed)
    const development = await connect('chrome-extension://development')
    expect(development.status).toBe(403)
    expect(daemon.extensionConnected).toBe(true)
    expect(reconnected.socket.destroyed).toBe(false)

    reconnected.socket.destroy()
    await waitFor(() => !daemon.extensionConnected)
    expect((await connect('chrome-extension://development')).status).toBe(101)
  } finally {
    for (const socket of sockets) socket.destroy()
    await daemon.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
