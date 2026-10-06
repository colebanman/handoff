// Smoke test the built MV3 extension with real Chrome APIs, in an empty profile.
// Usage: node scripts/ui-stress/extension.mjs /tmp/handoff-ui-built
// Build to a disposable directory: this script tightens that copy's network CSP.
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { findChrome } from '../chrome-binary.mjs'

const build = resolve(process.argv[2] || '/tmp/handoff-ui-built')
if (!build.startsWith(`${resolve(tmpdir())}/`) && !build.startsWith('/tmp/')) throw new Error('Use a disposable build under the system temporary directory.')
const output = resolve(process.env.UI_STRESS_OUTPUT || '/tmp/handoff-ui-extension')
await mkdir(output, { recursive: true })
const manifest = JSON.parse(await readFile(join(build, 'manifest.json'), 'utf8'))
manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages
  .split(';').filter(directive => !directive.trim().startsWith('connect-src')).join(';') + "; connect-src 'self' data: blob:"
await writeFile(join(build, 'manifest.json'), JSON.stringify(manifest, null, 2))
const profile = await mkdtemp(join(tmpdir(), 'ai-ui-extension-chrome-'))
const binary = await findChrome({ extensionCapable: true })
const browser = spawn(binary, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--use-mock-keychain', '--password-store=basic', '--disable-gpu', '--disable-sync', '--disable-background-networking',
  `--disable-extensions-except=${build}`, `--load-extension=${build}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let chromeErrors = ''
browser.stderr.on('data', data => { chromeErrors += data })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const sockets = []
const results = []
const errors = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, ...(!ok ? { detail } : {}) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`) }
async function connect(url) {
  const socket = new WebSocket(url)
  sockets.push(socket)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let id = 0
  const callbacks = new Map()
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    const callback = callbacks.get(message.id)
    if (callback) { callbacks.delete(message.id); message.error ? callback.reject(message.error) : callback.resolve(message.result) }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; callbacks.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })) })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Runtime.enable')
  return { send, evaluate }
}
try {
  let port
  for (let n = 0; n < 100; n++) { try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch {} await delay(100) }
  if (!port) throw new Error(`Chrome for Testing did not start. Set CHROME_EXTENSION_PATH to an extension-capable Chrome binary. ${chromeErrors.slice(-3000)}`)
  const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  let worker
  for (let n = 0; n < 100; n++) { worker = (await targets()).find(target => target.type === 'service_worker' && /^chrome-extension:\/\/[^/]+\/background\.js$/.test(target.url)); if (worker) break; await delay(100) }
  if (!worker) throw new Error('The built extension did not load.')
  console.log('Extension target:', worker.url)
  const extensionId = new URL(worker.url).hostname
  const page = await connect((await targets()).find(target => target.type === 'page').webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 850, deviceScaleFactor: 1, mobile: false })
  await page.send('Page.navigate', { url: `chrome-extension://${extensionId}/sidepanel.html` })
  const waitFor = async expression => { for (let n = 0; n < 100; n++) { if (await page.evaluate(expression)) return true; await delay(100) } return false }
  const onboarded = await waitFor('!!document.querySelector(".onb")')
  const initial = await page.evaluate('({url:location.href,title:document.title,text:document.body.innerText.slice(0,2000),chrome:Object.keys(chrome)})')
  check('fresh extension opens onboarding', onboarded, initial)
  if (!onboarded) throw new Error(JSON.stringify({ initial, errors }))
  await page.evaluate('chrome.storage.local.set({settings:{bridgeEnabled:false}})')
  const screenshot = async name => { await delay(400); const shot = await page.send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, `${name}.png`), Buffer.from(shot.data, 'base64')) }
  await screenshot('onboarding')
  // Exercise welcome and explanatory steps. Provider sign-in is intentionally
  // not invoked; the profile contains no accounts and external I/O is denied.
  for (let n = 0; n < 5; n++) {
    await page.evaluate('document.querySelector(".onb__footer .btn:last-child")?.click()')
    await delay(300)
    const state = await page.evaluate('({ title: document.querySelector(".onb__title")?.textContent, width: document.querySelector(".onb")?.scrollWidth, client: document.querySelector(".onb")?.clientWidth })')
    check(`onboarding step ${n + 1} stays contained`, state.width <= state.client + 2, state)
  }
  const at = Date.now()
  const user = { kind: 'user', id: 'u', text: 'Inspect the tool results and produce a summary.', at }
  const tool = (id, name, input, output, status = 'done') => ({ kind: 'tool', id, agentId: 'main', toolName: name, inputText: JSON.stringify(input), input, output, status, at: at - 5000, durationMs: 80 })
  const text = (id, content) => ({ kind: 'text', id, agentId: 'main', text: content, streaming: false, at })
  const transcript = [user,
    { kind: 'reasoning', id: 'r', agentId: 'main', text: '**Checking the result**\n\nThe files and page are ready.', streaming: false, at, durationMs: 3000 },
    tool('click', 'browser_click', { ref: 'e1', __target: { role: 'button', name: 'Save changes' } }, { ok: true }),
    tool('code', 'sandbox_exec', { code: 'const title = await api.page.eval(1, "document.title"); console.log(title)', intent: 'Reading the page title' }, 'Example page'),
    tool('failure', 'filesystem_view', { path: '/workspace/missing.txt' }, { error: { message: 'File not found' } }, 'error'),
    text('answer', '## Results\n\nThe checks are complete.\n\n| Test | Result |\n| --- | --- |\n| Page | Passed |\n| File | Missing |\n\n```js\nconsole.log("complete");\n```'),
  ]
  const a = { id: 'stress-a', title: 'UI stress: tool results', modelId: 'grok-4.6', createdAt: at, updatedAt: at + 1, messages: [], checkpoints: [], transcript }
  const b = { ...a, id: 'stress-b', title: 'UI stress: long history', updatedAt: at, transcript: Array.from({ length: 30 }, (_, n) => text(`b-${n}`, `Message ${n}\n\n${'A historical message with content. '.repeat(30)}`)) }
  await page.evaluate(`chrome.storage.local.set(${JSON.stringify({ settings: { bridgeEnabled: false, onboardingComplete: true, theme: 'dark', suggestNextPrompt: false }, 'chat-ids': [a.id, b.id], [`chat:${a.id}`]: a, [`chat:${b.id}`]: b, [`meta:${a.id}`]: { ...a, transcript: undefined, messages: undefined, preview: 'Tool results' }, [`meta:${b.id}`]: { ...b, transcript: undefined, messages: undefined, preview: 'Long history' } })})`)
  await page.send('Page.reload')
  check('persisted transcript restores through real storage/worker', await waitFor('document.body.textContent.includes("The checks are complete")'))
  await delay(600)
  check('restored transcript contains one activity block', await page.evaluate('document.querySelectorAll(".activity").length === 1'))
  await page.evaluate('document.querySelector(".activity__header")?.click()')
  await delay(400)
  check('restored tools expand', await page.evaluate('document.querySelectorAll(".step").length === 4'))
  await screenshot('restored-tools')
  const selectChat = async title => {
    await page.evaluate('document.querySelector("button[title=Chats]")?.click()')
    await delay(100)
    await page.evaluate(`Array.from(document.querySelectorAll('.chat-row')).find(row => row.textContent.includes(${JSON.stringify(title)}))?.click()`)
    await delay(500)
  }
  await selectChat('long history')
  check('saved chat switch loads long history', await page.evaluate('document.body.textContent.includes("Message 29")'))
  await page.evaluate('const feed=document.querySelector(".feed");feed.scrollTop=10;feed.dispatchEvent(new Event("scroll",{bubbles:true}))')
  await selectChat('tool results')
  await selectChat('long history')
  check('real chat switches reset scroll pinning', await page.evaluate('(()=>{const feed=document.querySelector(".feed");return feed.scrollHeight-feed.scrollTop-feed.clientHeight<3})()'))
  await selectChat('tool results')
  await page.evaluate('document.querySelector("button[title=Settings]")?.click()')
  check('settings opens in built extension', await waitFor('!!document.querySelector(".modal--settings")'))
  await screenshot('settings')
  await page.evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))')
  await page.evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))')
  await delay(250)
  await page.evaluate('document.querySelector("button[title=Files]")?.click()')
  check('file panel opens with real IndexedDB', await waitFor('document.body.textContent.includes("Workspace")'))
  await screenshot('files')
  const geometry = await page.evaluate('({ composer:document.querySelector(".composer")?.getBoundingClientRect().bottom, width:document.querySelector(".app")?.scrollWidth, height:innerHeight, viewport:innerWidth })')
  check('built shell stays within viewport', geometry.width <= geometry.viewport + 2 && geometry.composer <= geometry.height + 2, geometry)
  const secondTarget = await page.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel.html?view=tab` })
  await delay(500)
  const second = await connect((await targets()).find(target => target.id === secondTarget.targetId).webSocketDebuggerUrl)
  check('second panel respects active-panel ownership', await second.evaluate('document.body.textContent.includes("The extension is already open")'))
  check('no uncaught extension UI exceptions', errors.length === 0, errors)
  await writeFile(join(output, 'report.json'), JSON.stringify({ profile, sandboxEnabled: true, extensionId, network: 'External connections denied by test manifest CSP; bridge disabled', results, errors }, null, 2))
  console.log(`Report: ${join(output, 'report.json')}`)
  process.exitCode = results.some(result => !result.ok) ? 1 : 0
} finally {
  for (const socket of sockets) socket.close()
  browser.kill('SIGTERM')
  await delay(300)
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
