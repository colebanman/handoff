import type { VirtualFileSystemService, VfsEntry } from '../shared/types'

async function digest(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer()
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Keep an existing attachment intact when another dropped file has its name. */
export async function importAttachment(vfs: VirtualFileSystemService, file: File): Promise<VfsEntry> {
  const name = file.name.split(/[\\/]/).pop() || `file-${Date.now()}`
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  let incomingHash: string | undefined

  for (let index = 0; ; index += 1) {
    const candidate = index === 0 ? name : `${stem} (${index})${extension}`
    const path = `/workspace/attachments/${candidate}`
    const existing = await vfs.getEntry(path)
    if (!existing) return vfs.putFile('workspace', file, `attachments/${candidate}`)
    if (existing.size !== file.size) continue
    incomingHash ??= await digest(file)
    if (incomingHash === await digest(await vfs.blob(path))) return existing
  }
}
