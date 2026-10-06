const LIST_LINE_RE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/

/**
 * Split markdown into independently renderable top-level blocks on blank
 * lines. Fence-aware (blank lines inside code or display math don't split) and
 * list-aware (loose lists — blank lines between items/continuations — stay
 * one block so numbering and tightness render exactly as before).
 */
export function splitMarkdownBlocks(text: string): string[] {
  // Definitions can resolve links/footnotes in any earlier block. Keep those
  // documents together, including when a definition arrives late in a stream.
  if (/^\s{0,3}\[[^\]\n]+\]:/m.test(text)) return [text]
  const lines = text.split('\n')
  const blocks: string[] = []
  let cur: string[] = []
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  let mathFence: number | 'bracket' | undefined
  const flush = (): void => {
    if (cur.length > 0) {
      blocks.push(cur.join('\n'))
      cur = []
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!inFence) {
      const content = line.replace(/^\s{0,3}(?:>\s*)*/, '')
      if (mathFence !== undefined) {
        cur.push(line)
        const closing = /^\s*(\${2,})\s*$/.exec(content)
        if (mathFence === 'bracket' ? /(?<!\\)(?:\\\\)*\\\]/.test(content) : closing && closing[1]!.length >= mathFence) mathFence = undefined
        continue
      }
      const math = /^\s{0,3}(\${2,})[^$]*$/.exec(content)
      if (math || (/^\s{0,3}\\\[/.test(content) && !/\\\]/.test(content))) {
        mathFence = math ? math[1]!.length : 'bracket'
        cur.push(line)
        continue
      }
    }
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      const marker = fence[1]!
      if (!inFence && !(marker[0] === '`' && fence[2]!.includes('`'))) {
        inFence = true
        fenceChar = marker[0]!
        fenceLen = marker.length
      } else if (marker[0] === fenceChar && marker.length >= fenceLen && !fence[2]!.trim()) {
        inFence = false
      }
      cur.push(line)
      continue
    }
    if (!inFence && line.trim() === '') {
      let j = i + 1
      while (j < lines.length && lines[j]!.trim() === '') j++
      const next = lines[j]
      // Preserve the actual tail boundary. A single newline can continue a
      // paragraph; a blank line ends its speculative inline formatting.
      if (next === undefined) {
        cur.push(...lines.slice(i))
        break
      }
      const looseList =
        cur.some((previous) => LIST_LINE_RE.test(previous)) &&
        (LIST_LINE_RE.test(next) || /^\s{2,}\S/.test(next))
      if (looseList) {
        cur.push(line)
        continue
      }
      if (cur.length) cur.push('', '')
      flush()
      continue
    }
    cur.push(line)
  }
  flush()
  return blocks
}
