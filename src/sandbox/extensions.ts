import { validateValue, type ExtensionDraft, type ExtensionRevision, type ExtensionTestResult } from '../shared/extensions'
import type { JsonValue } from '../shared/rpc'

type Call = (path: string, args: JsonValue[]) => Promise<JsonValue>
type Binding = { tabId?: number; accountId?: string; origin?: string; url?: string }
type Exports = Record<string, unknown>
const factories = new Map<string, (module: { exports: Exports }, exports: Exports) => void>()

function compile(source: string, id: string): Exports {
  const key = `${id}\n${source}`
  let factory = factories.get(key)
  if (!factory) {
    factory = new Function('module', 'exports', `"use strict";\n${source}\n//# sourceURL=repl-extension-${id}.js`) as (module: { exports: Exports }, exports: Exports) => void
    if (factories.size >= 32) factories.delete(factories.keys().next().value!)
    factories.set(key, factory!)
  }
  const module = { exports: Object.create(null) as Exports }
  factory!(module, module.exports)
  return module.exports
}
function exportsOf(tree: Exports, prefix = '', depth = 0): Map<string, Function> {
  if (depth > 8 || !tree || typeof tree !== 'object') throw new Error('Invalid extension exports')
  const result = new Map<string, Function>()
  for (const [name, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${name}` : name
    if (typeof value === 'function') result.set(path, value)
    else for (const [k, v] of exportsOf(value as Exports, path, depth + 1)) result.set(k, v)
  }
  return result
}
function load(bundle: ExtensionRevision | ExtensionDraft): Map<string, Function> {
  const functions = exportsOf(compile(bundle.source, bundle.manifest.id))
  if ([...functions.keys()].sort().join('|') !== Object.keys(bundle.manifest.actions).sort().join('|')) throw new Error('Exports must exactly match manifest.actions')
  return functions
}

function fixtureApi(replies: Record<string, unknown[]> = {}): unknown {
  const counts = new Map<string, number>()
  const node = (path: string): unknown => new Proxy(() => {}, {
    get: (_t, key) => key === 'then' || typeof key !== 'string' ? undefined : node(path ? `${path}.${key}` : key),
    apply: async () => {
      const at = counts.get(path) ?? 0, values = replies[path]
      if (!values || at >= values.length) throw new Error(`Fixture has no reply for api.${path} call ${at + 1}`)
      counts.set(path, at + 1)
      return structuredClone(values[at])
    },
  })
  return node('')
}
function assertResult(value: unknown, asserts: ExtensionDraft['tests'][number]['assert']): void {
  for (const assertion of asserts) {
    let actual: any = value
    if (assertion.path) for (const key of assertion.path.split('.')) actual = actual?.[key]
    if (Object.hasOwn(assertion, 'equals') && JSON.stringify(actual) !== JSON.stringify(assertion.equals)) throw new Error(`Assertion ${assertion.path || 'result'}: value differs`)
    if (assertion.includes !== undefined && (typeof actual !== 'string' || !actual.includes(assertion.includes))) throw new Error(`Assertion ${assertion.path}: expected text missing`)
    if (assertion.minItems !== undefined && (!Array.isArray(actual) || actual.length < assertion.minItems)) throw new Error(`Assertion ${assertion.path}: expected at least ${assertion.minItems} items`)
  }
}

export function createExtensionRuntime(call: Call, currentApi: () => unknown, console: Pick<Console, 'info'>): { apps: unknown; management: unknown } {
  async function invoke(id: string, path: string, args: unknown[], defaults: Binding): Promise<unknown> {
    if (args.length > 1) throw new Error('Extension actions accept one input object')
    const input = args[0] ?? {}
    const supplied = input && typeof input === 'object' ? input as Binding : {}
    const bundle = await call('extensions.resolve', [{ id, action: path, binding: { ...defaults, ...(supplied.tabId === undefined ? {} : { tabId: supplied.tabId }), ...(supplied.accountId ? { accountId: supplied.accountId } : {}) } } as JsonValue]) as unknown as ExtensionRevision & { binding: Binding; config: unknown }
    const action = bundle.manifest.actions[path]
    if (!action) throw new Error(`Unknown action ${id}.${path}; inspect api.extensions.get({id:"${id}"})`)
    validateValue(input, action.input)
    const fn = load(bundle).get(path)!
    try {
      const value = await fn(Object.freeze({ api: currentApi(), binding: Object.freeze(bundle.binding), config: bundle.config, console }), input)
      if (action.output) validateValue(value, action.output, 'output')
      return value
    } catch (error) {
      throw new Error(`${id}.${path}@${bundle.revision}: ${error instanceof Error ? error.message : String(error)}. Inspect api.extensions.get({id:"${id}"}) to repair; verify any partial effects before retrying.`)
    }
  }
  const appNode = (id: string, path = '', defaults: Binding = {}): unknown => new Proxy(() => {}, {
    get: (_t, key) => {
      if (typeof key !== 'string' || ['then', '__proto__', 'constructor', 'prototype', 'toJSON'].includes(key)) return undefined
      if (key === 'for' && !path) return (binding: Binding) => appNode(id, '', binding)
      return appNode(id, path ? `${path}.${key}` : key, defaults)
    },
    apply: (_t, _this, args) => invoke(id, path, args, defaults),
  })
  const apps = new Proxy(Object.create(null), { get: (_t, key) => typeof key === 'string' && key !== 'then' ? appNode(key) : undefined })
  const management = new Proxy(Object.create(null), {
    get: (_t, key) => {
      if (key === 'then' || typeof key !== 'string') return undefined
      if (key === 'test') return async (input: { draftId: string; bindings?: Binding; live?: boolean }) => {
        const draft = await call('extensions.draft', [{ draftId: input.draftId }]) as unknown as ExtensionDraft
        load(draft) // Compile and check public exports before executing any test.
        const results: ExtensionTestResult[] = []
        for (const test of draft.tests) {
          const result: ExtensionTestResult = { name: test.name, action: test.action, mode: test.mode, ok: false }
          try {
            if (test.mode === 'live' && input.live !== true) throw new Error('Live tests require live:true; run only within the current authorized task')
            const action = draft.manifest.actions[test.action]!
            validateValue(test.input, action.input)
            const fn = load(draft).get(test.action)!
            const value = await fn(Object.freeze({ api: test.mode === 'fixture' ? fixtureApi(test.replies) : currentApi(),
              binding: Object.freeze(input.bindings ?? {}), config: {}, console }), structuredClone(test.input))
            if (action.output) validateValue(value, action.output, 'output')
            assertResult(value, test.assert)
            result.ok = true
          } catch (error) { result.error = error instanceof Error ? error.message : String(error) }
          results.push(result)
        }
        return call('extensions.recordTest', [{ draftId: input.draftId, results } as unknown as JsonValue])
      }
      return async (input: unknown = {}) => {
        const result = await call(`extensions.${key}`, [input as JsonValue])
        if (key === 'publish') console.info(`Learned REPL extension ${(result as any).id}@${(result as any).revision}. Inspect or undo with api.extensions.get/rollback.`)
        return result
      }
    },
  })
  return { apps, management }
}
