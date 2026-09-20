/**
 * Local disk <-> VFS helpers, against a fake daemon API.
 *
 * These run in the CLI/MCP process, so the things worth pinning are the ones a
 * coding agent will hit: where a pushed file lands by default, that bytes
 * survive the base64 round trip, and that a pull cannot silently clobber a
 * local file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pullFile, pushFile, resolveVfsPath, normalizeVfsPath, FileError } from '../src/files.mjs'

describe('vfs path resolution', () => {
  it('defaults a push to /workspace/inbox and honours explicit destinations', () => {
    expect(resolveVfsPath('/home/me/resume.pdf')).toBe('/workspace/inbox/resume.pdf')
    expect(resolveVfsPath('/home/me/resume.pdf', 'docs/')).toBe('/workspace/docs/resume.pdf')
    expect(resolveVfsPath('/home/me/resume.pdf', '/workspace/cv.pdf')).toBe('/workspace/cv.pdf')
    expect(resolveVfsPath('/home/me/a.md', '/skills/writing/a.md')).toBe('/skills/writing/a.md')
  })

  it('roots a bare read path at /workspace', () => {
    expect(normalizeVfsPath('notes.md')).toBe('/workspace/notes.md')
    expect(normalizeVfsPath('/skills/x/SKILL.md')).toBe('/skills/x/SKILL.md')
    expect(() => normalizeVfsPath('  ')).toThrow(FileError)
  })
})

describe('push and pull', () => {
  let dir
  const store = new Map()
  const calls = []

  /** Stands in for the daemon: the same two endpoints, in memory. */
  const api = async (endpoint, body) => {
    calls.push([endpoint, body])
    if (endpoint === '/fs/write') {
      const bytes = Buffer.from(body.base64, 'base64')
      store.set(body.path, bytes)
      return { path: body.path, size: bytes.length, mediaType: 'application/pdf' }
    }
    if (endpoint === '/fs/read') {
      const bytes = store.get(body.path)
      if (!bytes) throw new Error('not_found')
      return { path: body.path, base64: bytes.toString('base64'), mediaType: 'application/pdf', size: bytes.length }
    }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-files-test-'))
    store.clear()
    calls.length = 0
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('pushes bytes verbatim and reports the path Handoff will see', async () => {
    const local = path.join(dir, 'resume.pdf')
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe])
    fs.writeFileSync(local, bytes)

    const entry = await pushFile(api, local)
    expect(entry.path).toBe('/workspace/inbox/resume.pdf')
    expect(entry.localPath).toBe(local)
    expect(store.get('/workspace/inbox/resume.pdf')).toEqual(bytes)
  })

  it('expands a leading ~ the way a shell would', async () => {
    // MCP clients pass the model's literal string; nothing expands it for us.
    await expect(pushFile(api, '~/almost-certainly-not-here-9f3c.pdf')).rejects.toThrow(
      new RegExp(`no such file: ${os.homedir()}`),
    )
  })

  it('refuses a missing file and a directory before touching the daemon', async () => {
    await expect(pushFile(api, path.join(dir, 'nope.pdf'))).rejects.toThrow(/no such file/)
    await expect(pushFile(api, dir)).rejects.toThrow(/is a directory/)
    expect(calls).toHaveLength(0)
  })

  it('pulls a file back to disk, byte for byte', async () => {
    const bytes = Buffer.from([1, 2, 3, 250, 251])
    store.set('/workspace/resume-revised.pdf', bytes)

    const result = await pullFile(api, '/workspace/resume-revised.pdf', dir)
    expect(result.localPath).toBe(path.join(dir, 'resume-revised.pdf'))
    expect(result.bytes).toBe(5)
    expect(fs.readFileSync(result.localPath)).toEqual(bytes)
  })

  it('will not overwrite an existing local file unless told to', async () => {
    store.set('/workspace/out.txt', Buffer.from('new'))
    const local = path.join(dir, 'out.txt')
    fs.writeFileSync(local, 'original')

    await expect(pullFile(api, '/workspace/out.txt', local)).rejects.toThrow(/already exists/)
    expect(fs.readFileSync(local, 'utf8')).toBe('original')

    const result = await pullFile(api, '/workspace/out.txt', local, { overwrite: true })
    expect(result.localPath).toBe(local)
    expect(fs.readFileSync(local, 'utf8')).toBe('new')
  })

  it('creates missing parent directories on the way out', async () => {
    store.set('/workspace/report.md', Buffer.from('# report'))
    const target = path.join(dir, 'nested', 'deeper', 'report.md')
    const result = await pullFile(api, '/workspace/report.md', target)
    expect(fs.readFileSync(result.localPath, 'utf8')).toBe('# report')
  })
})
