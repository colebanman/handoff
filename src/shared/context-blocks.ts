/** Delimit generated context without letting editable text close its blocks. */
export function contextText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export const RUNTIME_CONTEXT_START = '<context source="harness">\n'

export function isRuntimeContextText(text: string): boolean {
  return text.startsWith(RUNTIME_CONTEXT_START) && text.endsWith('\n</context>')
}

/** SDK/persistence adapters can represent the same text as a string or text parts. */
export function isRuntimeContextMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object' || !('role' in message) || message.role !== 'user' || !('content' in message)) return false
  const content = message.content
  if (typeof content === 'string') return isRuntimeContextText(content)
  if (!Array.isArray(content) || !content.every((part) => part?.type === 'text' && typeof part.text === 'string')) return false
  return isRuntimeContextText(content.map((part) => part.text).join('\n'))
}
