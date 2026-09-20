// Minimal RFC 6455 WebSocket *server*, hand-rolled on top of a node:http server.
//
// Why hand-rolled: handoff-bridge must run with zero npm dependencies so that a user
// can `node bridge/handoff-bridge.mjs mcp` with nothing installed. We only need the
// server half (the Chrome extension is the client), and only text frames, so the
// surface stays small: handshake, frame parse/encode, ping/pong keepalive.
//
// Not implemented on purpose: permessage-deflate, subprotocol negotiation,
// binary application messages (received binary frames are dropped), and client
// mode. Everything else in RFC 6455 that a browser client can emit is handled.

import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
}

const DEFAULT_MAX_MESSAGE = 32 * 1024 * 1024 // 32 MiB
const PING_INTERVAL_MS = 20_000
const IDLE_TIMEOUT_MS = 60_000

function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

function httpReject(socket, status, text) {
  const body = `${status} ${text}\n`
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body,
  )
}

/** Encode a server frame. Server frames are NEVER masked (RFC 6455 §5.1). */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const len = data.length
  let header
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = len
  } else if (len < 0x10000) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode // FIN set: we never fragment outbound frames
  return Buffer.concat([header, data], header.length + len)
}

function unmask(buf, key) {
  for (let i = 0; i < buf.length; i++) buf[i] ^= key[i & 3]
  return buf
}

class WsConnection extends EventEmitter {
  constructor(socket, opts) {
    super()
    this.socket = socket
    this.maxMessage = opts.maxMessage
    this.req = opts.req
    this.origin = opts.req?.headers?.origin ?? null
    this.closed = false
    this.buf = Buffer.alloc(0)
    this.fragments = []
    this.fragmentLen = 0
    this.fragmentOpcode = 0
    this.lastData = Date.now()

    socket.setNoDelay(true)
    socket.on('data', (chunk) => {
      this.lastData = Date.now()
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
      try {
        this._drain()
      } catch (err) {
        this.emit('error', err)
        this.terminate()
      }
    })
    socket.on('error', (err) => {
      this.emit('error', err)
      this._finish(1006, 'socket error')
    })
    socket.on('close', () => this._finish(1006, 'socket closed'))
    // Upgraded HTTP sockets can stay half open after TCP EOF. A crashed client
    // cannot send a WebSocket close frame, so retire its connection now.
    socket.on('end', () => this.terminate())

    this.keepalive = setInterval(() => {
      if (this.closed) return
      if (Date.now() - this.lastData > IDLE_TIMEOUT_MS) {
        this.terminate()
        return
      }
      this._raw(encodeFrame(OPCODE.PING))
    }, PING_INTERVAL_MS)
    // Never hold the event loop open just for the keepalive timer.
    this.keepalive.unref?.()
  }

  /** Pull as many whole frames out of this.buf as it currently holds. */
  _drain() {
    for (;;) {
      const buf = this.buf
      if (buf.length < 2) return
      const b0 = buf[0]
      const b1 = buf[1]
      const fin = (b0 & 0x80) !== 0
      const rsv = b0 & 0x70
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let off = 2

      if (rsv !== 0) throw new Error('RSV bits set (no extensions negotiated)')

      if (len === 126) {
        if (buf.length < off + 2) return
        len = buf.readUInt16BE(off)
        off += 2
      } else if (len === 127) {
        if (buf.length < off + 8) return
        const big = buf.readBigUInt64BE(off)
        if (big > BigInt(this.maxMessage)) throw new Error('frame too large')
        len = Number(big)
        off += 8
      }

      let maskKey = null
      if (masked) {
        if (buf.length < off + 4) return
        maskKey = buf.subarray(off, off + 4)
        off += 4
      } else {
        // RFC 6455 §5.1: a server MUST close the connection on an unmasked
        // client frame.
        throw new Error('client frame was not masked')
      }

      const isControl = (opcode & 0x8) !== 0
      if (isControl && (len > 125 || !fin)) throw new Error('bad control frame')
      if (len > this.maxMessage) throw new Error('frame too large')
      if (buf.length < off + len) return // frame spans chunks: wait for more

      // Copy before unmasking: subarray shares memory with the pending buffer.
      const payload = Buffer.from(buf.subarray(off, off + len))
      unmask(payload, maskKey)
      this.buf = buf.subarray(off + len)
      this._frame(fin, opcode, payload)
      if (this.closed) return
    }
  }

