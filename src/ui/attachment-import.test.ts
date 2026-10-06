import { describe, expect, it, vi } from 'vitest'
import type { VfsEntry, VirtualFileSystemService } from '../shared/types'
import { importAttachment } from './attachment-import'

function file(name: string, contents: string): File {
  return new File([contents], name, { type: 'text/plain' })
}

function fakeVfs() {
  const blobs = new Map<string, Blob>()
  const entries = new Map<string, VfsEntry>()
  const vfs = {
    getEntry: vi.fn(async (path: string) => entries.get(path)),
    blob: vi.fn(async (path: string) => blobs.get(path)!),
    putFile: vi.fn(async (_root: string, uploaded: File, relativePath: string) => {
      const path = `/workspace/${relativePath}`
      const entry = { path, name: relativePath.split('/').at(-1)!, root: 'workspace', size: uploaded.size, mediaType: uploaded.type } as VfsEntry
      entries.set(path, entry)
      blobs.set(path, uploaded)
      return entry
    }),
  }
  return vfs
}

describe('importAttachment', () => {
  it('reuses an identical file with the same name without writing it again', async () => {
    const vfs = fakeVfs()
    const first = await importAttachment(vfs as unknown as VirtualFileSystemService, file('report.txt', 'same'))
    const second = await importAttachment(vfs as unknown as VirtualFileSystemService, file('report.txt', 'same'))
    expect(second).toBe(first)
    expect(vfs.putFile).toHaveBeenCalledTimes(1)
  })

  it('keeps different contents at unique names and reuses the matching variant', async () => {
    const vfs = fakeVfs()
    await importAttachment(vfs as unknown as VirtualFileSystemService, file('report.txt', 'first'))
    const variant = await importAttachment(vfs as unknown as VirtualFileSystemService, file('report.txt', 'other'))
    expect(variant.path).toBe('/workspace/attachments/report (1).txt')
    expect((await vfs.blob('/workspace/attachments/report.txt')).text()).resolves.toBe('first')
    const reused = await importAttachment(vfs as unknown as VirtualFileSystemService, file('report.txt', 'other'))
    expect(reused.path).toBe(variant.path)
    expect(vfs.putFile).toHaveBeenCalledTimes(2)
  })
})
