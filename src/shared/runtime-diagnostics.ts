import { uid } from './ids'
import { redactSecrets } from './redact'

export interface DiagnosticOperation {
  id: string
  kind: 'model' | 'sandbox' | 'api' | 'cdp' | 'overlay' | 'vfs'
  label: string
  stage: string
  startedAt: number
  updatedAt: number
  /** Last useful output, distinct from metadata/heartbeat traffic. */
  lastProgressAt?: number
  chatId?: string
  agentId?: string
  tabId?: number
  parentId?: string
  timeoutMs?: number
  idleTimeout?: boolean
  detail?: string
  error?: string
  endedAt?: number
}
const pending = new Map<string, DiagnosticOperation>()
const recent: DiagnosticOperation[] = []
const clean = (text: string, max = 400) => redactSecrets(text).replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
  try { const url = new URL(value); return `${url.origin}${url.pathname}` } catch { return value }
}).slice(0, max)

/** A bounded in-memory view of real pending work. Never records request bodies or results. */
export function beginDiagnosticOperation(kind: DiagnosticOperation['kind'], label: string, context: Partial<DiagnosticOperation> = {}) {
  const now = Date.now()
  const operation: DiagnosticOperation = { ...context, id: context.id ?? uid('op'), kind, label: clean(label, 140), stage: 'starting', startedAt: now, updatedAt: now, detail: context.detail ? clean(context.detail) : undefined }
  pending.set(operation.id, operation)
  if (pending.size > 100) pending.delete(pending.keys().next().value!)
  let finished = false
  return {
    id: operation.id,
    update(stage: string, values: Partial<Pick<DiagnosticOperation, 'timeoutMs' | 'detail' | 'lastProgressAt'>> = {}) {
      if (finished) return
      Object.assign(operation, values, { stage, updatedAt: Date.now() })
      if (operation.detail) operation.detail = clean(operation.detail)
    },
    finish(error?: unknown) {
      if (finished) return
      finished = true
      pending.delete(operation.id)
      recent.push({ ...operation, endedAt: Date.now(), error: error ? clean(error instanceof Error ? `${error.name}: ${error.message}` : String(error), 260) : undefined })
      if (recent.length > 40) recent.shift()
    },
  }
}
export function diagnosticOperations() {
  return { pending: [...pending.values()].map((item) => ({ ...item })), recent: recent.map((item) => ({ ...item })) }
}

export interface DiagnosticEvent { type: string; at: number; agentId?: string; toolId?: string; detail?: string; chars?: number }
