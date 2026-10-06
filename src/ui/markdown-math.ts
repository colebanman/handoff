import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { Processor, PluggableList } from 'unified'
import type { Nodes, Root } from 'hast'
import type { Construct, State, Tokenizer } from 'micromark-util-types'
import type {} from 'micromark-extension-math'
import type {} from 'remark-parse'

const lineEnding = (code: number | null): boolean => code === -5 || code === -4 || code === -3
const whitespace = (code: number | null): boolean => code === 32 || code === -2 || code === -1 || lineEnding(code)

/**
 * Recognize math before Markdown consumes backslash escapes/emphasis. Reuse
 * remark-math's tokens so code, links, lists and GFM tables keep their normal
 * parser boundaries and source positions. Single dollars follow Pandoc's
 * whitespace/digit rules to avoid interpreting ordinary prices as equations.
 */
function mathText(flow = false): Construct {
  const tokenize: Tokenizer = function (effects, ok, nok) {
    let delimiter: '$' | ')' | ']'
    let dollars = 0
    let previous: number | null = null
    let hasData = false
    let inData = false
    const data = (code: number): void => {
      if (!inData) { effects.enter('mathTextData'); inData = true }
      effects.consume(code)
      previous = code
      hasData = true
    }
    const endData = (): void => {
      if (inData) { effects.exit('mathTextData'); inData = false }
    }
    const close: Construct = { partial: true, tokenize(effects, ok, nok) {
      let count = 0
      return start
      function start(code: number | null): ReturnType<State> {
        if (delimiter === '$') {
          if (code !== 36) return nok(code)
          return dollar(code)
        }
        if (code !== 92) return nok(code)
        effects.consume(code)
        return bracket
      }
      function bracket(code: number | null): ReturnType<State> {
        if (code !== delimiter.charCodeAt(0)) return nok(code)
        effects.consume(code)
        return ok
      }
      function dollar(code: number | null): ReturnType<State> {
        if (code === 36) { effects.consume(code); count++; return dollar }
        if (count !== dollars || (dollars === 1 && (whitespace(previous) || (code !== null && code >= 48 && code <= 57)))) return nok(code)
        return ok(code)
      }
    } }
    const closing: Construct = { partial: true, tokenize(effects, ok, nok) {
      return (code) => {
        effects.enter('mathTextSequence')
        return effects.attempt(close, (next) => { effects.exit('mathTextSequence'); return ok(next) }, nok)(code)
      }
    } }
    const body: State = (code) => {
      if (code === null) return nok(code)
      if (delimiter === '$' && dollars === 1 && (lineEnding(code) || code === 96)) return nok(code)
      if ((delimiter === '$' && code === 36) || (delimiter !== '$' && code === 92)) {
        endData()
        return effects.attempt(closing, finished, (next) => {
          // An invalid single-dollar closer is usually the next price or the
          // start of a later equation. Let Markdown retry at that position.
          if (delimiter === '$') return nok(next)
          return escaped(next)
        })(code)
      }
      if (code === 92) return escaped(code)
      if (lineEnding(code)) {
        endData()
        effects.enter('lineEnding'); effects.consume(code); effects.exit('lineEnding')
        return body
      }
      data(code)
      return body
    }
    const escaped: State = (code) => {
      if (code === null) return nok(code)
      data(code)
      return (next) => {
        if (next === null || lineEnding(next)) return body(next)
        data(next)
        return body
      }
    }
    const finished: State = (code) => {
      if (!hasData) return nok(code)
      effects.exit('mathText')
      if (flow && code !== null && !lineEnding(code)) {
        if (!whitespace(code)) return nok(code)
        effects.enter('whitespace')
        return trailing(code)
      }
      return ok(code)
    }
    const trailing: State = (code) => {
      if (code !== null && !lineEnding(code) && whitespace(code)) {
        effects.consume(code)
        return trailing
      }
      effects.exit('whitespace')
      return code === null || lineEnding(code) ? ok(code) : nok(code)
    }
    const openEnd: State = (code) => {
      if (dollars === 1 && whitespace(code)) return nok(code)
      effects.exit('mathTextSequence')
      return body(code)
    }
    const openDollar: State = (code) => {
      if (code === 36) { effects.consume(code); dollars++; return openDollar }
      return openEnd(code)
    }
    return (code) => {
      effects.enter('mathText'); effects.enter('mathTextSequence')
      if (code === 36 && !flow) { delimiter = '$'; return openDollar(code) }
      if (code !== 92) return nok(code)
      effects.consume(code)
      return (next) => {
        if (next !== 91 && (flow || next !== 40)) return nok(next)
        delimiter = next === 91 ? ']' : ')'
        effects.consume(next)
        return openEnd
      }
    }
  }
  return { tokenize, concrete: flow, name: flow ? 'latexDisplay' : 'mathText' }
}

export function remarkMarkdownMath(this: Processor) {
  remarkMath.call(this)
  const extensions = this.data().micromarkExtensions!
  // Replace the dollar text tokenizer (rather than adding a fallback which
  // would undo the currency checks). Keep remark-math's block-fence parser.
  const extension = extensions.at(-1)!
  extension.text = { 36: mathText(), 92: mathText() }
  extension.flow = { ...extension.flow, 92: mathText(true) }
  // Set display mode during parsing so predictive Markdown reparses retain it.
  const handlers = this.data().fromMarkdownExtensions!.flat().at(-1)!.exit!
  const exitMath = handlers.mathText!
  handlers.mathText = function (token) {
    const source = this.sliceSerialize(token)
    exitMath.call(this, token)
    const parent = this.stack.at(-1)!
    const node = 'children' in parent ? parent.children.at(-1) : undefined
    if (node?.type === 'inlineMath' && (source.startsWith('$$') || source.startsWith('\\['))) {
      node.data!.hProperties = { className: ['language-math', 'math-display'] }
    }
  }
}

function rehypeMathAccessibility() {
  return (tree: Root): void => {
    function visit(node: Nodes): void {
      if (node.type === 'element' && Array.isArray(node.properties.className) && node.properties.className.includes('katex-display')) {
        node.properties.tabIndex = 0
        node.properties.role = 'region'
        node.properties.ariaLabel = 'Equation'
        return
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
  }
}

// Local fonts/CSS are imported by theme.css; never fetch a CDN or allow TeX
// to create links, remote images or arbitrary HTML. Each equation gets fresh
// macro state and bounded expansion/size, including malformed streamed input.
export const MATH_REHYPE_PLUGINS: PluggableList = [[rehypeKatex, {
  trust: false,
  strict: 'ignore',
  maxExpand: 1000,
  maxSize: 20,
  output: 'htmlAndMathml',
  errorColor: 'currentColor',
}], rehypeMathAccessibility]
