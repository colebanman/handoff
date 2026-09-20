/**
 * The memory format is a contract between three places: the file on disk, the
 * line spans quoted in the system prompt, and `api.fs.readLines` reading those
 * spans back. These tests pin that contract — especially that a span parsed out
 * of a formatted file really does address the heading and body lines, since the
 * whole titles-now/bodies-on-demand scheme is worthless if the numbers drift.
 */

import { describe, expect, it } from 'vitest'
import type { VirtualFileSystemService, VfsEntry } from '../shared/types'
import {
  MEMORY_MAX_ENTRIES,
  MEMORY_PATH,
  applyMemoryWrite,
  describeMemoryWrite,
  ensureMemoryFile,
  formatMemory,
  memoryIndexLines,
  memoryKey,
  parseMemory,
  readMemory,
  removeMemories,
  serializeMemoryForPrompt,
  upsertMemories,
  type MemoryEntry,
} from './memory'

/** In-memory stand-in for the IndexedDB VFS (see workflows.test.ts). */
function memoryVfs(seed?: string): { vfs: VirtualFileSystemService; writes: Map<string, string> } {
  const writes = new Map<string, string>()
  if (seed !== undefined) writes.set(MEMORY_PATH, seed)
  const vfs = {
    async writeText(path: string, value: string, opts?: { mediaType?: string }): Promise<VfsEntry> {
      writes.set(path, value)
      const now = Date.now()
      return {
        path,
        root: 'workspace',
        name: path.split('/').at(-1) ?? path,
        mediaType: opts?.mediaType ?? 'text/plain',
        size: value.length,
        createdAt: now,
        updatedAt: now,
      }
    },
    async getEntry(path: string): Promise<VfsEntry | undefined> {
      const text = writes.get(path)
      if (text === undefined) return undefined
      const now = Date.now()
      return {
        path,
        root: 'workspace',
        name: path.split('/').at(-1) ?? path,
        mediaType: 'text/markdown',
        size: text.length,
        createdAt: now,
        updatedAt: now,
      }
    },
    async readText(path: string) {
      const text = writes.get(path)
      if (text === undefined) throw new Error(`missing ${path}`)
      return { path, text, truncated: false, totalChars: text.length }
    },
  } as unknown as VirtualFileSystemService
  return { vfs, writes }
}

const SAMPLE: MemoryEntry[] = [
  {
    title: 'Attends Example College',
    body: 'Community college in Example City. Canvas at school.instructure.com.',
    date: '2026-08-04',
  },
  { title: 'Prefers Outlook for email', body: 'Uses outlook.office.com rather than Gmail.', date: '2026-08-04' },
  { title: 'Writes TypeScript daily', body: 'Works in a strict-mode TypeScript monorepo.', date: '2026-07-30' },
]

function entriesOf(vfs: { writes: Map<string, string> }): string {
  return vfs.writes.get(MEMORY_PATH) ?? ''
}

describe('memory format', () => {
  it('round-trips through format and parse', () => {
    const text = formatMemory(SAMPLE)
    const parsed = parseMemory(text)

    expect(parsed.map((entry) => ({ title: entry.title, body: entry.body, date: entry.date }))).toEqual(SAMPLE)
    // Re-formatting parsed entries is a fixed point: the writer is the only writer.
    expect(formatMemory(parsed)).toBe(text)
  })

  it('renders an empty file when there is nothing to remember', () => {
    expect(parseMemory(formatMemory([]))).toEqual([])
  })

  it('lands its line spans on the real heading and body lines', () => {
    const text = formatMemory(SAMPLE)
    const lines = text.split('\n')
    const parsed = parseMemory(text)

    expect(parsed).toHaveLength(SAMPLE.length)
    for (const entry of parsed) {
      // 1-based spans, matching api.fs.readLines.
      expect(lines[entry.startLine - 1]).toBe(`## ${entry.title}`)
      expect(lines[entry.endLine - 1]).toBe(entry.body)
      // What readLines(startLine, count) would hand the model.
      expect(lines.slice(entry.startLine - 1, entry.endLine)).toEqual([`## ${entry.title}`, entry.body])
    }
    // Canonical four-line entries after the fixed header: a stride of exactly 4.
    expect(parsed.map((entry) => entry.startLine)).toEqual([7, 11, 15])
    expect(memoryIndexLines(parsed)[0]).toBe('- Attends Example College (lines 7-8)')
  })
})

