import type { ModelMessage } from 'ai'
import type { AgentEvent, Usage } from '../shared/types'
import { uid } from '../shared/ids'
import { abortable, throwIfAborted } from '../shared/abort'
import { reconcileReplContext } from '../shared/repl-context'

export const COMPACTION_RATIO = 0.4

type Item = Record<string, unknown>
interface Checkpoint {
  modelId: string
  scope?: string
  output: Item[]
  tokens: number
}

// Checkpoints live alongside the complete transcript so rewind and switching
// providers still work. Only this transport consumes them; never send them as text.
function checkpoint(message: ModelMessage): Checkpoint | undefined {
  return message.providerOptions?.compaction?.checkpoint as unknown as Checkpoint | undefined
}

export function withoutCompaction(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => !checkpoint(message))
}

function estimate(value: unknown): number {
  // Approximate before the first usage report and for newly appended tool output.
  // Image bytes are not text tokens; reserve a conservative image allowance.
  return Math.ceil(JSON.stringify(value, (key, value) =>
    key === 'image_url' && typeof value === 'string' ? '[image]'.repeat(800) : value,
  ).length / 3)
}

export class OpenAICompaction {
  private prefix?: Checkpoint
  private lastEstimate?: number
  private measuredTokens?: number
  private preparedCommit?: (message: ModelMessage) => Promise<ModelMessage | undefined> | ModelMessage | void
  private retryBody?: { original: string; compacted: string }
  private streamed?: Checkpoint

  constructor(private readonly options: {
    modelId: string
    contextWindow: number
    agentId: string
    signal: AbortSignal
    emit: (event: AgentEvent) => void
    serverSide?: boolean
    scope?: string
    /** Small exact docs for the currently relevant personal functions. */
    replContext?: () => string | undefined
    browserContext?: () => string | undefined
  }) {}

  observeUsage(usage: Usage): void {
    if (this.streamed) return
    if (usage.inputTokens !== undefined) {
      this.measuredTokens = usage.inputTokens + (usage.outputTokens ?? 0)
    }
  }

  takeCheckpoint(): ModelMessage | undefined {
    const saved = this.streamed
    this.streamed = undefined
    if (!saved) return undefined
    this.measuredTokens = undefined
    return { role: 'user', content: '', providerOptions: { compaction: { checkpoint: saved as never } } }
  }

