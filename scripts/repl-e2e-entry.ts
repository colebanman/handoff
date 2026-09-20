// Only bundled with HANDOFF_REPL_E2E=1. Tests use the real VFS, RPC, sandbox,
// context delivery, and dispatcher; no alternate implementation of functions.
import { createVirtualFileSystemService } from '../src/storage/vfs'
import { createSandboxService } from '../src/sandbox/host'
import { createCdpService } from '../src/cdp'
import { RuntimeContextDelivery } from '../src/agent/runtime-context'
import { OpenAICompaction } from '../src/agent/compaction'
import { runLoop } from '../src/agent/run'
import { DEFAULT_SETTINGS } from '../src/shared/types'

export function harness() {
  const vfs = createVirtualFileSystemService(), cdp = createCdpService()
  return { vfs, cdp, sandbox: createSandboxService(cdp, vfs) }
}

Object.assign(globalThis, { __replE2E: { harness, RuntimeContextDelivery, OpenAICompaction, runLoop, DEFAULT_SETTINGS } })
