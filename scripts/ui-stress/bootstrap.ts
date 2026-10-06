// Browser-only fixture. Never imported by, or built into, the extension.
// These are service boundaries, not replacements for UI components/reducers.
import { newMemoryState, type MemoryCommand, type MemorySnapshot } from '../../src/shared/continuity'
const memory: MemorySnapshot = { records: [], state: newMemoryState(), pending: 0 }
const event = () => ({ addListener() {}, removeListener() {}, hasListener() { return false } })
const storage: Record<string, unknown> = {}
const local = {
  async get(keys: string | string[] | null) {
    if (keys === null) return { ...storage }
    return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, storage[key]]))
  },
  async set(values: Record<string, unknown>) { Object.assign(storage, values) },
  async remove(keys: string | string[]) { for (const key of [keys].flat()) delete storage[key] },
}
Object.assign(globalThis, { chrome: {
  runtime: {
    id: 'ui-stress-fixture',
    getURL: (path: string) => new URL(path, location.origin).href,
    getManifest: () => ({ version: 'test' }),
    onMessage: event(),
    connect: () => ({ postMessage() {}, disconnect() {}, onMessage: event(), onDisconnect: event() }),
    sendMessage: async (message: { type?: string; payload?: MemoryCommand }) => {
      if (message.type === 'memory.command') {
        if (message.payload?.command === 'configure') memory.state.config = { ...message.payload.config }
        return { ok: true, value: structuredClone(memory) }
      }
      return { ok: true, value: [] }
    },
  },
  storage: { local, session: local, onChanged: event() },
  tabs: { query: async () => [], create: async () => ({}), update: async () => ({}), onActivated: event(), onUpdated: event() },
  windows: { getCurrent: async () => ({ id: 1 }) },
  permissions: { contains: async () => false },
  downloads: { download: async () => 1 },
} })
await import('./fixture')
