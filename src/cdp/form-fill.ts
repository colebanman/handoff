import { abortableDelay, throwIfAborted } from '../shared/abort'
import { formFieldsSchema, type FormField, type FormFillResult } from '../shared/form-fill'
import { createFormSession } from './form-page'

export interface FormTransport {
  resolve(ref: string): number
  send<T = unknown>(method: string, params?: object): Promise<T>
  click(backendNodeId: number): Promise<void>
  type(backendNodeId: number, text: string, clear: boolean): Promise<void>
}
interface RemoteResult { result?: { objectId?: string; value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
interface FieldState { kind: string; satisfied: boolean; expanded?: boolean; searchable?: boolean; clearQuery?: boolean }

/** Host-side control loop. No model turns, no full snapshots/ref-map mutation,
 * and no global settle delay. Each uncertain write is attempted at most once. */
export async function fillForm(transport: FormTransport, fields: FormField[], signal?: AbortSignal, timeoutMs = 2_000): Promise<FormFillResult> {
  formFieldsSchema.parse(fields)
  throwIfAborted(signal)
  const result: FormFillResult = { ok: false, fields: fields.map(({ ref }) => ({ ref, status: 'unattempted' })) }
  const objectGroup = `form-${crypto.randomUUID()}`
  let session: string | undefined
  const send = async <T>(method: string, params?: object) => { throwIfAborted(signal); return transport.send<T>(method, params) }
  const unwrap = (r: RemoteResult) => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text ?? 'Form inspection failed')
    return r.result
  }
  const call = async <T>(method: string, index?: number, byValue = true) => {
    const r = unwrap(await send<RemoteResult>('Runtime.callFunctionOn', {
      objectId: session, functionDeclaration: 'function(method,index){return this[method](index)}',
      arguments: [{ value: method }, { value: index }], returnByValue: byValue, objectGroup,
    }))
    return (byValue ? r?.value : r?.objectId) as T
  }
  const backend = async (objectId: string) => {
    const r = await send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId })
    return r.node.backendNodeId
  }
  const wait = async <T>(read: () => Promise<T>, ready: (value: T) => boolean, failure: string): Promise<T> => {
    const deadline = Date.now() + timeoutMs
    do {
      const value = await read()
      if (ready(value)) return value
      if (Date.now() >= deadline) break
      await abortableDelay(25, signal)
    } while (true)
    throw new Error(failure)
  }
  let index = 0
  try {
    // Resolve every supplied ref before touching the page, including later ones.
    const ids = fields.map(f => transport.resolve(f.ref))
    const objects: string[] = []
    for (const backendNodeId of ids) {
      const r = await send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId, objectGroup })
      if (!r.object?.objectId) throw new Error('Field no longer resolves to a DOM element')
      objects.push(r.object.objectId)
    }
    session = unwrap(await send<RemoteResult>('Runtime.callFunctionOn', {
      objectId: objects[0], functionDeclaration: createFormSession.toString(),
      arguments: [{ value: fields }, ...objects.map(objectId => ({ objectId }))], objectGroup, returnByValue: false,
    }))?.objectId
    if (!session) throw new Error('Could not inspect this form')
    for (; index < fields.length; index++) {
      const field = fields[index]!, entry = result.fields[index]!
      const prepared = await call<FieldState>('prepare', index)
      if (!prepared.satisfied) {
        const objectId = await call<string>('node', index, false)
        const id = await backend(objectId)
        throwIfAborted(signal)
        entry.status = 'uncertain'
        if ('text' in field) await transport.type(id, field.text, field.clear ?? true)
        else if ('checked' in field) await transport.click(id)
        else if (prepared.kind === 'native-select') await call('nativeSelect', index)
        else {
          if (prepared.searchable) {
            // Native editing focuses the combobox and opens/filters its owned
            // popup. Verification later reads the committed value, not this query.
            // Backspace on an empty React Select query can clear its committed
            // value (and trigger application callbacks). Only clear real text.
            await transport.type(id, field.select, prepared.clearQuery ?? true)
          } else if (!prepared.expanded) {
            const target = prepared.kind === 'combobox' ? await backend(await call<string>('actionNode', index, false)) : id
            throwIfAborted(signal)
            await transport.click(target)
          }
          const option = await wait(() => call<string | undefined>('option', index, false), Boolean,
            'No unique ready option appeared for this field; selection was not verified')
          const optionId = await backend(option!)
          throwIfAborted(signal)
          await transport.click(optionId)
        }
        await wait(() => call<FieldState>('verify', index), s => s.satisfied, 'Field value was not confirmed after the action')
      }
      entry.status = 'verified'
      // Re-read earlier answers before advancing: another field can reset them.
      const audit = await call<{ unconfirmed: number[]; changed: boolean }>('audit', index + 1)
      for (const done of audit.unconfirmed) {
        result.fields[done]!.status = 'uncertain'
        result.fields[done]!.reason = 'Previously verified value changed'
      }
      if (audit.unconfirmed.length) throw new Error('A previously verified field changed; inspect before continuing')
      if (audit.changed) throw new Error('Form structure changed; inspect new or changed fields before continuing')
    }
    result.ok = true
  } catch (error) {
    throwIfAborted(signal)
    result.stopped = error instanceof Error ? error.message : String(error)
    const entry = result.fields[index]
    if (entry && entry.status !== 'verified') entry.reason = result.stopped
  } finally {
    // Resource cleanup is allowed after cancellation; never dispatch an input.
    try { await transport.send('Runtime.releaseObjectGroup', { objectGroup }) } catch { /* navigation may have released it already */ }
  }
  return result
}
