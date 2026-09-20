import { SANDBOX_DEFAULT_TIMEOUT_MS, SANDBOX_MAX_TIMEOUT_MS } from '../shared/rpc'
import { beginDiagnosticOperation } from '../shared/runtime-diagnostics'
import type {
  SandboxExecResult,
  SandboxService,
  TabScope,
  VirtualFileSystemService,
  VfsRoot,
} from '../shared/types'
import type { JsonValue } from '../shared/rpc'
import type { OffscreenRuntimeMessage, TabShotCaptureResult } from '../shared/execution-protocol'
import { debugLog } from '../shared/debug-log'
import { abortable, abortError, throwIfAborted } from '../shared/abort'
import { uid } from '../shared/ids'
import { createApiDispatch, type ApiDispatchExtras } from '../sandbox/api-dispatch'
import type { CdpService } from '../shared/types'

type Dispatch = (path: string, args: JsonValue[]) => Promise<JsonValue>
const READ_ONLY_FS = new Set(['list', 'summary', 'skills', 'stat', 'readText', 'extractText', 'readHtml', 'readLines', 'readBytes', 'dataUrl', 'search'].map(method => `fs.${method}`))

/** The caller owns the deadline: a frozen document cannot run its own timers. */
async function offscreenDeadline<T>(work: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await abortable(Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: offscreen runtime did not respond within ${ms}ms`)), ms)
    })]), signal)
  } finally { clearTimeout(timer) }
}

export interface BackgroundRuntimeServices {
  sandbox: SandboxService
  vfs: VirtualFileSystemService
  handleMessage(message: Partial<OffscreenRuntimeMessage>): Promise<unknown> | undefined
}

/**
 * DOM work stays in the offscreen document; privileged dispatch stays here.
 * The execId map is the capability boundary: once removed/cancelled, an old
 * sandbox realm cannot reach Chrome, CDP, fetch, or the filesystem.
 */
export function createBackgroundRuntimeServices(
  cdp: CdpService,
  ensureOffscreen: () => Promise<void>,
  extras?: ApiDispatchExtras,
): BackgroundRuntimeServices {
  const dispatches = new Map<string, Dispatch>()

  const callVfs = async <T>(method: string, args: unknown[], signal?: AbortSignal): Promise<T> => {
    const diagnostic = beginDiagnosticOperation('vfs', method)
    diagnostic.update('ensuring offscreen runtime', { timeoutMs: 10_000 })
    try {
      throwIfAborted(signal)
      await offscreenDeadline(ensureOffscreen(), 10_000, 'Starting file service', signal)
      throwIfAborted(signal)
      const requestId = uid('vfs')
      const onAbort = (): void => {
        void chrome.runtime.sendMessage({ target: 'offscreen', type: 'vfs.cancel', requestId } satisfies OffscreenRuntimeMessage).catch(() => {})
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const timeoutMs = method === 'importUrl' ? 65_000 : 35_000
        diagnostic.update('waiting for offscreen VFS', { timeoutMs })
        const response = await offscreenDeadline(chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'vfs.call',
          requestId,
          method,
          args,
        } satisfies OffscreenRuntimeMessage), timeoutMs, `VFS ${method}`) as { ok: boolean; value?: T; error?: string }
        throwIfAborted(signal)
        if (!response?.ok) throw new Error(response?.error ?? `offscreen VFS ${method} failed`)
        return response.value as T
      } catch (error) {
        onAbort()
        throw error
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    } catch (error) { diagnostic.finish(error); throw error }
    finally { diagnostic.finish() }
  }

  const vfs = {
    extensions: (operation, input, opts) => callVfs('extensions', [operation, input], opts?.signal),
    list: (root?: VfsRoot) => callVfs('list', [root]),
    summary: () => callVfs('summary', []),
    skills: () => callVfs('skills', []),
    putFile: async (root, file, relativePath) => {
      const base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
      return callVfs('putFileBase64', [root, file.name, file.type, base64, relativePath])
    },
    writeText: (path, text, opts) => callVfs('writeText', [path, text, stripSignal(opts)], opts?.signal),
    writeBase64: (path, base64, opts) => callVfs('writeBase64', [path, base64, stripSignal(opts)], opts?.signal),
    importUrl: (url, opts) => callVfs('importUrl', [url, stripSignal(opts)], opts?.signal),
    createSkill: (opts) => callVfs('createSkill', [stripSignal(opts)], opts.signal),
    delete: (path, opts) => callVfs('delete', [path], opts?.signal),
    getEntry: (path) => callVfs('getEntry', [path]),
    readText: (path, opts) => callVfs('readText', [path, opts]),
    readHtml: (path) => callVfs('readHtml', [path]),
    readLines: (path, opts) => callVfs('readLines', [path, opts]),
    readBytes: (path, opts) => callVfs('readBytes', [path, opts]),
    blob: async (path) => {
      const value = await callVfs<{ base64: string; mediaType: string }>('blobBase64', [path])
      const bytes = base64ToBytes(value.base64)
      const buffer = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(buffer).set(bytes)
      return new Blob([buffer], { type: value.mediaType })
    },
    dataUrl: (path) => callVfs('dataUrl', [path]),
    renderPdfPage: (path, opts) => callVfs('renderPdfPage', [path, stripSignal(opts)], opts?.signal),
    search: (query, opts) => callVfs('search', [query, opts]),
  } satisfies VirtualFileSystemService

  const sandbox: SandboxService = {
    async exec(opts): Promise<SandboxExecResult> {
      const idleMs = Math.min(Math.max(opts.timeoutMs ?? SANDBOX_DEFAULT_TIMEOUT_MS, 1000), SANDBOX_MAX_TIMEOUT_MS)
      const wallMs = Math.max(idleMs, opts.wallTimeoutMs ?? SANDBOX_MAX_TIMEOUT_MS) + 2000
      const diagnostic = beginDiagnosticOperation('sandbox', 'sandbox.exec', { chatId: opts.chatId, detail: `session=${opts.sessionId}` })
      diagnostic.update('ensuring offscreen runtime')
      try {
        throwIfAborted(opts.signal)
        await offscreenDeadline(ensureOffscreen(), 10_000, 'Starting code service', opts.signal)
        throwIfAborted(opts.signal)
        const execId = uid('remote-exec')
        const execution = new AbortController()
        const signal = opts.signal ? AbortSignal.any([opts.signal, execution.signal]) : execution.signal
        // This deadline stays armed through cleanup. Timing out only the
        // offscreen reply still hangs forever in the activeApi join below.
        const deadline = new AbortController()
        const wallTimer = setTimeout(() => {
          const error = new Error(`Code execution: offscreen runtime did not respond within ${wallMs}ms (including pending API calls)`)
          deadline.abort(error)
          execution.abort(error)
        }, wallMs)
        const dispatch = opts.dispatch ?? createApiDispatch(cdp, vfs, opts.scope, signal, { ...extras, chatId: opts.chatId })
        const activeApi = new Set<Promise<JsonValue>>()
        dispatches.set(execId, async (path, args) => {
          throwIfAborted(signal)
          const first = args[0]
          const tabId = typeof first === 'number' ? first : first && typeof first === 'object' && 'tabId' in first && typeof first.tabId === 'number' ? first.tabId : undefined
          const api = beginDiagnosticOperation('api', path, { chatId: opts.chatId, parentId: diagnostic.id, tabId,
            detail: /^(page\.(eval|snapshot|click)|cdp\.)/.test(path) ? JSON.stringify(args) : undefined })
          api.update('awaiting API result')
          const operation = (async () => {
            try {
              const pending = dispatch(path, args)
              // Reads can stop immediately. Give started mutations time to
              // settle on Stop, but never let an unresponsive adapter defeat
              // the execution's absolute deadline.
              const value = await abortable(pending, READ_ONLY_FS.has(path) ? signal : deadline.signal)
              throwIfAborted(signal)
              return value
            } catch (error) { api.finish(error); throw error }
            finally { api.finish() }
          })()
          activeApi.add(operation)
          void operation.then(() => activeApi.delete(operation), () => activeApi.delete(operation))
          return operation
        })
        const onAbort = (): void => {
          if (!dispatches.delete(execId)) return
          void chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'sandbox.cancel',
            execId,
            reason: signal.reason instanceof Error ? signal.reason.message : 'Sandbox execution cancelled',
          } satisfies OffscreenRuntimeMessage).catch(() => {})
        }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          diagnostic.update('awaiting sandbox result', { timeoutMs: wallMs, detail: `exec=${execId} session=${opts.sessionId} idle=${idleMs + 2000}ms wall=${wallMs}ms (host limits; API activity resets idle)` })
          const response = await abortable(chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'sandbox.exec',
            execId,
            code: opts.code,
            sessionId: opts.sessionId,
            timeoutMs: opts.timeoutMs,
            wallTimeoutMs: opts.wallTimeoutMs,
          } satisfies OffscreenRuntimeMessage), signal) as SandboxExecResult
          if (!response || typeof response.ok !== 'boolean') throw new Error('Code execution lost its offscreen runtime')
          if (!response.ok) execution.abort(new Error(response.error ?? 'Code execution failed'))
          return response
        } catch (error) {
          execution.abort(error)
          if (opts.signal?.aborted) throw opts.signal.reason ?? abortError()
          throw error
        } finally {
          dispatches.delete(execId)
          // Stop need not wait for a frozen document's reply. It must still
          // join an API mutation that already started before revocation.
          if (activeApi.size > 0) diagnostic.update('waiting for in-flight API calls')
          await Promise.allSettled([...activeApi])
          clearTimeout(wallTimer)
          signal.removeEventListener('abort', onAbort)
          execution.abort(abortError('Sandbox execution ended'))
          // A successful iframe reply does not make a hung API join successful.
          throwIfAborted(deadline.signal)
        }
      } catch (error) { diagnostic.finish(error); throw error }
      finally { diagnostic.finish() }
    },
  }

  return {
    sandbox,
    vfs,
    handleMessage(message) {
      if (message.target === 'background' && message.type === 'tabshot.capture') {
        // Capture through the same CDP instance used by agent tools: the tree
        // and its element-ref map must have the same owner across panel reloads.
        return (async (): Promise<TabShotCaptureResult> => {
          const tabId = message.tabId
          if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid TabShot tab id')
          const shot = await cdp.screenshot(tabId)
          try {
            return { shot, snapshot: await cdp.snapshot(tabId) }
          } catch (error) {
            // A page without an accessible tree can still provide an image.
            debugLog.error('cdp', 'TabShot snapshot', error)
            return { shot }
          }
        })()
      }
      if (message.target !== 'background' || message.type !== 'sandbox.api') return undefined
      const request = message as Extract<OffscreenRuntimeMessage, { type: 'sandbox.api' }>
      const dispatch = dispatches.get(request.execId)
      if (!dispatch) return Promise.reject(new Error('sandbox execution is cancelled or no longer active'))
      return dispatch(request.path, request.args)
    },
  }
}

function stripSignal<T extends object | undefined>(value: T): Omit<NonNullable<T>, 'signal'> | undefined {
  if (!value) return undefined
  const { signal: _signal, ...rest } = value as T & { signal?: AbortSignal }
  return rest
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
