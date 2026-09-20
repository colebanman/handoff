/** Serializable contract for personal, executable REPL skills. */
import { z } from 'zod'

const reserved = new Set(['__proto__', 'prototype', 'constructor', 'then', 'for', 'toJSON'])
export const extensionName = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,47}$/).refine((v) => !reserved.has(v), 'Reserved REPL name')
const actionName = z.string().max(120).refine((v) => v.split('.').every((s) => extensionName.safeParse(s).success), 'Use dotted identifier paths')
export interface ValueSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
  properties?: Record<string, ValueSchema>
  required?: string[]
  items?: ValueSchema
  enum?: unknown[]
}
const valueSchema: z.ZodType<ValueSchema> = z.lazy(() => z.object({
  type: z.enum(['object', 'array', 'string', 'number', 'boolean', 'null']),
  properties: z.record(extensionName, valueSchema).optional(), required: z.array(extensionName).max(40).optional(),
  items: valueSchema.optional(), enum: z.array(z.unknown()).max(40).optional(),
}).strict())

export type MatchRule =
  | { all: MatchRule[] } | { any: MatchRule[] } | { not: MatchRule }
  | { url: string } | { task: string }
  | { time: { from: string; to: string; timeZone?: string; days?: number[] } }
  | { dom: { selector: string; text?: string; visible?: boolean; frame?: 'top' | 'any' } }
export const matchRule: z.ZodType<MatchRule> = z.lazy(() => z.union([
  z.object({ all: z.array(matchRule).min(1).max(12) }).strict(),
  z.object({ any: z.array(matchRule).min(1).max(12) }).strict(),
  z.object({ not: matchRule }).strict(),
  z.object({ url: z.string().min(1).max(300) }).strict(),
  z.object({ task: z.string().min(2).max(60) }).strict(),
  z.object({ time: z.object({
    from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timeZone: z.string().max(80).refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true } catch { return false } }).optional(),
    days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  }).strict() }).strict(),
  z.object({ dom: z.object({ selector: z.string().min(1).max(300), text: z.string().max(100).optional(),
    visible: z.boolean().optional(), frame: z.enum(['top', 'any']).optional() }).strict() }).strict(),
]))

export const extensionManifest = z.object({
  version: z.literal(1), id: extensionName, description: z.string().min(1).max(240),
  /** Editable supplemental guidance, surfaced only while this package is relevant. */
  instructions: z.string().max(400).optional(),
  sites: z.array(z.string().min(1).max(300)).max(12).default([]),
  triggers: z.array(z.string().min(2).max(60)).max(12).default([]),
  when: matchRule.optional(),
  actions: z.record(actionName, z.object({
    description: z.string().min(1).max(180),
    input: valueSchema.default({ type: 'object' }), output: valueSchema.optional(),
    effects: z.enum(['read', 'browser', 'write', 'local']),
  }).strict()).refine((a) => Object.keys(a).length > 0 && Object.keys(a).length <= 24, 'Use 1–24 public actions'),
}).strict()
export type ExtensionManifest = z.infer<typeof extensionManifest>

export const extensionTest = z.object({
  name: z.string().min(1).max(80), action: actionName, input: z.unknown().default({}),
  mode: z.enum(['fixture', 'live']).default('fixture'),
  /** RPC path -> ordered replies, consumed separately for each fixture case. */
  replies: z.record(z.string(), z.array(z.unknown())).optional(),
  assert: z.array(z.object({
    path: z.string().max(200).default(''), equals: z.unknown().optional(),
    includes: z.string().max(500).optional(), minItems: z.number().int().min(0).optional(),
  }).strict().refine((a) => 'equals' in a || a.includes !== undefined || a.minItems !== undefined, 'An assertion needs an expected value')).min(1).max(20),
}).strict()
export type ExtensionTest = z.infer<typeof extensionTest>
export interface ExtensionBundle { manifest: ExtensionManifest; source: string; tests: ExtensionTest[] }
export interface ExtensionTestResult { name: string; action: string; mode: 'fixture' | 'live'; ok: boolean; error?: string }
export interface ExtensionRevision extends ExtensionBundle { revision: number; at: number; results: ExtensionTestResult[] }
export interface ExtensionSummary {
  id: string; revision: number; enabled: boolean; description: string; manifest: ExtensionManifest
  results: ExtensionTestResult[]; path: string; revisions: number[]
}
export interface ExtensionDraft extends ExtensionBundle { id: string; draftId: string; baseRevision: number; results: ExtensionTestResult[] }

export function parseBundle(value: unknown): ExtensionBundle {
  // Bound nesting before recursive schema parsing (editable data must not overflow the stack).
  const raw = JSON.stringify(value)
  if (!raw) throw new Error('Provide an extension bundle or package path')
  if (raw.length > 350_000) throw new Error('Extension bundle exceeds 350,000 characters')
  let depth = 0, quoted = false, escaped = false
  for (const char of raw) {
    if (escaped) { escaped = false; continue }
    if (char === '\\' && quoted) { escaped = true; continue }
    if (char === '"') quoted = !quoted
    if (quoted) continue
    if (char === '{' || char === '[') { if (++depth > 16) throw new Error('Extension metadata is nested too deeply') }
    if (char === '}' || char === ']') depth--
  }
  const bundle = z.object({ manifest: extensionManifest, source: z.string().min(1).max(250_000),
    tests: z.array(extensionTest).min(1).max(48) }).strict().parse(value)
  const names = new Set<string>()
  for (const test of bundle.tests) {
    if (!(test.action in bundle.manifest.actions)) throw new Error(`Unknown test action ${test.action}`)
    if (names.has(test.name)) throw new Error(`Duplicate test name ${test.name}`)
    names.add(test.name)
  }
  const paths = Object.keys(bundle.manifest.actions)
  if (paths.some((path) => paths.some((other) => other !== path && other.startsWith(`${path}.`)))) throw new Error('An action cannot also be a namespace')
  return bundle
}

export function validateValue(value: unknown, schema: ValueSchema, path = 'input'): void {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (type !== schema.type || (type === 'number' && !Number.isFinite(value))) throw new Error(`${path}: expected ${schema.type}`)
  if (schema.enum && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) throw new Error(`${path}: unexpected value`)
  if (schema.type === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!Object.hasOwn(obj, key)) throw new Error(`${path}.${key}: required`)
    for (const [key, spec] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(obj, key)) validateValue(obj[key], spec, `${path}.${key}`)
  }
  if (schema.type === 'array' && schema.items) (value as unknown[]).forEach((v, i) => validateValue(v, schema.items!, `${path}[${i}]`))
}

export function schemaSignature(schema: ValueSchema): string {
  if (schema.type === 'object') return `{${Object.entries(schema.properties ?? {}).map(([key, spec]) =>
    `${key}${schema.required?.includes(key) ? '' : '?'}:${schemaSignature(spec)}`).join(', ')}}`
  if (schema.type === 'array') return `${schema.items ? schemaSignature(schema.items) : 'unknown'}[]`
  return schema.type
}
