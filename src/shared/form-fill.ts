import { z } from 'zod'

/** Keep the existing {ref,text,clear?} shape compatible. Exactly one intention. */
export const formFieldSchema = z.union([
  z.object({ ref: z.string().min(1), text: z.string(), clear: z.boolean().optional() }).strict(),
  z.object({ ref: z.string().min(1), select: z.string().trim().min(1) }).strict(),
  z.object({ ref: z.string().min(1), checked: z.boolean() }).strict(),
])
export const formFieldsSchema = z.array(formFieldSchema).min(1).max(50).refine(
  fields => new Set(fields.map(field => field.ref)).size === fields.length,
  'Each field ref must appear only once.',
)
export type FormField = z.infer<typeof formFieldSchema>
export interface FormFieldResult {
  ref: string
  status: 'verified' | 'uncertain' | 'unattempted'
  reason?: string
}
export interface FormFillResult {
  ok: boolean
  fields: FormFieldResult[]
  stopped?: string
}
