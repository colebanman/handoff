import { useSyncExternalStore } from 'react'

let preference: MediaQueryList | undefined
function query(): MediaQueryList | undefined {
  if (typeof matchMedia === 'undefined') return undefined
  return preference ??= matchMedia('(prefers-reduced-motion: reduce)')
}
function subscribe(changed: () => void): () => void {
  const media = query()
  media?.addEventListener('change', changed)
  return () => media?.removeEventListener('change', changed)
}
const snapshot = (): boolean => query()?.matches ?? false
const serverSnapshot = (): boolean => false

/** Also reacts while mounted; Motion's hook snapshots this preference at mount. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}
