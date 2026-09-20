/**
 * Load a VFS image as a data URL for rendering (attachment embeds in the
 * transcript). Results are cached per path so re-renders and repeated mounts
 * of the same embed don't re-read storage.
 */
import { useEffect, useState } from 'react'
import { getRuntime } from '../../runtime'
import { debugLog } from '../../shared/debug-log'

const MAX_CACHED = 48
const cache = new Map<string, string>()

function remember(path: string, url: string): void {
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(path, url)
}

export interface VfsImageState {
  src?: string
  /** True once loading failed (e.g. the file was deleted from the workspace). */
  failed: boolean
}

export function useVfsImage(path: string): VfsImageState {
  const [result, setResult] = useState<VfsImageState>(() => ({ src: cache.get(path), failed: false }))

  useEffect(() => {
    const cached = cache.get(path)
    if (cached) {
      setResult({ src: cached, failed: false })
      return
    }
    let cancelled = false
    setResult({ src: undefined, failed: false })
    getRuntime()
      .vfs.dataUrl(path)
      .then((url) => {
        remember(path, url)
        if (!cancelled) setResult({ src: url, failed: false })
      })
      .catch((err) => {
        debugLog.error('ui', `load attachment image ${path}`, err)
        if (!cancelled) setResult({ src: undefined, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [path])

  return result
}
