/**
 * Cross-context VFS change feed. Writes happen in whichever document owns the
 * IndexedDB call (offscreen runtime, side panel, artifact viewer); every other
 * extension context hears about them over a BroadcastChannel. Kept separate
 * from vfs.ts so the service worker can subscribe without bundling the
 * document/PDF extraction libraries.
 */

import { debugLog } from '../shared/debug-log'

export interface VfsChange {
  path: string
  action: 'write' | 'delete'
  /** True when the write created the file (vs updating it). */
  created?: boolean
  at: number
}

type VfsChangeListener = (change: VfsChange) => void

const changeListeners = new Set<VfsChangeListener>()
let changeChannel: BroadcastChannel | undefined

function ensureChangeChannel(): BroadcastChannel | undefined {
  if (!changeChannel && typeof BroadcastChannel !== 'undefined') {
    changeChannel = new BroadcastChannel('handoff-vfs-changes-v1')
    changeChannel.onmessage = (event: MessageEvent<VfsChange>) => notifyVfsChange(event.data)
  }
  return changeChannel
}

export function subscribeVfsChanges(listener: VfsChangeListener): () => void {
  ensureChangeChannel()
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

export function emitVfsChange(change: VfsChange): void {
  ensureChangeChannel()?.postMessage(change)
  notifyVfsChange(change)
}

function notifyVfsChange(change: VfsChange): void {
  for (const listener of changeListeners) {
    try {
      listener(change)
    } catch (err) {
      debugLog.error('storage', 'vfs change listener', err)
    }
  }
}
