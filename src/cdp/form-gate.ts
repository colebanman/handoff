import type { CdpService } from '../shared/types'

const exclusive = new Set(['fill', 'select'])
const tabOperations = new Set(['send', 'snapshot', 'click', 'type', 'pressKey', 'scroll', 'navigate', 'evalInPage',
  'attachFiles', 'selectorForRef', 'evalInFrame', 'clickInFrame', 'waitForLoad', 'screenshot', 'detach'])

/** Guard PUBLIC entrypoints, not internal calls on the implementation. This
 * covers built-in tools, raw sandbox CDP/eval, and saved REPL extensions alike.
 * Conflicting calls fail instead of queuing a stale action to run after a fill. */
export function guardFormActions(service: CdpService): CdpService {
  const active = new Map<number, { count: number; exclusive: boolean }>()
  return new Proxy(service, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      if (typeof key !== 'string' || !exclusive.has(key) && !tabOperations.has(key)) return value.bind(target)
      return async (...args: unknown[]) => {
        const tabId = args[0] as number, prior = active.get(tabId), isExclusive = exclusive.has(key)
        if (prior?.exclusive || isExclusive && prior?.count) throw new Error(`Tab ${tabId} has an in-flight browser operation; do not overlap form filling with other actions`)
        const lease = prior ?? { count: 0, exclusive: isExclusive }
        lease.count++; active.set(tabId, lease)
        try { return await Reflect.apply(value, target, args) }
        finally { if (--lease.count === 0) active.delete(tabId) }
      }
    },
  })
}
