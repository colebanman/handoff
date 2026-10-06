import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ContextMeter } from './Header'
import type { ContextUsageInfo } from '../../shared/context-usage'
import type { ContextModel } from '../../shared/model-context'

const model: ContextModel = { provider: 'openai', modelId: 'gpt-6.1-sol', openaiAuthMode: 'chatgpt' }
const usage: ContextUsageInfo = {
  modelId: model.modelId, updatedAt: 1,
  usage: { inputTokens: 12_000, outputTokens: 50_000, totalTokens: 62_000 },
  context: { model, inputTokens: 12_000, window: { tokens: 1_050_000, source: 'catalog' } },
}

it('renders the actual request limit and input count without rounding 1.05M to 1M', () => {
  const html = renderToStaticMarkup(createElement(ContextMeter, { model, usage, isRunning: false }))
  expect(html).toContain('12K / 1.05M')
  expect(html).not.toContain('62K')
  expect(html).toContain('Context at last request: 12,000 input tokens')
  expect(html).toContain('1,050,000-token context window')
})

it('shows Claude limits before the first response and never leaks another model’s reading', () => {
  const html = renderToStaticMarkup(createElement(ContextMeter, { model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, usage, isRunning: false }))
  expect(html).toContain('— / 1M')
  expect(html).toContain('No input usage reported yet')
  expect(html).not.toContain('12K')
})

it('distinguishes an estimated ChatGPT fallback and an unknown custom model', () => {
  expect(renderToStaticMarkup(createElement(ContextMeter, { model, isRunning: false }))).toContain('— / ~272K')
  const html = renderToStaticMarkup(createElement(ContextMeter, { model: { provider: 'openai-compatible', modelId: model.modelId }, isRunning: false }))
  expect(html).toContain('— / —')
})

it('recognizes prefixed aliases but rejects readings from another authentication mode', () => {
  expect(renderToStaticMarkup(createElement(ContextMeter, { model: { ...model, modelId: `openai/${model.modelId}` }, usage, isRunning: false }))).toContain('12K / 1.05M')
  expect(renderToStaticMarkup(createElement(ContextMeter, { model: { ...model, openaiAuthMode: 'api-key' }, usage, isRunning: false }))).toContain('— / 1.05M')
})
