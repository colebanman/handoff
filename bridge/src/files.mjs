// Local disk <-> Handoff's virtual filesystem.
//
// The daemon never touches the caller's disk: it relays JSON between the HTTP
// client and the extension, and nothing else. So the file reading and writing
// happens here, in the CLI/MCP process, where `cwd` and relative paths mean
// what the calling agent thinks they mean.
//
// Handoff's files live in the extension's IndexedDB under two roots, /workspace
// and /skills. A local agent pushes a document into /workspace, asks Handoff to
// work on it, and pulls the result back out by path.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

/**
 * Resolve a local path the way the caller means it. MCP clients hand over
 * whatever the model typed, and a model types `~/docs/resume.pdf` — there is no
 * shell in this path to expand it.
 */
function localPath(value) {
  const raw = String(value ?? '').trim()
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? resolve(homedir(), raw.slice(2)) : raw
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
}

/** Matches BRIDGE_FILE_MAX_BYTES in src/shared/bridge-protocol.ts. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

/** Where a push lands when the caller does not name a destination. */
export const DEFAULT_PUSH_DIR = '/workspace/inbox'

export class FileError extends Error {}

/** Strip path segments a VFS path may not contain, keeping the shape valid. */
function sanitizeRelative(value) {
  return String(value)
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
}

/**
 * Resolve the VFS destination for a local file.
 *
 * - no destination        -> /workspace/inbox/<name>
 * - a directory ("a/b/")  -> /workspace/a/b/<name>   (or /skills/... if named)
 * - a full path           -> used as given, rooted at /workspace when bare
 */
export function resolveVfsPath(from, dest) {
  const name = sanitizeRelative(basename(from)) || 'file'
  const raw = typeof dest === 'string' ? dest.trim() : ''
  if (!raw) return `${DEFAULT_PUSH_DIR}/${name}`
  const rooted = raw.startsWith('/skills/') || raw.startsWith('/workspace/') || raw === '/skills' || raw === '/workspace'
  const withRoot = rooted ? raw : `/workspace/${raw.replace(/^\/+/, '')}`
  if (withRoot.endsWith('/')) return `${withRoot}${name}`
  return withRoot
}

/** Normalize a VFS path the caller typed (bare names live in /workspace). */
export function normalizeVfsPath(path) {
  const raw = String(path ?? '').trim()
  if (!raw) throw new FileError('a filesystem path is required')
  if (raw.startsWith('/workspace/') || raw.startsWith('/skills/')) return raw
  return `/workspace/${raw.replace(/^\/+/, '')}`
}

/**
 * Read a local file and write it into Handoff's filesystem.
 *
 * @param {(path: string, body: object) => Promise<any>} api  daemon caller
 * @returns {Promise<object>} the VfsEntry the extension stored
 */
export async function pushFile(api, local, dest) {
  const abs = localPath(local)
  let info
  try {
    info = await stat(abs)
  } catch {
    throw new FileError(`no such file: ${abs}`)
  }
  if (info.isDirectory()) throw new FileError(`${abs} is a directory — push files one at a time`)
  if (info.size > MAX_FILE_BYTES) {
    throw new FileError(`${abs} is ${info.size} bytes, above the ${MAX_FILE_BYTES}-byte transfer limit`)
  }
  const bytes = await readFile(abs)
  const path = resolveVfsPath(abs, dest)
  const entry = await api('/fs/write', { path, base64: bytes.toString('base64') })
  return entry && typeof entry === 'object' ? { ...entry, localPath: abs } : { path, localPath: abs }
}

/**
 * Read a file out of Handoff's filesystem and write it to local disk.
 *
 * Refuses to clobber an existing file unless `overwrite` is set — a coding
 * agent pulling a "revised" document should never silently eat the original.
 */
export async function pullFile(api, vfsPath, outPath, { overwrite = false } = {}) {
  const path = normalizeVfsPath(vfsPath)
  const name = path.split('/').filter(Boolean).at(-1) || 'download'
  const wanted = typeof outPath === 'string' && outPath.trim() ? outPath.trim() : name
  let abs = localPath(wanted)
  try {
    if ((await stat(abs)).isDirectory()) abs = resolve(abs, name)
  } catch {
    // Does not exist yet: that is the normal case.
  }
  if (!overwrite) {
    try {
      await stat(abs)
      throw new FileError(`${abs} already exists — pass overwrite to replace it, or name another path`)
    } catch (err) {
      if (err instanceof FileError) throw err
      // ENOENT: free to write.
    }
  }
  const result = await api('/fs/read', { path, encoding: 'base64' })
  if (!result || typeof result.base64 !== 'string') {
    throw new FileError(`the extension returned no bytes for ${path}`)
  }
  await mkdir(dirname(abs), { recursive: true })
  const bytes = Buffer.from(result.base64, 'base64')
  await writeFile(abs, bytes)
  return { path, localPath: abs, bytes: bytes.length, mediaType: result.mediaType }
}