  prepare(messages: ModelMessage[], commit: (message: ModelMessage) => Promise<ModelMessage | undefined> | ModelMessage | void): ModelMessage[] {
    this.preparedCommit = commit
    this.retryBody = undefined
    this.prefix = undefined
    let start = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const saved = checkpoint(messages[i]!)
      if (saved?.modelId === this.options.modelId && saved.scope === this.options.scope) {
        this.prefix = saved
        start = i + 1
        break
      }
    }
    return withoutCompaction(messages.slice(start))
  }

  wrapFetch(base: typeof fetch): typeof fetch {
    return async (url, init) => {
      if (typeof init?.body !== 'string' || !String(url).endsWith('/responses')) return base(url, init)
      const original = init.body
      if (this.retryBody?.original === original) {
        return base(url, { ...init, body: this.retryBody.compacted })
      }
      const body = JSON.parse(original) as Item & { input: Item[] }
      if (!Array.isArray(body.input)) return base(url, init)
      const system = body.input.filter((item) => item.role === 'system' || item.role === 'developer')
      const suffix = body.input.filter((item) => item.role !== 'system' && item.role !== 'developer')
      const restore = (items: Item[]) => reconcileReplContext(items, this.options.replContext?.(), (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }))
      const restoreBrowser = (items: Item[]): Item[] => {
        const text = this.options.browserContext?.()
        return text ? [...items, { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] : items
      }
      const input = restore([...(this.prefix?.output ?? []), ...suffix])
      body.input = [...system, ...input]

      if (this.options.serverSide) {
        this.streamed = undefined
        body.context_management = [{ type: 'compaction', compact_threshold: Math.floor(this.options.contextWindow * COMPACTION_RATIO) }]
        let active: string | undefined
        const start = () => {
          if (!active) {
            active = uid('compact')
            this.options.emit({ type: 'compaction', agentId: this.options.agentId, id: active, status: 'running' })
          }
        }
        const end = (status: 'done' | 'cancelled' | 'error') => {
          if (active) this.options.emit({ type: 'compaction', agentId: this.options.agentId, id: active, status })
          active = undefined
        }
        // The server uses its rendered token count to decide whether to compact.
        // A local estimate can exceed the threshold on ordinary tool steps;
        // only a compaction output item means compaction has actually started.
        const onAbort = () => end('cancelled')
        const signal = init.signal ?? this.options.signal
        signal.addEventListener('abort', onAbort, { once: true })
        let response: Response
        try {
          response = await base(url, { ...init, body: JSON.stringify(body) })
        } catch (error) {
          signal.removeEventListener('abort', onAbort)
          end(signal.aborted ? 'cancelled' : 'error')
          throw error
        }
        if (!response.ok || !response.body) {
          signal.removeEventListener('abort', onAbort)
          end('error')
          return response
        }
        // The current AI SDK schema doesn't accept compaction output items.
        // Consume them here, keep their opaque payload, and forward all other SSE.
        const decoder = new TextDecoder()
        const encoder = new TextEncoder()
        let buffer = ''
        const frame = (raw: string): string => {
          const data = raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
          if (!data || data === '[DONE]') return raw
          const event = JSON.parse(data)
          if (event.item?.type === 'compaction') {
            start()
            if (event.type === 'response.output_item.done') {
              if (typeof event.item.encrypted_content !== 'string') throw new Error('OpenAI returned an invalid compaction item.')
              this.streamed = { modelId: this.options.modelId, scope: this.options.scope, output: restoreBrowser(restore([event.item])), tokens: estimate(restoreBrowser(restore([event.item]))) }
              end('done')
            }
            return ''
          }
          if (event.type === 'response.output_item.done' && this.streamed) {
            this.streamed.output.push(event.item)
            this.streamed.tokens += estimate(event.item)
          }
          if (event.type === 'response.completed' || event.type === 'response.incomplete') end('cancelled')
          if (event.type === 'error' || event.type === 'response.failed') end('error')
          return raw
        }
        const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, controller) => {
            buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n')
            let split: number
            try {
              while ((split = buffer.indexOf('\n\n')) !== -1) {
                const raw = buffer.slice(0, split)
                buffer = buffer.slice(split + 2)
                const forwarded = frame(raw)
                if (forwarded) controller.enqueue(encoder.encode(`${forwarded}\n\n`))
              }
            } catch (error) { end('error'); throw error }
          },
          flush: (controller) => {
            signal.removeEventListener('abort', onAbort)
            end('cancelled')
            if (buffer.trim()) controller.enqueue(encoder.encode(frame(buffer)))
          },
        }))
        return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
      }

      const overhead = estimate([system, body.tools ?? [], body.instructions ?? ''])
      const estimated = overhead + (this.prefix?.tokens ?? 0) + estimate(suffix)
      const tokens = Math.max(estimated, this.measuredTokens === undefined ? 0 :
        this.measuredTokens + Math.max(0, estimated - (this.lastEstimate ?? estimated)))
      this.lastEstimate = estimated
      // Do not immediately recompact an unchanged canonical window, even when
      // retained user messages leave it above the threshold.
      const threshold = Math.max(this.options.contextWindow * COMPACTION_RATIO,
        this.prefix ? overhead + this.prefix.tokens + this.options.contextWindow * 0.1 : 0)
      if (tokens >= threshold && suffix.length > 0) {
        const id = uid('compact')
        const { emit, agentId } = this.options
        const signal = AbortSignal.any([this.options.signal, ...(init.signal ? [init.signal] : []), AbortSignal.timeout(120_000)])
        emit({ type: 'compaction', agentId, id, status: 'running' })
        try {
          const instructions = [body.instructions, ...system.map((item) => item.content)]
            .filter(Boolean).map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join('\n\n')
          const response = await abortable(base(`${url}/compact`, {
            ...init, signal,
            body: JSON.stringify({ model: body.model, input, instructions }),
          }), signal)
          if (!response.ok) {
            // Keep the original history and stop the turn. Never silently fall
            // back to sending an overfull context or discard prior messages.
            throw new Error(`Conversation compaction failed (${response.status}). Please retry the turn.`)
          }
          const result = await abortable(response.json(), signal) as { output?: Item[]; usage?: { output_tokens?: number } }
          if (!Array.isArray(result.output) || !result.output.some((item) => item.type === 'compaction' && typeof item.encrypted_content === 'string')) {
            throw new Error('OpenAI returned an invalid compacted conversation. Please retry the turn.')
          }
          throwIfAborted(signal)
          const saved: Checkpoint = {
            modelId: this.options.modelId,
            scope: this.options.scope,
            output: restoreBrowser(restore(result.output)),
            tokens: (result.usage?.output_tokens ?? estimate(result.output)) + estimate(restoreBrowser(restore(result.output)).slice(result.output.length)),
          }
          // The entire returned window is canonical, including retained items.
          body.input = [...system, ...saved.output]
          const restored = await abortable(Promise.resolve(this.preparedCommit?.({
            role: 'user', content: '',
            providerOptions: { compaction: { checkpoint: saved as never } },
          })), signal)
          throwIfAborted(signal)
          if (restored && typeof restored.content === 'string') {
            body.input.push({ role: restored.role, content: restored.content })
          }
          this.prefix = saved
          this.measuredTokens = undefined
          this.lastEstimate = overhead + saved.tokens
          emit({ type: 'compaction', agentId, id, status: 'done' })
        } catch (error) {
          emit({ type: 'compaction', agentId, id, status: this.options.signal.aborted ? 'cancelled' : 'error' })
          throw error
        }
      }
      body.input = restore(body.input)
      const compacted = JSON.stringify(body)
      this.retryBody = { original, compacted }
      return base(url, { ...init, body: compacted })
    }
  }
}
