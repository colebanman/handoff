// Run in the same Playwriter session after reloading the dev extension.
const assert = require('node:assert').strict
const fs = require('node:fs')
assert.ok(state.replId, 'Run repl-e2e.mjs first')
if (!state.dev || state.dev.isClosed()) state.dev = await context.newPage()
assert.match(state.handoffExtensionURL ?? '', /^chrome-extension:\/\/[a-p]{32}\/sidepanel\.html$/, 'Set state.handoffExtensionURL first')
await state.dev.goto(state.handoffExtensionURL)
console.log(await getLatestLogs({page:state.dev,sinceLastCall:true,count:3}))
const moduleFile = fs.readdirSync('dist-dev/assets').find((name) => /^replTest-.*\.js$/.test(name))
const result = await state.dev.evaluate(async ({moduleFile,id,fixtureURL}) => {
  await import(chrome.runtime.getURL(`assets/${moduleFile}`))
  const h = __replE2E.harness()
  globalThis.replHarness = h
  const tabId = (await chrome.tabs.query({url:'http://127.0.0.1:8766/*'})).find(tab=>tab.url===fixtureURL)?.id
  // Prior test-page reloads can leave our own debugger attached to this fixture.
  await chrome.debugger.detach({tabId}).catch(() => {})
  const run = async (code, extra = {}) => h.sandbox.exec({code,sessionId:'after-extension-reload',scope:{getCurrentTabId:()=>tabId},...extra})
  globalThis.replRunRaw = run
  const entries = await h.vfs.extensions('list')
  if (!entries.some(e => e.id === id && e.revision === 2)) throw new Error('Published code did not survive extension reload/schema upgrade')
  const invoked = await run(`return {count:await apps.${id}.count([1,2,3]), found:(await apps.${id}.api.search({text:'chapter'})).length};`)
  if (!invoked.ok || JSON.parse(invoked.value).found !== 1) throw new Error(JSON.stringify(invoked))
  await h.vfs.extensions('disable',{id})
  const disabled = await run(`return await apps.${id}.count([]);`)
  if (disabled.ok || !disabled.error.includes('disabled')) throw new Error('Disabled extension still callable')
  await h.vfs.extensions('disable',{id,disabled:false})
  await h.vfs.extensions('rollback',{id,revision:1,expectedRevision:2})
  const removedMethod = await run(`return await apps.${id}.count([]);`)
  const original = await run(`return await apps.${id}.api.search({text:'chapter'});`)
  if (removedMethod.ok || !original.ok) throw new Error('Rollback failed')
  await h.vfs.extensions('rollback',{id,revision:2,expectedRevision:1})
  // Exercise the real SDK/agent loop while a deterministic provider discards
  // all docs during compaction, then asks for an actual sandbox function call.
  const originalFetch = globalThis.fetch
  const sent = []
  let inference = 0
  let compacted = 0
  const sse = (events) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}})
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.openai.com/v1/responses')) return originalFetch(url,init)
    const body = JSON.parse(init.body)
    if (String(url).endsWith('/compact')) { compacted++; return Response.json({output:[{type:'compaction',encrypted_content:'test-opaque-state'}],usage:{output_tokens:10}}) }
    sent.push(body)
    const created = {type:'response.created',response:{id:'resp_test',created_at:1,model:'gpt-4o'}}
    if (++inference === 1) {
      const call = {type:'function_call',id:'fc_test',call_id:'call_test',name:'sandbox_exec',arguments:JSON.stringify({intent:'Reading saved course announcements',code:`return await apps.${id}.api.search({text:'chapter'});`}),status:'completed'}
      return sse([created,{type:'response.output_item.added',output_index:0,item:{...call,arguments:''}},
        {type:'response.function_call_arguments.delta',item_id:call.id,output_index:0,delta:call.arguments},
        {type:'response.output_item.done',output_index:0,item:call},
        {type:'response.completed',response:{output:[call],usage:{input_tokens:500,output_tokens:30}}}])
    }
    const msg = {type:'message',id:'msg_test',role:'assistant',status:'completed',content:[{type:'output_text',text:'Read chapter four',annotations:[]}]}
    return sse([created,{type:'response.output_item.added',output_index:0,item:msg},
      {type:'response.output_text.delta',item_id:msg.id,output_index:0,content_index:0,delta:'Read chapter four'},
      {type:'response.output_item.done',output_index:0,item:msg},
      {type:'response.completed',response:{output:[msg],usage:{input_tokens:600,output_tokens:10}}}])
  }
  let loop
  try {
    loop = await __replE2E.runLoop({
      ctx:{agentId:'repl-e2e',currentTabId:tabId},
      settings:{...__replE2E.DEFAULT_SETTINGS,provider:'openai',openaiAuthMode:'api-key',apiKey:'test',modelId:'gpt-4o'},
      modelId:'gpt-4o',messages:[{role:'user',content:'Check test course. '+ 'old history '.repeat(18000)}],
      signal:new AbortController().signal,emit:()=>{},deps:h,spawnSubagent:async()=>'',tasks:{list:()=>[]},
      sandboxSessionId:'compacted-repl-e2e',isSubagent:false,onStepLimit:async()=>false,
    })
  } finally { globalThis.fetch = originalFetch }
  if (loop.errorText) throw new Error(loop.errorText)
  if (!compacted || sent.length !== 2) throw new Error('Did not exercise compaction and a real tool loop: '+JSON.stringify({compacted,sent:sent.length,loop}))
  for (const request of sent) {
    if ((JSON.stringify(request.input.filter(item=>!['system','developer'].includes(item.role))).match(/<repl-extensions>/g) ?? []).length !== 1) throw new Error('Missing or duplicated REPL docs on the wire')
    if (!JSON.stringify(request.input).includes(`apps.${id}.api.search`)) throw new Error('Wrong docs')
  }
  const toolOutputs = loop.responseMessages.filter(m=>m.role==='tool')
  if (!JSON.stringify(toolOutputs).includes('Read chapter four')) throw new Error('The saved function did not return the actual site record')
  return {persisted:true,disabled:true,rollback:true,compacted,requests:sent.length,docsPerRequest:sent.map(r=>(JSON.stringify(r.input.filter(item=>!['system','developer'].includes(item.role))).match(/<repl-extensions>/g)??[]).length),answer:loop.text}
}, {moduleFile,id:state.replId,fixtureURL:state.fixture.url()})
console.log('PASS real extension reload + persisted code + disable/rollback + actual SDK and sandbox after 40% compaction',result)
console.log(await getLatestLogs({page:state.dev,sinceLastCall:true,search:/error|failed/i,count:5}))
