// Run after npm run build:dev, with the dev extension enabled and ChatGPT connected:
// playwriter -s <direct-session> --timeout 180000 -f scripts/compaction-e2e.mjs
// Exercises the actual extension UI, worker, OAuth transport, and persisted history.
const assert = require('assert').strict
const extensionURL = state.handoffExtensionURL
assert.match(extensionURL ?? '', /^chrome-extension:\/\/[a-p]{32}\/sidepanel\.html$/, 'Set state.handoffExtensionURL to the installed dev extension sidepanel URL first')
state.dev ??= await context.newPage()
if (state.dev.url() !== extensionURL) await state.dev.goto(extensionURL)
const originalSettings = await state.dev.evaluate(async () => (await chrome.storage.local.get('settings')).settings)
try {
const id = `compaction-e2e-${Date.now()}`
const modelId = state.compactionModelId ?? 'gpt-5.6-luna'
state.compactionTestId = id
const code = `orchard-${Math.floor(Math.random() * 90000 + 10000)}`
state.compactionTestCode = code
await state.dev.evaluate(async ({ id, code, modelId }) => {
  const now = Date.now()
  const record = {
    id, title: `Compaction E2E (${modelId})`, modelId, createdAt: now, updatedAt: now,
    messages: [
      { role: 'user', content: `Remember this exact code for the next questions: ${code}` },
      { role: 'assistant', content: 'The orchard is green and the trees grow fruit. '.repeat(11500) },
    ],
    transcript: [{ kind: 'user', id: 'fixture', text: 'Long conversation fixture for compaction test', at: now }],
    checkpoints: [],
  }
  const stored = await chrome.storage.local.get(['settings', 'chat-ids'])
  await chrome.storage.local.set({
    [`chat:${id}`]: record,
    [`meta:${id}`]: { id, title: record.title, createdAt: now, updatedAt: now, preview: 'Synthetic compaction test' },
    'chat-ids': [...(stored['chat-ids'] ?? []), id],
    settings: { ...stored.settings, modelId: record.modelId, provider: 'openai', openaiAuthMode: 'chatgpt',
      onboardingComplete: true, suggestNextPrompt: false,
      customInstructions: 'For this test, do not use tools or browse. Reply only with the requested remembered code.' },
    memoryBootstrapVersion: 1,
  })
}, { id, code, modelId })
await state.dev.reload()
await state.dev.getByRole('textbox').waitFor({ timeout: 20000 })
console.log(await snapshot({ page: state.dev }))
console.log(await getLatestLogs({ page: state.dev, sinceLastCall: true }))
await state.dev.getByRole('textbox').fill('What is the remembered code? Reply with only the code.')
await state.dev.getByRole('button', { name: 'Send', exact: true }).click()
await state.dev.getByText('Compacting conversation…', { exact: true }).first().waitFor({ timeout: 20000 })
assert.equal(await state.dev.getByRole('textbox').isDisabled(), true, 'Composer must lock during compaction')
assert.equal(await state.dev.getByRole('button', { name: 'Stop', exact: true }).isEnabled(), true, 'Stop must remain usable')
console.log('PASS: visible compaction state; sending/steering disabled; Stop enabled')
console.log(await snapshot({ page: state.dev }))
console.log(await getLatestLogs({ page: state.dev, sinceLastCall: true }))
await state.dev.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 100000 })
assert.equal(await state.dev.getByRole('textbox').isEnabled(), true)
const saved = await state.dev.evaluate(async (id) => {
  const data = await chrome.storage.local.get(`chat:${id}`)
  const record = data[`chat:${id}`]
  return {
    compactions: record.transcript.filter((item) => item.kind === 'compaction').map((item) => item.status),
    answers: record.transcript.filter((item) => item.kind === 'text').map((item) => item.text),
    checkpoints: record.messages.filter((message) => message.providerOptions?.compaction).length,
  }
}, id)
assert.ok(saved.compactions.includes('done'), JSON.stringify(saved))
assert.ok(saved.answers.some((text) => text.trim() === code), JSON.stringify(saved))
assert.ok(saved.checkpoints > 0, 'Canonical compaction state must be persisted')
console.log('PASS: ChatGPT compaction and remembered code; canonical state persisted')
// Reload verifies that replay consumes persisted state, not a transport closure.
await state.dev.reload()
await state.dev.getByRole('textbox').waitFor({ timeout: 20000 })
await state.dev.getByRole('textbox').fill('Repeat the remembered code again. Only the code.')
await state.dev.getByRole('button', { name: 'Send', exact: true }).click()
console.log(await getLatestLogs({ page: state.dev, sinceLastCall: true }))
await state.dev.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 10000 })
await state.dev.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 60000 })
const answers = await state.dev.evaluate(async (id) => {
  const data = await chrome.storage.local.get(`chat:${id}`)
  return data[`chat:${id}`].transcript.filter((item) => item.kind === 'text').map((item) => item.text)
}, id)
assert.equal(answers.at(-1).trim(), code)
const restoredSections = await state.dev.evaluate(async (id) => {
  const data = await chrome.storage.local.get(`chat:${id}`)
  const messages = data[`chat:${id}`].messages
  const boundary = messages.findLastIndex((message) => message.providerOptions?.compaction?.checkpoint)
  const restored = messages.slice(boundary + 1).filter((message) =>
    message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<context source="harness">'))
  return Object.fromEntries(['workspace', 'user-memory', 'site-memory', 'active-task'].map((tag) =>
    [tag, restored.filter((message) => message.content.includes(`<${tag}>`)).length]))
}, id)
for (const tag of ['workspace', 'user-memory', 'site-memory', 'active-task']) {
  assert.equal(restoredSections[tag], 1, `${tag} must be explicitly restored exactly once`)
}
console.log('PASS: memory, guidance, workspace, and active task restored once after the checkpoint')
console.log(`PASS: ${modelId} post-reload follow-up recalls the code from compacted context`)
console.log(await snapshot({ page: state.dev }))
console.log(await getLatestLogs({ page: state.dev, sinceLastCall: true }))
} finally {
  await state.dev.evaluate(async (settings) => chrome.storage.local.set({ settings }), originalSettings)
}
