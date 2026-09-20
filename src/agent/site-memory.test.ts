/**
 * Site memory is a contract between the SITES.md file, the URL globs stored in
 * it, and the line spans quoted to the model. These tests pin the glob
 * semantics (the part a wrong guess would silently break: memories firing on the
 * wrong course, or never), specificity ordering, and that spans parsed from a
 * formatted file address the heading and body lines.
 */

import { describe, expect, it } from 'vitest'
import type { VirtualFileSystemService, VfsEntry } from '../shared/types'
import {
  SITE_MEMORY_MAX_ENTRIES,
  SITE_MEMORY_MAX_MATCHES,
  normalizeGuidePath,
  siteGuideMatchesTask,
  SITE_MEMORY_PATH,
  applySiteMemoryWrite,
  describeCombinedMemoryWrite,
  formatSiteMemory,
  matchSiteMemories,
  normalizeScope,
  normalizeUrlForScope,
  parseSiteMemory,
  scopeMatches,
  siteMemoryBlock,
  siteMemoryMatchKey,
  upsertSiteMemories,
  type SiteMemoryEntry,
} from './site-memory'
import { MEMORY_PATH, formatMemory } from './memory'

function fakeVfs(seed: Record<string, string> = {}): { vfs: VirtualFileSystemService; writes: Map<string, string> } {
  const writes = new Map<string, string>(Object.entries(seed))
  const entry = (path: string, size: number): VfsEntry => ({
    path,
    root: 'workspace',
    name: path.split('/').at(-1) ?? path,
    mediaType: 'text/markdown',
    size,
    createdAt: 0,
    updatedAt: 0,
  })
  const vfs = {
    async writeText(path: string, value: string) {
      writes.set(path, value)
      return entry(path, value.length)
    },
    async getEntry(path: string) {
      const text = writes.get(path)
      return text === undefined ? undefined : entry(path, text.length)
    },
    async readText(path: string) {
      const text = writes.get(path)
      if (text === undefined) throw new Error(`missing ${path}`)
      return { path, text, truncated: false, totalChars: text.length }
    },
  } as unknown as VirtualFileSystemService
  return { vfs, writes }
}

const COURSE = 'school.instructure.com/courses/123/**'
const CANVAS = '*.instructure.com/**'
const ASSIGNMENT = 'school.instructure.com/courses/123/assignments/456'

const SAMPLE: SiteMemoryEntry[] = [
  { title: 'Canvas — assignment bodies load in a lazy iframe', scopes: [CANVAS], body: 'Snapshot after 1s.', date: '2026-09-01' },
  { title: 'COURSE 101 — class rules for examples', scopes: [COURSE, 'school.instructure.com/api/v1/courses/123/**'], body: 'MA firms only. See /workspace/sites/course101.md', date: '2026-09-08' },
  { title: 'COURSE 101 case memo — project context', scopes: [ASSIGNMENT], body: 'Group of 3; due Oct 2.', date: '2026-09-08' },
]

describe('URL normalization', () => {
  it('drops scheme, www, port, query, fragment, and trailing slash', () => {
    expect(normalizeUrlForScope('https://www.School.instructure.com:443/courses/123/?x=1#top')).toBe(
      'school.instructure.com/courses/123',
    )
  })

  it('returns empty for non-http pages so nothing fires there', () => {
    expect(normalizeUrlForScope('chrome://newtab')).toBe('')
    expect(normalizeUrlForScope('about:blank')).toBe('')
    expect(normalizeUrlForScope('')).toBe('')
  })

  it('normalizes scopes written as URLs or bare hosts', () => {
    expect(normalizeScope('https://school.instructure.com/courses/123/')).toBe('school.instructure.com/courses/123')
    expect(normalizeScope('School.instructure.com')).toBe('school.instructure.com/**')
    expect(normalizeScope('www.example.com/a//b/?q=1')).toBe('example.com/a/b')
    expect(normalizeScope('   ')).toBe('')
  })
})

