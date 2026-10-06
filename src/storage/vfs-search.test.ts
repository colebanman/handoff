import { expect, it, vi } from 'vitest'
vi.mock('./pdf', () => ({ extractPdfText: vi.fn(), renderPdfPage: vi.fn() }))
import { createVirtualFileSystemService } from './vfs'

it('applies a folder restriction before a search result limit, including with many other matching files', async () => {
  const vfs = createVirtualFileSystemService()
  const files = Array.from({ length: 250 }, (_, index) => ({ root: 'workspace', path: `/workspace/other/${index}.txt` }))
  files.push({ root: 'workspace', path: '/workspace/requested/answer.txt' })
  Object.assign(vfs, { allFiles: async () => files, fullText: async () => 'A matching record' })
  await expect(vfs.search('record', { root: 'workspace', prefix: '/workspace/requested', maxResults: 1 })).resolves.toEqual([
    { path: '/workspace/requested/answer.txt', lines: ['1: A matching record'] },
  ])
})
