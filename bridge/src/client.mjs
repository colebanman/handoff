// HTTP client for the daemon, shared by the CLI and the MCP server.
// Includes ensureDaemon(): probe /health, and auto-spawn a detached daemon if
// nothing healthy answers.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { VERSION, defaultPort, ensureToken, readToken } from './paths.mjs'

const ENTRY = fileURLToPath(new URL('../handoff-bridge.mjs', import.meta.url))
const SPAWN_POLL_MS = 100
const SPAWN_TIMEOUT_MS = 8_000

export class BridgeError extends Error {
  constructor(code, message, status) {
    super(message || code)
    this.code = code
    this.status = status
  }
}

function base(port) {
  return `http://127.0.0.1:${port}`
}

async function withTimeout(ms, fn) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    return await fn(ac.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** GET /health. Returns null when nothing healthy is listening. */
export async function health(port = defaultPort(), timeoutMs = 1500) {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetch(`${base(port)}/health`, { signal })
      if (!res.ok) return null
      const body = await res.json()
      return body && body.ok ? body : null
    })
  } catch {
    return null
  }
}

/** POST a JSON body to the daemon with the bearer token. */
export async function call(path, body = {}, { port = defaultPort(), home, timeoutMs = 0 } = {}) {
  const token = readToken(home) ?? ensureToken(home)
  const doFetch = async (signal) => {
    let res
    try {
      res = await fetch(`${base(port)}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      throw new BridgeError('daemon_unreachable', `Cannot reach the handoff-bridge daemon on port ${port}: ${err?.message || err}`)
    }
    const text = await res.text()
    let json
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      throw new BridgeError('internal', `Daemon returned non-JSON (${res.status}): ${text.slice(0, 200)}`, res.status)
    }
    if (!res.ok) throw new BridgeError(json.error || 'internal', json.message || `HTTP ${res.status}`, res.status)
    return json
  }
  // A long waitSec must not be cut short by a client-side timeout.
  if (!timeoutMs) return await doFetch(undefined)
  return await withTimeout(timeoutMs, doFetch)
}

/** Ensure a daemon is running on `port`, spawning one detached if needed. */
export async function ensureDaemon({ port = defaultPort(), spawnIfMissing = true, log } = {}) {
  const existing = await health(port)
  if (existing) return existing
  if (!spawnIfMissing) throw new BridgeError('daemon_unreachable', `No handoff-bridge daemon on port ${port}`)

  log?.(`starting daemon on port ${port}`)
  const child = spawn(process.execPath, [ENTRY, 'start', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()

  const deadline = Date.now() + SPAWN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SPAWN_POLL_MS))
    const info = await health(port, 500)
    if (info) return info
  }
  throw new BridgeError('daemon_unreachable', `Daemon did not become healthy on port ${port} within ${SPAWN_TIMEOUT_MS / 1000}s`)
}

export { VERSION, defaultPort }