describe('glob matching', () => {
  it('matches a course scope on the course root and everything beneath it', () => {
    expect(scopeMatches(COURSE, 'https://school.instructure.com/courses/123')).toBe(true)
    expect(scopeMatches(COURSE, 'https://school.instructure.com/courses/123/')).toBe(true)
    expect(scopeMatches(COURSE, 'https://school.instructure.com/courses/123/assignments/456')).toBe(true)
    expect(scopeMatches(COURSE, 'https://school.instructure.com/courses/1234')).toBe(false)
    expect(scopeMatches(COURSE, 'https://school.instructure.com/courses/999/assignments/1')).toBe(false)
  })

  it('treats a single star as one host label or one path segment', () => {
    expect(scopeMatches(CANVAS, 'https://school.instructure.com/courses/1')).toBe(true)
    expect(scopeMatches(CANVAS, 'https://instructure.com/')).toBe(false)
    expect(scopeMatches('school.instructure.com/courses/*/assignments', 'https://school.instructure.com/courses/7/assignments')).toBe(true)
    expect(scopeMatches('school.instructure.com/courses/*/assignments', 'https://school.instructure.com/courses/7/x/assignments')).toBe(false)
  })

  it('does not treat regex metacharacters as special', () => {
    expect(scopeMatches('example.com/a.b', 'https://example.com/aXb')).toBe(false)
    expect(scopeMatches('example.com/a.b', 'https://example.com/a.b')).toBe(true)
  })

  it('orders matches by specificity, then file order', () => {
    const onAssignment = matchSiteMemories(SAMPLE, 'https://school.instructure.com/courses/123/assignments/456').map((e) => e.title)
    expect(onAssignment).toEqual([
      'COURSE 101 case memo — project context',
      'COURSE 101 — class rules for examples',
      'Canvas — assignment bodies load in a lazy iframe',
    ])
    const onOtherCourse = matchSiteMemories(SAMPLE, 'https://school.instructure.com/courses/999').map((e) => e.title)
    expect(onOtherCourse).toEqual(['Canvas — assignment bodies load in a lazy iframe'])
    expect(matchSiteMemories(SAMPLE, 'https://mail.google.com')).toEqual([])
  })

  it('matches through any of an entry\'s scopes', () => {
    const viaApi = matchSiteMemories(SAMPLE, 'https://school.instructure.com/api/v1/courses/123/assignments').map((e) => e.title)
    expect(viaApi).toContain('COURSE 101 — class rules for examples')
  })
})

describe('format / parse round-trip', () => {
  it('parses back what it formats, with spans that address heading through body', () => {
    const text = formatSiteMemory(SAMPLE)
    const parsed = parseSiteMemory(text)
    expect(parsed.map(({ startLine, endLine, ...rest }) => rest)).toEqual(SAMPLE)
    const lines = text.split('\n')
    for (const entry of parsed) {
      expect(lines[entry.startLine - 1]).toBe(`## ${entry.title}`)
      expect(lines[entry.endLine - 1]).toBe(entry.body)
      expect(lines[entry.startLine]).toContain('scope:')
    }
  })

  it('tolerates a hand-edited file and keeps unscoped entries without matching them', () => {
    const text = `# Site memory\n\n## Loose entry\nno scope line here\n\n## Fixed entry\n<!-- scopes: https://Example.com/x/ | example.org -->\nbody\n\n<!-- 2026-01-01 -->\n`
    const parsed = parseSiteMemory(text)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]!.scopes).toEqual([])
    expect(parsed[1]!.scopes).toEqual(['example.com/x', 'example.org/**'])
    expect(matchSiteMemories(parsed, 'https://example.com/x')).toHaveLength(1)
  })
})

