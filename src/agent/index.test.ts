import { afterEach, expect, it, vi } from 'vitest'
import { createAgentRuntime, type AgentDeps } from './index'
import { getActiveTabId, runLoop } from './run'
import { browserContextMetadata } from '../shared/browser-context'
import { DEFAULT_SETTINGS } from '../shared/types'
import { resetSharedSurfaceAssignments, sharedSurfaceAssignments, tabSurface } from './surfaces'

vi.mock('./run', () => ({ runLoop: vi.fn(), getActiveTabId: vi.fn(async () => 100) }))
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); resetSharedSurfaceAssignments() })

function setup() {
  vi.stubGlobal('chrome', { storage: { session: { get: async () => ({}), onChanged: { addListener: vi.fn() } } } })
  return createAgentRuntime({ cdp: {}, vfs: {}, sandbox: {} } as AgentDeps)
}
const options = (chatId: string) => ({ chatId, settings: DEFAULT_SETTINGS, signal: new AbortController().signal,
  onEvent: vi.fn(), messages: [{ role: 'user', content: 'Read this page', ...browserContextMetadata(42) }],
})

it('initializes from captured context and gives concurrent main chats distinct ownership identities', async () => {
  const runtime = setup()
  const owners: string[] = []
  vi.mocked(runLoop).mockImplementation(async ({ ctx }) => {
    expect(ctx.currentTabId).toBe(42)
    expect(ctx.agentId).toBe('main') // UI/event identity stays compatible.
    owners.push(ctx.surfaceOwnerId!)
    return { responseMessages: [], text: 'Done', stepCount: 1 }
  })
  await Promise.all([runtime.runTurn(options('a')), runtime.runTurn(options('b'))])
  expect(getActiveTabId).not.toHaveBeenCalled()
  expect(new Set(owners).size).toBe(2)
})

it('releases a main run claim after failure so a later run is not stranded', async () => {
  const runtime = setup()
  vi.mocked(runLoop).mockImplementation(async ({ ctx }) => {
    sharedSurfaceAssignments().beginUse(ctx.surfaceOwnerId!, [tabSurface(42)])()
    throw new Error('Provider disconnected')
  })
  await expect(runtime.runTurn(options('a'))).rejects.toThrow('Provider disconnected')
  expect(sharedSurfaceAssignments().ownerOf(tabSurface(42))).toBeUndefined()
})
