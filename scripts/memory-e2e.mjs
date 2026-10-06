// Real MV3/IndexedDB/UI integration in a disposable Chrome profile. Inference stays on a local fixture.
// Build first: npx vite build --outDir /tmp/handoff-memory-built --emptyOutDir
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { findChrome } from './chrome-binary.mjs'

const build = resolve(process.argv[2] || '/tmp/handoff-memory-built')
if (!build.startsWith('/tmp/') && !build.startsWith(resolve(tmpdir()) + '/')) throw new Error('Use a disposable build in the temporary directory.')
const output = resolve(process.env.MEMORY_E2E_OUTPUT || '/tmp/handoff-memory-e2e')
await mkdir(output, { recursive: true })
const requests = [], checks = [], errors = [], sockets = []
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, ...(!ok ? { detail } : {}) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`) }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const endDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
let fixturePort
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (!req.url?.endsWith('/chat/completions')) {
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>COURSE101 project</title><main><h1>Water quality project</h1><p>Professor Example: You are assigned to group 5.</p><button>Project details</button></main>'); return
  }
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  requests.push({ at: Date.now(), body })
  const background = body.model === 'gpt-6-luna'
  let content, tool
  if (background) {
    const input = JSON.parse(body.messages.filter(m => m.role === 'user').at(-1).content)
    const source = input.events?.find(e => e.origin === 'human' && e.text.includes('group 5'))
    content = JSON.stringify({ upserts: source ? [{
      subject: 'course101.water-quality.group', title: 'Water quality project — group 5',
      body: 'You are in group 5 for the COURSE101 water quality project. Professor Example teaches the course.',
      kind: 'project', useWhen: 'When planning or discussing the COURSE101 water quality project.',
      scopes: ['127.0.0.1/course/course101/**'], triggers: ['water quality', 'COURSE101'], entities: ['COURSE101'],
      relatedTo: [], validUntil: endDate, timeZone: 'America/New_York', boundaryBasis: 'explicit', state: 'active', global: false,
      evidenceIds: [source.id], quotes: {}, replaces: [],
    }] : [], forget: [] })
  } else {
    const hasTool = body.messages.some(m => m.role === 'tool')
    if (!hasTool && body.messages.some(m => m.role === 'user' && String(m.content).includes('Read the page'))) tool = { index: 0, id: 'snapshot-fixture', type: 'function', function: { name: 'browser_snapshot', arguments: '{}' } }
    const memory = body.messages.filter(m => m.role === 'user').map(m => String(m.content)).join('\n')
    content = /<continuity>[\s\S]*?group 5/i.test(memory) ? 'You are in group 5 for your water quality project.' : 'There is no current group assignment in saved memory.'
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const base = { id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model }
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [tool] } : { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 250, total_tokens: 1250 } })}\n\ndata: [DONE]\n\n`)
  res.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
fixturePort = server.address().port
const manifest = JSON.parse(await readFile(join(build, 'manifest.json'), 'utf8'))
manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.split(';').filter(d => !d.trim().startsWith('connect-src')).join(';') + `; connect-src 'self' data: blob: http://127.0.0.1:${fixturePort}`
await writeFile(join(build, 'manifest.json'), JSON.stringify(manifest, null, 2))
const profile = await mkdtemp(join(tmpdir(), 'ai-memory-chrome-'))
const binary = await findChrome({ extensionCapable: true })
const chrome = spawn(binary, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--headless=new', '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic', '--disable-gpu', '--disable-sync', '--disable-background-networking', `--disable-extensions-except=${build}`, `--load-extension=${build}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = ''
chrome.stderr.on('data', data => { stderr += data })
async function connect(url) {
  const socket = new WebSocket(url); sockets.push(socket)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let id = 0; const pending = new Map()
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); message.error ? callback?.reject(message.error) : callback?.resolve(message.result) }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })) })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Runtime.enable')
  return { send, evaluate }
}

