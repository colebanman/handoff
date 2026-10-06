/** Tokenization stays local. Unknown tokenizers use a conservative UTF-8 byte bound. */
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base'
const counts = new Map<string, number>()

export function warmMemoryTokenizer(): Promise<void> {
  // Static import is required in MV3 service workers, which disallow import().
  countTokens('memory', { disallowedSpecial: new Set() })
  return Promise.resolve()
}

export function memoryTokens(text: string, modelId = ''): number {
  // Only families whose encoding the installed tokenizer documents. New/custom
  // families (including GPT-6) remain bounded without guessing their encoding.
  const known = /^(?:openai\/)?(?:gpt-(?:4o|4\.1|5(?:\.|-|$))|o[134](?:-|$))/.test(modelId)
  if (!known) return new TextEncoder().encode(text).length
  const cached = counts.get(text)
  if (cached !== undefined) return cached
  const n = countTokens(text, { disallowedSpecial: new Set() })
  if (counts.size >= 512) counts.delete(counts.keys().next().value!)
  counts.set(text, n)
  return n
}