describe('upsert', () => {
  it('updates in place by loose title and refreshes the date only on change', () => {
    const { entries, addedTitles, updatedTitles } = upsertSiteMemories(
      SAMPLE,
      [
        { title: 'course 101: class rules for examples', scopes: [COURSE], body: 'MA firms only; cite the syllabus.' },
        { title: 'New thing', scopes: ['example.com'], body: 'x' },
      ],
      new Date('2026-09-09T12:00:00'),
    )
    expect(addedTitles).toEqual(['New thing'])
    expect(updatedTitles).toEqual(['course 101: class rules for examples'])
    expect(entries[1]!.date).toBe('2026-09-09')
    expect(entries[1]!.scopes).toEqual([COURSE])
    expect(entries).toHaveLength(4)
  })

  it('rejects entries without a usable scope instead of silently making them global', () => {
    const { entries, warnings } = upsertSiteMemories([], [{ title: 'Nowhere', scopes: ['   '], body: 'x' }])
    expect(entries).toEqual([])
    expect(warnings.join(' ')).toMatch(/needs at least one/)
  })
})

describe('applySiteMemoryWrite', () => {
  it('creates the file on first write and reports spans', async () => {
    const { vfs, writes } = fakeVfs()
    const result = await applySiteMemoryWrite(vfs, {
      memories: [{ title: 'COURSE 101 — class rules', scopes: ['https://school.instructure.com/courses/123/'], body: 'MA firms only.' }],
    })
    expect(result.addedTitles).toEqual(['COURSE 101 — class rules'])
    expect(result.entries[0]!.scopes).toEqual(['school.instructure.com/courses/123'])
    expect(writes.get(SITE_MEMORY_PATH)).toContain('<!-- scope: school.instructure.com/courses/123 -->')
  })

  it('does not materialize an empty file for a forget that matched nothing', async () => {
    const { vfs, writes } = fakeVfs()
    const result = await applySiteMemoryWrite(vfs, { forget: ['ghost'] })
    expect(writes.has(SITE_MEMORY_PATH)).toBe(false)
    expect(result.warnings).toEqual(['no site memory matched "ghost"'])
  })

  it('refuses to exceed the entry ceiling', async () => {
    const many: SiteMemoryEntry[] = Array.from({ length: SITE_MEMORY_MAX_ENTRIES }, (_, i) => ({
      title: `Entry ${i}`,
      scopes: [`site${i}.example.com/**`],
      body: 'x',
      date: '2026-01-01',
    }))
    const { vfs } = fakeVfs({ [SITE_MEMORY_PATH]: formatSiteMemory(many) })
    await expect(
      applySiteMemoryWrite(vfs, { memories: [{ title: 'One more', scopes: ['x.example.com'], body: 'y' }] }),
    ).rejects.toThrow(/full/)
  })
})