describe('memory file bootstrap', () => {
  it('creates a canonical empty file when an upgraded profile has none', async () => {
    const { vfs, writes } = memoryVfs()

    await expect(ensureMemoryFile(vfs)).resolves.toBe(true)
    expect(writes.get(MEMORY_PATH)).toBe(formatMemory([]))
  })

  it('never rewrites an existing user-owned file', async () => {
    const handEdited = '# My memory\n\nUser-owned content.\n'
    const { vfs, writes } = memoryVfs(handEdited)

    await expect(ensureMemoryFile(vfs)).resolves.toBe(false)
    expect(writes.get(MEMORY_PATH)).toBe(handEdited)
  })
})

describe('memory merge', () => {
  it('updates a loosely matching title in place', () => {
    const existing: MemoryEntry[] = [
      { title: 'Goes to Example College.', body: 'Community college in Example City.', date: '2026-07-01' },
      ...SAMPLE.slice(1),
    ]
    const merged = upsertMemories(existing, [{ title: 'goes to example college', body: 'Canvas at school.instructure.com.' }], new Date('2026-08-04T12:00:00'))

    expect(merged.entries).toHaveLength(3)
    expect(merged.addedTitles).toEqual([])
    expect(merged.updatedTitles).toEqual(['goes to example college'])
    // Position preserved, so the line spans of later entries do not shift.
    expect(merged.entries[0]).toEqual({ title: 'goes to example college', body: 'Canvas at school.instructure.com.', date: '2026-08-04' })
    expect(merged.entries.map((entry) => entry.title).slice(1)).toEqual(SAMPLE.slice(1).map((entry) => entry.title))
  })

  it('treats Stable, Current, and legacy versions of the same title as one entry', () => {
    expect(memoryKey('[Current] Example College — school and Canvas context')).toBe(
      memoryKey('[Stable] Example College — school and Canvas context'),
    )
    expect(memoryKey('[Current] Example College — school and Canvas context')).toBe(
      memoryKey('Example College — school and Canvas context'),
    )

    const merged = upsertMemories(
      [{ title: 'Example College — school and Canvas context', body: 'Legacy body.', date: '2026-07-01' }],
      [{ title: '[Current] Example College — school and Canvas context', body: 'Verified Canvas URL.' }],
      new Date('2026-08-06T12:00:00'),
    )
    expect(merged.entries).toEqual([
      {
        title: '[Current] Example College — school and Canvas context',
        body: 'Verified Canvas URL.',
        date: '2026-08-06',
      },
    ])
    expect(merged.addedTitles).toEqual([])
    expect(merged.updatedTitles).toEqual(['[Current] Example College — school and Canvas context'])
  })

  it('appends genuinely new facts at the end', () => {
    const merged = upsertMemories(SAMPLE, [{ title: 'Uses Linear for tickets', body: 'Team tracker.' }])
    expect(merged.addedTitles).toEqual(['Uses Linear for tickets'])
    expect(merged.entries.at(-1)?.title).toBe('Uses Linear for tickets')
  })

  it('removes matched titles and reports the ones that matched nothing', () => {
    const removed = removeMemories(SAMPLE, ['prefers outlook for email!', 'Lives in Reno'])
    expect(removed.forgottenTitles).toEqual(['Prefers Outlook for email'])
    expect(removed.missing).toEqual(['Lives in Reno'])
    expect(removed.entries.map((entry) => entry.title)).toEqual([
      'Attends Example College',
      'Writes TypeScript daily',
    ])
  })
})

describe('memory prompt snapshot', () => {
  it('includes every title, body, and update date as JSON data', () => {
    const json = serializeMemoryForPrompt(SAMPLE)
    expect(JSON.parse(json)).toEqual(
      SAMPLE.map((entry) => ({ title: entry.title, body: entry.body, updated: entry.date })),
    )
  })

  it('represents no memories as an empty array and redacts accidental secrets', () => {
    expect(serializeMemoryForPrompt([])).toBe('[]')
    const fakeKey = `sk-proj-${'x'.repeat(36)}`
    const json = serializeMemoryForPrompt([
      {
        title: '[Stable] Developer account — preferred API provider',
        body: `Uses key ${fakeKey} for testing.`,
        date: '2026-08-06',
      },
    ])
    expect(json).not.toContain(fakeKey)
    expect(json).toContain('[redacted:openai-key')
  })

  it('bounds a hand-edited file that exceeds the managed entry limit', () => {
    const oversized = Array.from({ length: MEMORY_MAX_ENTRIES + 5 }, (_, index) => ({
      title: `Memory ${index}`,
      body: `Detail ${index}`,
      date: '2026-08-06',
    }))
    expect(JSON.parse(serializeMemoryForPrompt(oversized))).toHaveLength(MEMORY_MAX_ENTRIES)
  })
})

