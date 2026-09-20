/**
 * UI composition root. File-preview helpers stay local; TabShot capture and
 * live agent execution use the durable service-worker host.
 *
 * The UI holds a single lazy singleton via getRuntime() so the panel wires the
 * whole stack up exactly once regardless of how many React components ask for it.
 */
import { createVirtualFileSystemService } from './storage/vfs'
import type { VirtualFileSystemService } from './shared/types'
import type { AgentRuntime } from './agent'
import { debugLog } from './shared/debug-log'
import { createAgentClient, type ExecutionClient } from './ui/agent-client'

export interface Runtime {
  vfs: VirtualFileSystemService
  agent: AgentRuntime
  executions: ExecutionClient
}

export function createRuntime(): Runtime {
  const vfs = createVirtualFileSystemService()
  const remote = createAgentClient()
  const agent = remote.agent
  // Bundled skills are seeded by the execution host, once per shared runtime.
  debugLog.log('ui', 'runtime created')
  return { vfs, agent, executions: remote.executions }
}

let singleton: Runtime | undefined

/** Lazily build (once) and return the shared runtime. */
export function getRuntime(): Runtime {
  if (!singleton) singleton = createRuntime()
  return singleton
}

/** The runtime if one has been built, without triggering construction. */
export function peekRuntime(): Runtime | undefined {
  return singleton
}