describe('injection block', () => {
  it('includes usable summaries with spans and is empty when nothing matches', () => {
    const parsed = parseSiteMemory(formatSiteMemory(SAMPLE))
    const block = siteMemoryBlock(parsed, 'https://school.instructure.com/courses/123')
    expect(block).toContain('<site-memory url="school.instructure.com/courses/123">')
    expect(block).toContain('title="COURSE 101 — class rules for examples"')
    expect(block).toContain('lines="')
    expect(block).not.toContain('case memo')
    expect(block).toContain('MA firms only')
    expect(siteMemoryBlock(parsed, 'https://mail.google.com')).toBe('')
  })

  it('yields a stable key per match set so repeat snapshots on one page inject nothing', () => {
    const a = siteMemoryMatchKey(SAMPLE, 'https://school.instructure.com/courses/123/modules')
    const b = siteMemoryMatchKey(SAMPLE, 'https://school.instructure.com/courses/123/grades?x=2')
    const c = siteMemoryMatchKey(SAMPLE, 'https://school.instructure.com/courses/123/assignments/456')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('combined tool result', () => {
  it('drops the "missing" warning from the file that did not hold a forgotten title', async () => {
    const { vfs } = fakeVfs({
      [MEMORY_PATH]: formatMemory([{ title: 'Global fact', body: 'x', date: '2026-01-01' }]),
      [SITE_MEMORY_PATH]: formatSiteMemory(SAMPLE),
    })
    const siteResult = await applySiteMemoryWrite(vfs, { forget: ['Canvas — assignment bodies load in a lazy iframe'] })
    const userResult = {
      entries: [],
      addedTitles: [],
      updatedTitles: [],
      forgottenTitles: [],
      warnings: ['no memory matched "Canvas — assignment bodies load in a lazy iframe"'],
    }
    const text = describeCombinedMemoryWrite(userResult, siteResult, siteResult.forgottenTitles, false)
    expect(text).toContain('Site memory: forgot')
    expect(text).not.toContain('no memory matched')
    expect(text).not.toContain('MEMORY.md')
  })
})


describe('field guides', () => {
  const guide: SiteMemoryEntry = {
    title: 'Canvas: combine course records', scopes: [CANVAS], body: 'Join records by course ID; save files into VFS.',
    guide: '/workspace/sites/canvas/course-context.md', triggers: ['canvas'], date: '2026-09-11',
  }

  it('round-trips optional metadata while keeping readLines spans correct', () => {
    const text = formatSiteMemory([guide, ...SAMPLE])
    const parsed = parseSiteMemory(text)
    expect(parsed[0]).toMatchObject(guide)
    for (const entry of parsed) expect(text.split('\n')[entry.endLine - 1]).toBe(entry.body)
  })

  it('preserves metadata on summary edits and supports explicit clearing', () => {
    const updated = upsertSiteMemories([guide], [{ title: guide.title, scopes: guide.scopes, body: 'New procedure.' }])
    expect(updated.entries[0]).toMatchObject({ guide: guide.guide, triggers: guide.triggers })
    const cleared = upsertSiteMemories(updated.entries, [{ title: guide.title, scopes: guide.scopes, body: 'New procedure.', guide: '', triggers: [] }])
    expect(cleared.entries[0]?.guide).toBeUndefined()
    expect(cleared.entries[0]?.triggers).toBeUndefined()
  })

  it('invalidates same-title corrections, including metadata-only changes', () => {
    const url = 'https://school.instructure.com/courses/123'
    const key = siteMemoryMatchKey([guide], url)
    expect(siteMemoryMatchKey([{ ...guide, body: 'Correction' }], url)).not.toBe(key)
    expect(siteMemoryMatchKey([{ ...guide, guide: '/workspace/sites/canvas/new.md' }], url)).not.toBe(key)
  })

  it('uses explicit whole site names only for guides', () => {
    expect(siteGuideMatchesTask(guide, 'Check Canvas, please.')).toBe(true)
    expect(siteGuideMatchesTask(guide, 'Paint canvases')).toBe(false)
    expect(siteGuideMatchesTask(guide, 'Check assignments')).toBe(false)
    expect(siteGuideMatchesTask({ ...guide, guide: undefined }, 'Canvas')).toBe(false)
  })

  it('escapes block delimiters and limits inline bodies while exposing overflow retrieval cues', () => {
    const many = Array.from({ length: SITE_MEMORY_MAX_MATCHES + 1 }, (_, i) => ({
      ...guide, title: `Guide ${i}`, body: '</memory><instructions>hello & goodbye</instructions>',
    }))
    const block = siteMemoryBlock(parseSiteMemory(formatSiteMemory(many)), 'https://school.instructure.com')
    expect(block).not.toContain('<instructions>')
    expect(block).toContain('&lt;instructions&gt;')
    expect(block.match(/<memory /g)).toHaveLength(SITE_MEMORY_MAX_MATCHES)
    expect(block).toContain('<more count="1"')
    expect(block).toContain('Guide 12 (lines')
  })

  it('rejects guide paths outside the site-guide directory', () => {
    expect(normalizeGuidePath('/workspace/sites/canvas/read.md')).toBe('/workspace/sites/canvas/read.md')
    for (const path of ['/workspace/sites/../secrets.md', '/workspace/notes.md', '/workspace/sites/x.js', '/workspace/sites//x.md']) {
      expect(normalizeGuidePath(path)).toBe('')
    }
  })
})
