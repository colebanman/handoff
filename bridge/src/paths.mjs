// State directory + shared-secret handling for handoff-bridge.
//
// Everything reads the environment lazily so that tests can point
// HANDOFF_BRIDGE_HOME at a temp dir after this module has been imported.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'

export const VERSION = '0.2.0'
export const DEFAULT_PORT = 8787

export function stateDir(override) {
  if (override) return resolve(override)
  if (process.env.HANDOFF_BRIDGE_HOME) return resolve(process.env.HANDOFF_BRIDGE_HOME)
  return join(homedir(), '.handoff-bridge')
}

export function tokenPath(home) {
  return join(stateDir(home), 'token')
}

export function daemonInfoPath(home) {
  return join(stateDir(home), 'daemon.json')
}

export function defaultPort() {
  const raw = process.env.HANDOFF_BRIDGE_PORT
  const n = raw ? Number(raw) : NaN
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT
}

function ensureDir(home) {
  const dir = stateDir(home)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Read the shared token, creating a fresh 32-byte hex one (0600) if absent. */
export function ensureToken(home) {
  ensureDir(home)
  const file = tokenPath(home)
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    /* fall through and create */
  }
  const token = randomBytes(32).toString('hex')
  fs.writeFileSync(file, token + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort on exotic filesystems */
  }
  return token
}

/** Read the token without creating one. Returns null when it does not exist. */
export function readToken(home) {
  try {
    const t = fs.readFileSync(tokenPath(home), 'utf8').trim()
    return t || null
  } catch {
    return null
  }
}

export function writeDaemonInfo(info, home) {
  ensureDir(home)
  const file = daemonInfoPath(home)
  fs.writeFileSync(file, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort */
  }
}

export function readDaemonInfo(home) {
  try {
    return JSON.parse(fs.readFileSync(daemonInfoPath(home), 'utf8'))
  } catch {
    return null
  }
}

export function clearDaemonInfo(home) {
  try {
    fs.rmSync(daemonInfoPath(home))
  } catch {
    /* already gone */
  }
}
