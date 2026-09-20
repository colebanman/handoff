import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { createWsServer } from '../src/ws-server.mjs'

// ---------------------------------------------------------------- helpers ---

function once(target, event) {
  return new Promise((resolve) => {
    if (typeof target.addEventListener === 'function' && !target.once) {
      target.addEventListener(event, resolve, { once: true })
    } else {
      target.once(event, (...args) => resolve(args.length > 1 ? args : args[0]))
    }
  })
}

/** Raw client-side handshake so we can drive exact frames (and bad Origins). */
function rawHandshake(port, { path = '/ext', origin, key = randomBytes(16).toString('base64') } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      let req =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`
      if (origin) req += `Origin: ${origin}\r\n`
      socket.write(req + '\r\n')
    })
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const i = buf.indexOf('\r\n\r\n')
      if (i === -1) return
      socket.off('data', onData)
      resolve({ socket, head: buf.subarray(0, i).toString('utf8'), rest: buf.subarray(i + 4) })
    }
    socket.on('data', onData)
    socket.on('error', reject)
    socket.setTimeout(4000, () => reject(new Error('handshake timeout')))
  })
}

/** Client frames are always masked. */
function clientFrame(opcode, payload = Buffer.alloc(0), fin = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const mask = randomBytes(4)
  let header
  if (data.length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | data.length
  } else if (data.length < 0x10000) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  const masked = Buffer.from(data)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3]
  return Buffer.concat([header, mask, masked])
}

/** Read exactly one (unmasked) server frame off a raw socket. */
function readFrame(socket, seed = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let buf = seed
    const tryParse = () => {
      if (buf.length < 2) return
      const opcode = buf[0] & 0x0f
      let len = buf[1] & 0x7f
      let off = 2
      expect(buf[1] & 0x80).toBe(0) // server frames must never be masked
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = Number(buf.readBigUInt64BE(2))
        off = 10
      }
      if (buf.length < off + len) return
      socket.off('data', onData)
      clearTimeout(timer)
      resolve({ opcode, payload: buf.subarray(off, off + len), rest: buf.subarray(off + len) })
    }
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      tryParse()
    }
    const timer = setTimeout(() => {
      socket.off('data', onData)
      reject(new Error('timed out waiting for a frame'))
    }, 4000)
    socket.on('data', onData)
    tryParse()
  })
}

// ------------------------------------------------------------------ suite ---

describe('ws-server (RFC 6455)', () => {
  let httpServer
  let hub
  let port
  /** @type {Set<import('node:net').Socket>} */
  const rawSockets = new Set()

  beforeAll(async () => {
    httpServer = http.createServer((_req, res) => res.end('http'))
    hub = createWsServer(httpServer, {
      path: '/ext',
      verifyOrigin: (origin) => !origin || origin.startsWith('chrome-extension://'),
    })
    // Echo server.
    hub.on('connection', (conn) => {
      conn.on('message', (text) => conn.send(text))
    })
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r))
    port = httpServer.address().port
  })

  afterAll(async () => {
    for (const s of rawSockets) s.destroy()
    hub.closeAll()
    await new Promise((r) => {
      httpServer.close(r)
      httpServer.closeAllConnections?.()
    })
  })

  const url = () => `ws://127.0.0.1:${port}/ext`

  it('round-trips a small text message', async () => {
    const ws = new WebSocket(url())
    await once(ws, 'open')
    const seen = once(ws, 'message')
    ws.send('hello handoff')
    expect((await seen).data).toBe('hello handoff')
    ws.close()
    await once(ws, 'close')
  })

  it('round-trips a message larger than 64 KiB (64-bit length + reassembly)', async () => {
    const ws = new WebSocket(url())
    await once(ws, 'open')
    const big = 'x'.repeat(200_000) + '|end'
    const seen = once(ws, 'message')
    ws.send(big)
    const got = (await seen).data
    expect(got.length).toBe(big.length)
    expect(got).toBe(big)
    ws.close()
    await once(ws, 'close')
  })

  it('emits connection/message/close events', async () => {
    const connected = once(hub, 'connection')
    const ws = new WebSocket(url())
    const [conn] = await connected
    const closed = once(conn, 'close')
    const echoed = once(ws, 'message')
    await once(ws, 'open')
    ws.send('events')
    expect((await echoed).data).toBe('events')
    ws.close(1000, 'bye')
    const [closeArgs] = await Promise.all([closed, once(ws, 'close')])
    expect(closeArgs[0]).toBe(1000)
  })

  it('releases a client that ends TCP without a WebSocket close frame', async () => {
    const connected = once(hub, 'connection')
    const { socket } = await rawHandshake(port)
    rawSockets.add(socket)
    const [conn] = await connected
    const closed = once(conn, 'close')
    socket.end()
    expect((await closed)[0]).toBe(1006)
    expect(conn.closed).toBe(true)
    expect(hub.clients.has(conn)).toBe(false)
    socket.destroy()
    rawSockets.delete(socket)
  })

  it('answers a ping with a pong, handles fragments and back-to-back frames', async () => {
    const { socket, head, rest } = await rawHandshake(port)
    rawSockets.add(socket)
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols')
    expect(head).toMatch(/Sec-WebSocket-Accept: /)

    // ping -> pong with the same payload
    socket.write(clientFrame(0x9, 'ping-payload'))
    const pong = await readFrame(socket, rest)
    expect(pong.opcode).toBe(0xa)
    expect(pong.payload.toString()).toBe('ping-payload')

    // one TCP write carrying a fragmented text message (0x1 !fin + 0x0 fin)
    socket.write(Buffer.concat([clientFrame(0x1, 'frag-', false), clientFrame(0x0, 'mented')]))
    const echo = await readFrame(socket, pong.rest)
    expect(echo.opcode).toBe(0x1)
    expect(echo.payload.toString()).toBe('frag-mented')

    // clean close handshake: server echoes a close frame
    socket.write(clientFrame(0x8, Buffer.from([0x03, 0xe8])))
    const close = await readFrame(socket, echo.rest)
    expect(close.opcode).toBe(0x8)
    expect(close.payload.readUInt16BE(0)).toBe(1000)
    socket.destroy()
    rawSockets.delete(socket)
  })

  it('rejects a bad Origin with a plain 403 before upgrading', async () => {
    const { socket, head } = await rawHandshake(port, { origin: 'https://evil.example' })
    rawSockets.add(socket)
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden')
    socket.destroy()
    rawSockets.delete(socket)
  })

  it('accepts a chrome-extension:// Origin and rejects other paths', async () => {
    const good = await rawHandshake(port, { origin: 'chrome-extension://abcdefghijklmnop' })
    rawSockets.add(good.socket)
    expect(good.head.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols')
    good.socket.destroy()
    rawSockets.delete(good.socket)

    const wrong = await rawHandshake(port, { path: '/nope' })
    rawSockets.add(wrong.socket)
    expect(wrong.head.split('\r\n')[0]).toBe('HTTP/1.1 404 Not Found')
    wrong.socket.destroy()
    rawSockets.delete(wrong.socket)
  })
})
