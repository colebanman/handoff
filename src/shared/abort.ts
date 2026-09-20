/** Canonical abort error/checks shared across agent, sandbox and RPC layers. */
export function abortError(reason = 'Operation cancelled'): DOMException {
  return new DOMException(reason, 'AbortError')
}

export function throwIfAborted(signal?: AbortSignal, reason?: string): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError(reason)
}

/** Wait without leaving a timer alive after cancellation. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Reject promptly on abort while still observing the underlying promise. */
export function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  if (!signal) return operation
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason instanceof Error ? signal.reason : abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
