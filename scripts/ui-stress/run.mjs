// Runs production UI components against deterministic service fixtures in a new
// sandboxed Chrome profile. No installed browser sessions or model APIs are used.
import { createServer } from 'vite'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { findChrome } from '../chrome-binary.mjs'

const output = resolve(process.env.UI_STRESS_OUTPUT || '/tmp/handoff-ui-stress')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'ai-ui-stress-chrome-'))
const server = await createServer({
  configFile: false, root: process.cwd(), logLevel: 'error',
  plugins: [{ name: 'ui-stress-store-boundary', transform(source, id) {
    if (!id.endsWith('/src/ui/store.ts')) return
    // Test-only access to the real store. Skip startup services, but exercise
    // real subscriptions, reveal buffering, App composition and state changes.
    return `${source}\nexport function __uiStressSetState(patch) { initPromise = Promise.resolve(); setState(patch) }\n`
  } }],
  define: { __DEV_BUILD__: 'false' }, esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
})
await server.listen()
const port = server.httpServer.address().port
const chromePath = await findChrome()
const chrome = spawn(chromePath, [
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--headless=new',
  '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions',
  '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
  '--window-size=400,850', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = ''
chrome.stderr.on('data', data => { stderr += data })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let socket
let nextId = 0
const pending = new Map()
const exceptions = []
const consoleErrors = []
const report = { generatedAt: new Date().toISOString(), profile, sandboxEnabled: true, chrome: chromePath, runs: [], exceptions, consoleErrors }
try {
  let endpoint
  for (let n = 0; n < 100; n++) {
    try { endpoint = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch {}
    await delay(100)
  }
  if (!endpoint) throw new Error(`Chrome did not start: ${stderr.slice(-2000)}`)
  await writeFile(join(output, 'connection.json'), JSON.stringify({ port: Number(endpoint), profile, url: `http://127.0.0.1:${port}/scripts/ui-stress/` }))
  const targets = await (await fetch(`http://127.0.0.1:${endpoint}/json/list`)).json()
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const callback = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) callback?.reject(new Error(JSON.stringify(message.error)))
      else callback?.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '))
    else if (message.method === 'Fetch.requestPaused') {
      // All browser requests stay local to this fixture, including account/model catalogs.
      const { requestId, request } = message.params
      const local = request.url.startsWith(`http://127.0.0.1:${port}/`) || /^(data|blob):/.test(request.url)
      void send(local ? 'Fetch.continueRequest' : 'Fetch.fulfillRequest', local ? { requestId } : {
        requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: btoa('{"data":[],"models":[]}'),
      }).catch(error => {
        // React may cancel a preview/catalog request while this reply is in flight.
        if (!String(error).includes('Invalid InterceptionId')) exceptions.push({ message: String(error) })
      })
    }
  }
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 850, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/scripts/ui-stress/` })
  for (let n = 0; n < 300; n++) { if (await evaluate('!!window.uiStress')) break; await delay(100) }
  if (!await evaluate('!!window.uiStress')) throw new Error('Fixture did not load: ' + JSON.stringify(exceptions))
  const toolsSource = await readFile('src/agent/tools.ts', 'utf8')
  const names = [...new Set([...toolsSource.matchAll(/(?:\b([a-z_]+):\s*tool\(|tools\.([a-z_]+)\s*=\s*tool\()/g)].map(m => m[1] || m[2]))]
  report.tools = names
  const modes = process.env.UI_STRESS_MODES?.split(',') || ['400:normal:dark', '320:normal:light', '1200:normal:dark', '400:reduce:dark']
  const suites = process.env.UI_STRESS_SUITES?.split(',') || ['matrix', 'transitions', 'markdown', 'surfaces', 'delegation', 'continuity', 'app', 'reasoning', 'actions', 'interactions', 'stress', 'motion', 'motion-change']
  const codeSource = await readFile('src/ui/code-actions.ts', 'utf8')
  const codePaths = [...new Set([...codeSource.matchAll(/case '([^']+)':/g)].map(m => m[1]))]
  for (const mode of modes) {
    const [width, motion, theme, height = '850'] = mode.split(':')
    await send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion === 'reduce' ? 'reduce' : 'no-preference' }] })
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
    await evaluate(`document.documentElement.dataset.view = ${JSON.stringify(Number(width) >= 700 ? 'tab' : 'panel')}`)
    for (const suite of suites) {
      let run
      if (suite === 'motion-change') {
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
        await evaluate('window.uiStress.motionPreferencePrepare()')
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
        run = await evaluate('window.uiStress.motionPreferenceFinish()')
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion === 'reduce' ? 'reduce' : 'no-preference' }] })
      } else run = await evaluate(`window.uiStress.run(${JSON.stringify(suite)}, ${JSON.stringify(suite === 'actions' ? codePaths : names)})`)
      report.runs.push({ mode, ...run })
      console.log(`${mode} ${suite}: ${run.checks} checks, ${run.failures.length} failures, ${run.errors.length} errors`)
      if (run.failures.length) console.log(JSON.stringify(run.failures.slice(0, 8)))
      await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(output, `${mode.replaceAll(':', '-')}-${suite}.png`), Buffer.from(shot.data, 'base64'))
    }
  }
  const failed = report.runs.some(run => run.failures.length || run.errors.length) || exceptions.length || consoleErrors.length
  console.log(`Report: ${join(output, 'report.json')}`)
  process.exitCode = failed ? 1 : 0
  if (process.env.UI_STRESS_KEEP_OPEN === '1') {
    console.log('Keeping isolated browser and fixture server open for inspection (Ctrl+C to close).')
    await new Promise(resolve => process.once('SIGINT', resolve))
  }
} finally {
  socket?.close()
  chrome.kill('SIGTERM')
  // Paused fixture fetches and keep-alive connections must not hold teardown open.
  server.httpServer?.closeAllConnections()
  await server.close()
  await delay(250)
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