  _frame(fin, opcode, payload) {
    switch (opcode) {
      case OPCODE.PING:
        this._raw(encodeFrame(OPCODE.PONG, payload))
        this.emit('ping', payload)
        return
      case OPCODE.PONG:
        this.emit('pong', payload)
        return
      case OPCODE.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        if (!this.closed) {
          const echo = Buffer.allocUnsafe(2)
          echo.writeUInt16BE(code === 1005 ? 1000 : code, 0)
          this._raw(encodeFrame(OPCODE.CLOSE, echo))
        }
        this._finish(code, reason)
        this.socket.end()
        return
      }
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (this.fragments.length) throw new Error('interleaved fragmented message')
        if (fin) {
          this._deliver(opcode, payload)
          return
        }
        this.fragmentOpcode = opcode
        this.fragments = [payload]
        this.fragmentLen = payload.length
        return
      case OPCODE.CONTINUATION: {
        if (!this.fragments.length) throw new Error('continuation without start frame')
        this.fragmentLen += payload.length
        if (this.fragmentLen > this.maxMessage) throw new Error('message too large')
        this.fragments.push(payload)
        if (!fin) return
        const whole = Buffer.concat(this.fragments, this.fragmentLen)
        const op = this.fragmentOpcode
        this.fragments = []
        this.fragmentLen = 0
        this.fragmentOpcode = 0
        this._deliver(op, whole)
        return
      }
      default:
        throw new Error(`unknown opcode 0x${opcode.toString(16)}`)
    }
  }

  _deliver(opcode, payload) {
    // Only text is meaningful for the bridge protocol; binary is dropped.
    if (opcode === OPCODE.TEXT) this.emit('message', payload.toString('utf8'))
  }

  _raw(buf) {
    if (this.socket.destroyed || this.socket.writableEnded) return false
    try {
      this.socket.write(buf)
      return true
    } catch {
      return false
    }
  }

  /** Send a text frame. Returns false if the socket is gone. */
  send(text) {
    if (this.closed) return false
    return this._raw(encodeFrame(OPCODE.TEXT, Buffer.from(String(text), 'utf8')))
  }

  ping(payload = Buffer.alloc(0)) {
    return this._raw(encodeFrame(OPCODE.PING, payload))
  }

  /** Graceful close: send a close frame, then end the socket. */
  close(code = 1000, reason = '') {
    if (this.closed) return
    const reasonBuf = Buffer.from(reason, 'utf8')
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length)
    payload.writeUInt16BE(code, 0)
    reasonBuf.copy(payload, 2)
    this._raw(encodeFrame(OPCODE.CLOSE, payload))
    this._finish(code, reason)
    this.socket.end()
  }

  terminate() {
    this._finish(1006, 'terminated')
    this.socket.destroy()
  }

  _finish(code, reason) {
    if (this.closed) return
    this.closed = true
    clearInterval(this.keepalive)
    this.emit('close', code, reason)
  }
}

/**
 * Attach a WebSocket endpoint to an existing node:http server.
 *
 * @param {import('node:http').Server} httpServer
 * @param {{ path?: string, verifyOrigin?: (origin: string|undefined, req: any) => boolean, maxMessage?: number }} [options]
 * @returns {EventEmitter & { clients: Set<WsConnection>, closeAll: (code?: number, reason?: string) => void }}
 *   Emits 'connection' (conn, req); each conn emits 'message' (string), 'close', 'error'.
 */
export function createWsServer(httpServer, options = {}) {
  const { path = '/', verifyOrigin, maxMessage = DEFAULT_MAX_MESSAGE } = options
  const hub = new EventEmitter()
  hub.clients = new Set()

  hub.closeAll = (code = 1001, reason = 'server shutting down') => {
    for (const conn of [...hub.clients]) conn.close(code, reason)
  }

  httpServer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})

    let reqPath = req.url || '/'
    const q = reqPath.indexOf('?')
    if (q !== -1) reqPath = reqPath.slice(0, q)
    if (reqPath !== path) return httpReject(socket, 404, 'Not Found')

    const upgrade = String(req.headers.upgrade || '').toLowerCase()
    const key = req.headers['sec-websocket-key']
    if (upgrade !== 'websocket' || !key) return httpReject(socket, 400, 'Bad Request')
    if (String(req.headers['sec-websocket-version'] || '') !== '13') {
      return httpReject(socket, 426, 'Upgrade Required')
    }
    if (verifyOrigin && !verifyOrigin(req.headers.origin, req)) {
      return httpReject(socket, 403, 'Forbidden')
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
        '\r\n',
    )

    const conn = new WsConnection(socket, { maxMessage, req })
    hub.clients.add(conn)
    conn.on('close', () => hub.clients.delete(conn))
    // Bytes that arrived in the same TCP segment as the handshake.
    if (head && head.length) socket.emit('data', head)
    hub.emit('connection', conn, req)
  })

  return hub
}