try {
  let port
  for (let i = 0; i < 100; i++) { try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch {} await delay(100) }
  if (!port) throw new Error(stderr.slice(-2000))
  const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  let worker
  for (let i = 0; i < 100; i++) { worker = (await targets()).find(t => t.type === 'service_worker' && t.url.endsWith('/background.js')); if (worker) break; await delay(100) }
  if (!worker) throw new Error('Extension worker did not start.')
  const id = new URL(worker.url).hostname
  const workerClient = await connect(worker.webSocketDebuggerUrl)
  const page = await connect((await targets()).find(t => t.type === 'page').webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Page.navigate', { url: `chrome-extension://${id}/sidepanel.html` })
  async function waitFor(expression, timeout = 12000) {
    const end = Date.now() + timeout
    while (Date.now() < end) { if (await page.evaluate(expression)) return true; await delay(100) }
    return false
  }
  await waitFor('!!document.querySelector(".app") || !!document.querySelector(".onb")')
  const settings = { provider: 'openai-compatible', modelId: 'memory-fixture', baseURL: `http://127.0.0.1:${fixturePort}/v1`, apiKey: 'fixture-key', apiKeys: { 'openai-compatible': 'fixture-key' }, onboardingComplete: true, bridgeEnabled: false, suggestNextPrompt: false, theme: 'dark' }
  await page.evaluate(`chrome.storage.local.set({settings:${JSON.stringify(settings)}})`)
  await page.send('Page.reload')
  check('built Settings entry is available', await waitFor('!!document.querySelector("button[title=Settings]")'))
  const command = payload => page.evaluate(`chrome.runtime.sendMessage({target:"background",type:"memory.command",payload:${JSON.stringify(payload)}})`)
  const initial = await command({ command: 'list' })
  check('real memory database initializes', initial.ok && Array.isArray(initial.value?.records), initial)
  const at = Date.now()
  const userText = `Professor Example teaches COURSE101. I am assigned to group 5 for the water quality project, through ${endDate}.`
  const record = { id: 'memory-source', title: 'Water quality project', createdAt: at, updatedAt: at, modelId: 'memory-fixture', messages: [{ role: 'user', content: userText }], transcript: [{ kind: 'user', id: 'source-user', at, text: userText }], checkpoints: [] }
  await page.evaluate(`chrome.storage.local.set(${JSON.stringify({ 'chat-ids': [record.id], [`chat:${record.id}`]: record, [`meta:${record.id}`]: { id: record.id, title: record.title, createdAt: at, updatedAt: at, preview: userText } })})`)
  check('saved chat is automatically captured', await waitFor('(async()=>{const r=await chrome.runtime.sendMessage({target:"background",type:"memory.command",payload:{command:"list"}});return r.value?.pending>0})()'))
  await command({ command: 'run' })
  check('local fixture inference creates a sourced memory', await waitFor('(async()=>{const r=await chrome.runtime.sendMessage({target:"background",type:"memory.command",payload:{command:"list"}});return r.value?.records.some(m=>m.body.includes("group 5"))})()'))
  let state = (await command({ command: 'list' })).value
  const memory = state.records.find(m => m.subject === 'course101.water-quality.group')
  check('memory has correct lifetime and source origin', memory?.validUntil === endDate && memory.sources[0]?.origin === 'human', memory)
  const tab = await page.evaluate(`chrome.tabs.create({url:"http://127.0.0.1:${fixturePort}/course/course101/project",active:false})`)
  await delay(300)
  async function turn(name, prompt) {
    const before = requests.length
    const record = { id: name, title: name, createdAt: Date.now(), updatedAt: Date.now(), modelId: 'memory-fixture', transcript: [{ kind: 'user', id: `${name}-user`, text: prompt, at: Date.now() }], messages: [], checkpoints: [] }
    const messages = [{ role: 'user', content: prompt, providerOptions: { harness: { contextTabId: tab.id } } }]
    const result = await page.evaluate(`(async()=>{
      const p=chrome.runtime.connect({name:"agent-execution-host-v1"});
      return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{p.disconnect();reject(new Error("Turn timeout"))},20000);
        p.onMessage.addListener(m=>{if(m.type==="snapshot"&&m.snapshot.runId===${JSON.stringify(name)}&&!["running","cancelling"].includes(m.snapshot.status)){clearTimeout(timer);p.disconnect();resolve(m.snapshot)}});
        p.postMessage({type:"start",runId:${JSON.stringify(name)},options:${JSON.stringify({ chatId: name, settings, record, messages })}});
      });
    })()`)
    return { result, calls: requests.slice(before) }
  }
  const first = await turn('memory-recall', 'Which group am I in for the water quality project? Read the page too.')
  check('new chat remembers without a preliminary memory inference', first.calls[0]?.body.model === 'memory-fixture', first.calls.map(r => r.body.model))
  check('real tool loop completes', first.result.status === 'done' && first.calls.filter(r => r.body.model === 'memory-fixture').length === 2, first.result.error)
  const envelopes = first.calls.filter(r => r.body.model === 'memory-fixture').map(r => r.body.messages.filter(m => m.role === 'user').flatMap(m => [...String(m.content).matchAll(/<continuity>[\s\S]*?<\/continuity>/g)]))
  check('memory is present once after revisiting/reading its page', envelopes.every(e => e.length === 1), envelopes.map(e => e.length))
  check('tool outcomes carry the actual build version', first.result.record.transcript.some(t => t.kind === 'tool' && t.harnessVersion && t.status === 'done'))

  await page.evaluate('document.querySelector("button[title=Settings]").click()')
  await waitFor('!!document.querySelector("#settings-tab-memory")')
  await page.evaluate('document.querySelector("#settings-tab-memory").click()')
  check('memory card renders in Settings', await waitFor('!!document.querySelector(".memory-card")'))
  const screenshot = async name => { await delay(200); const shot = await page.send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, `${name}.png`), Buffer.from(shot.data, 'base64')) }
  for (const [width, theme] of [[360, 'dark'], [320, 'light'], [1000, 'dark']]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false })
    await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
    await screenshot(`memories-${width}-${theme}`)
    const dimensions = await page.evaluate('Array.from(document.querySelectorAll(".memories,.modal--settings,.settings-body")).map(e=>({width:e.clientWidth,scroll:e.scrollWidth}))')
    check(`memory view fits ${width}px ${theme}`, dimensions.every(d => d.scroll <= d.width + 2), dimensions)
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 850, deviceScaleFactor: 1, mobile: false })
  await page.evaluate('document.querySelector(".memory-card").click()')
  check('detail view exposes source and activation cues', await waitFor('document.body.textContent.includes("Comes to mind")&&!!document.querySelector(".memory-sources")'))
  await page.evaluate('document.querySelector(".memory-sources").open=true')
  await screenshot('memory-detail')
  await page.evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Edit memory").click()')
  await waitFor('!!document.querySelector(".memory-editor")')
  await page.evaluate('document.querySelector(".memory-editor details").open=true; const e=Array.from(document.querySelectorAll(".memory-editor label")).find(l=>l.textContent.includes("Stop using after")).querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"2000-01-01");e.dispatchEvent(new Event("input",{bubbles:true}));')
  await page.evaluate('document.querySelector(".memory-editor").requestSubmit()')
  check('user edit persists and immediately expires the memory', await waitFor('!document.querySelector(".memory-editor")&&document.querySelector(".memory-life")?.textContent==="Past"'))
  const expired = await turn('expired-recall', 'Which group am I in for the water quality project?')
  check('expired memory is not activated by a matching open tab', expired.calls.filter(r => r.body.model === 'memory-fixture').every(r => !r.body.messages.some(m => String(m.content).includes('course101.water-quality.group'))))
  await screenshot('memory-expired')
  await page.evaluate('Array.from(document.querySelectorAll(".memory-actions button")).find(b=>b.textContent==="Forget").click()')
  await waitFor('!!document.querySelector(".memory-confirm")')
  await page.evaluate('Array.from(document.querySelectorAll(".memory-confirm button")).find(b=>b.textContent==="Forget memory").click()')
  check('forget removes the saved record', await waitFor('(async()=>{const r=await chrome.runtime.sendMessage({target:"background",type:"memory.command",payload:{command:"list"}});return r.value?.records.length===0&&r.value?.state.suppressions.length>0})()'))
  const exported = await command({ command: 'export' })
  check('export reflects forgetting', exported.ok && exported.value.records.length === 0)
  await command({ command: 'run' }); await delay(500)
  check('background replay does not resurrect forgotten evidence', (await command({ command: 'list' })).value.records.length === 0)
  await screenshot('memory-empty')
  check('no uncaught browser errors', errors.length === 0, errors)
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, requests: requests.map(r => ({ at: r.at, model: r.body.model })), profile, fixturePort }, null, 2))
  if (checks.some(c => !c.ok)) process.exitCode = 1
} finally {
  for (const socket of sockets) socket.close()
  chrome.kill('SIGTERM'); server.close()
  await delay(300)
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