describe('applyMemoryWrite', () => {
  it('reads back nothing when the file does not exist', async () => {
    const { vfs } = memoryVfs()
    expect(await readMemory(vfs)).toEqual([])
  })

  it('writes, then reports adds, updates, and forgets', async () => {
    const { vfs, writes } = memoryVfs()
    const first = await applyMemoryWrite(
      vfs,
      { memories: SAMPLE.map(({ title, body }) => ({ title, body })) },
      new Date('2026-08-04T09:00:00'),
    )
    expect(first.addedTitles).toHaveLength(3)
    expect(writes.get(MEMORY_PATH)).toContain('## Attends Example College')

    const second = await applyMemoryWrite(
      vfs,
      {
        memories: [{ title: 'Prefers Outlook for email', body: 'Corporate tenant; no Gmail account at all.' }],
        forget: ['Writes TypeScript daily', 'Owns a boat'],
      },
      new Date('2026-08-05T09:00:00'),
    )
    expect(second.updatedTitles).toEqual(['Prefers Outlook for email'])
    expect(second.forgottenTitles).toEqual(['Writes TypeScript daily'])
    expect(second.warnings).toContain('no memory matched "Owns a boat"')
    expect(second.entries.map((entry) => entry.title)).toEqual([
      'Attends Example College',
      'Prefers Outlook for email',
    ])
    // The one-line confirmation is the model's only feedback channel.
    const summary = describeMemoryWrite(second)
    expect(summary).toContain('updated "Prefers Outlook for email"')
    expect(summary).toContain('forgot "Writes TypeScript daily"')
    expect(summary).toContain(`${MEMORY_PATH} now holds 2 memor`)
    expect(summary).toContain('Note: no memory matched "Owns a boat"')
  })

  it('refuses an empty write', async () => {
    const { vfs } = memoryVfs()
    await expect(applyMemoryWrite(vfs, {})).rejects.toThrow(/nothing to write/)
  })

  it(`throws instead of silently dropping past ${MEMORY_MAX_ENTRIES} entries`, async () => {
    const full = Array.from({ length: MEMORY_MAX_ENTRIES }, (_, i) => ({
      title: `Fact number ${i}`,
      body: `Detail ${i}.`,
      date: '2026-08-04',
    }))
    const { vfs, writes } = memoryVfs(formatMemory(full))
    const before = entriesOf({ writes })

    await expect(
      applyMemoryWrite(vfs, { memories: [{ title: 'One too many', body: 'Overflows the cap.' }] }),
    ).rejects.toThrow(/MEMORY.md is full \(60 entries\)/)
    // The failed write left the file untouched.
    expect(entriesOf({ writes })).toBe(before)

    // Updating an existing fact still works at the cap.
    const updated = await applyMemoryWrite(vfs, { memories: [{ title: 'Fact number 3', body: 'Sharper detail.' }] })
    expect(updated.entries).toHaveLength(MEMORY_MAX_ENTRIES)
  })

  it('normalizes a hand-mangled file on the next write', async () => {
    const mangled = `# Memory

## Attends Example College

Community college in Example City.
Canvas at school.instructure.com.


## Prefers Outlook for email
Uses outlook.office.com rather than Gmail.
<!-- 2026-07-01 -->
`
    const { vfs, writes } = memoryVfs(mangled)
    // The user's edits survive as content, even before we rewrite.
    expect((await readMemory(vfs)).map((entry) => entry.body)).toEqual([
      'Community college in Example City. Canvas at school.instructure.com.',
      'Uses outlook.office.com rather than Gmail.',
    ])

    const result = await applyMemoryWrite(
      vfs,
      { memories: [{ title: 'Uses Linear for tickets', body: 'Team tracker.' }] },
      new Date('2026-08-04T09:00:00'),
    )
    const text = entriesOf({ writes })
    const lines = text.split('\n')

    // Canonical again: four lines per entry, bodies un-wrapped, dates restored.
    expect(result.entries).toHaveLength(3)
    expect(formatMemory(result.entries)).toBe(text)
    for (const entry of result.entries) {
      expect(entry.endLine).toBe(entry.startLine + 1)
      expect(lines[entry.startLine - 1]).toBe(`## ${entry.title}`)
      expect(lines[entry.endLine - 1]).toBe(entry.body)
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    expect(result.entries.at(-1)).toMatchObject({ title: 'Uses Linear for tickets', date: '2026-08-04' })
    expect(text).not.toContain('\n\n\n')
  })
})
