export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  if (err === undefined) return 'undefined'
  if (err === null) return 'null'

  try {
    const json = JSON.stringify(err, errorReplacer(), 2)
    if (json && json !== '{}') return json
  } catch {
    // Fall through to object inspection below.
  }

  if (typeof err === 'object') {
    const proto = Object.getPrototypeOf(err) as { constructor?: { name?: string } } | null
    const name = proto?.constructor?.name
    return name && name !== 'Object' ? `[${name}]` : String(err)
  }

  return String(err)
}

/**
 * Max chars of an HTTP error body kept in a log line. Server error payloads are
 * normally a short JSON object; the cap only guards against an HTML error page.
 */
const ERROR_BODY_MAX_CHARS = 600

/**
 * Pull the server's own explanation out of an AI SDK `APICallError`.
 *
 * The SDK builds `message` from the HTTP status alone, so a provider that
 * explains itself in the body — a local server answering `{"detail": "prompt is
 * 45231 tokens, over the served limit of 32768"}` — reaches the debug log as a
 * bare "Bad Request", which is indistinguishable from every other 400. Duck-typed
 * rather than `instanceof APICallError`: the error crosses a bundle boundary, so
 * the class identity is not dependable.
 */
function apiErrorDetail(err: Error): string {
  const e = err as Error & { statusCode?: unknown; responseBody?: unknown }
  const status = typeof e.statusCode === 'number' ? e.statusCode : undefined
  const body = typeof e.responseBody === 'string' ? e.responseBody.trim() : ''
  if (status === undefined && !body) return ''

  let detail = body
  if (body) {
    // FastAPI puts it in `detail`; OpenAI-shaped servers use `error.message`.
    // Anything else falls back to the raw body.
    try {
      const parsed = JSON.parse(body) as { detail?: unknown; error?: { message?: unknown } }
      const found = parsed?.error?.message ?? parsed?.detail
      if (typeof found === 'string' && found.trim()) detail = found.trim()
      else if (found !== undefined) detail = JSON.stringify(found)
    } catch {
      // Not JSON — keep the raw body.
    }
  }
  if (detail.length > ERROR_BODY_MAX_CHARS) {
    detail = `${detail.slice(0, ERROR_BODY_MAX_CHARS)}… [+${detail.length - ERROR_BODY_MAX_CHARS} chars]`
  }
  const parts = [status === undefined ? '' : `HTTP ${status}`, detail].filter(Boolean)
  return parts.length > 0 ? `\n${parts.join(' — ')}` : ''
}

export function formatErrorWithStack(err: unknown): string {
  if (err instanceof Error) {
    const stack = err.stack ? '\n' + err.stack.split('\n').slice(0, 4).join('\n') : ''
    return `${err.message || err.name}${apiErrorDetail(err)}${stack}`
  }
  return formatError(err)
}

function errorReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key, value) => {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack?.split('\n').slice(0, 4).join('\n'),
      }
    }
    if (typeof value === 'bigint') return `${value}n`
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  }
}
