// Start scripts/repl-e2e-server.mjs, build with HANDOFF_REPL_E2E=1 npm run build:dev,
// enable the dev extension, then run with playwriter -s <session> -f this file.
// Uses only a disposable localhost page. No user-site records or credentials.
const assert = require('node:assert').strict
const fs = require('node:fs')
const extensionURL = state.handoffExtensionURL
assert.match(extensionURL ?? '', /^chrome-extension:\/\/[a-p]{32}\/sidepanel\.html$/, 'Set state.handoffExtensionURL to the installed dev extension sidepanel URL first')
state.dev ??= await context.newPage()
if (state.dev.url() !== extensionURL) await state.dev.goto(extensionURL)
state.fixture ??= await context.newPage()
if (!state.fixture.url().startsWith('http://127.0.0.1:8766')) await state.fixture.goto('http://127.0.0.1:8766')
const moduleFile = fs.readdirSync('dist-dev/assets').find((name) => /^replTest-.*\.js$/.test(name))
assert.ok(moduleFile, 'Build the E2E entry first')
state.replId ??= `replCheck${Date.now()}`
const result = await state.dev.evaluate(async ({moduleFile, id}) => {
  await import(chrome.runtime.getURL(`assets/${moduleFile}`))
  globalThis.replHarness = __replE2E.harness()
  const h = replHarness
  const tabId = (await chrome.tabs.query({url:'http://127.0.0.1:8766/*'}))[0]?.id
  if (!tabId) throw new Error('Missing disposable test tab')
  const run = async (code, sessionId = 'repl-test-first', scope = {getCurrentTabId: () => tabId}) => {
    const result = await h.sandbox.exec({code,sessionId,scope,timeoutMs:15000})
    if (!result.ok) throw new Error(result.error)
    return result.value ? JSON.parse(result.value) : undefined
  }
  globalThis.replRun = run
  const source = `
async function records(ctx) {
  const response = await ctx.api.page.fetch(ctx.binding.tabId, new URL('/records', ctx.binding.origin).href);
  if (response.status !== 200) throw new Error('Records request failed');
  return JSON.parse(response.text);
}
module.exports = {
  api: { search: async (ctx, {text}) => (await records(ctx)).filter(r => r.title.includes(text)) },
  browser: { show: async (ctx) => {
    const record = (await records(ctx))[0];
    const snapshot = await ctx.api.page.snapshot(ctx.binding.tabId);
    const line = snapshot.text.split('\\n').find(line => line.includes('link') && line.includes(record.title));
    const ref = line?.match(/\\[(e\\d+)\\]/)?.[1];
    if (!ref) throw new Error('Announcement link missing');
    await ctx.api.page.click(ctx.binding.tabId, ref);
    await ctx.api.page.waitForLoad(ctx.binding.tabId, 5000);
    const text = await ctx.api.page.eval(ctx.binding.tabId, 'document.body.innerText');
    if (!text.includes(record.title)) throw new Error('Wrong displayed announcement');
    await ctx.api.tabs.activate(ctx.binding.tabId);
    return {id:record.id,title:record.title,tabId:ctx.binding.tabId};
  }}
};`
  const bundle = {
    manifest: {version:1,id,description:'Find and display test course announcements',sites:['127.0.0.1:8766/**'],triggers:['test course'],
      instructions:'Use the existing test course tab. Fetch records freshly.',
      when:{all:[{url:'127.0.0.1:8766/**'},{dom:{selector:'#latest-announcement',visible:true}}]},
      actions:{
        'api.search':{description:'Search current announcements',effects:'read',input:{type:'object',properties:{text:{type:'string'}},required:['text']},output:{type:'array'}},
        'browser.show':{description:'Show latest announcement',effects:'browser',input:{type:'object'},output:{type:'object'}}}},
    source,
    tests:[
      {name:'search',action:'api.search',mode:'live',input:{text:'chapter'},assert:[{minItems:1}]},
      {name:'show',action:'browser.show',mode:'live',input:{},assert:[{path:'id',equals:'record-1'}]},
    ],
  }
  const existing = await h.vfs.extensions('list')
  if (existing.some(e => e.id === id)) throw new Error('Use a new state.replId for a new test run')
  const staged = await run(`return await api.extensions.stage(${JSON.stringify({bundle,expectedRevision:0})});`)
  const tests = await run(`return await api.extensions.test(${JSON.stringify({draftId:staged.draftId,live:true,bindings:{tabId,origin:'http://127.0.0.1:8766'}})});`)
  if (!tests.ok) throw new Error(JSON.stringify(tests))
  const published = await run(`return await api.extensions.publish(${JSON.stringify({draftId:staged.draftId,expectedRevision:0})});`)
  const first = await run(`return await apps.${id}.api.search({text:'chapter'});`)
  const fresh = await run(`return await apps.${id}.api.search({text:'chapter'});`, 'repl-test-new-chat')
  const delivery = new __replE2E.RuntimeContextDelivery([])
  const initial = await delivery.next(h.vfs,[{role:'user',content:'Check test course'}],await chrome.tabs.query({}),{isSubagent:false,currentTabId:0})
  if (!JSON.stringify(initial).includes(`apps.${id}.api.search`)) throw new Error('Missing docs before first provider request')
  const wrongScope = await h.sandbox.exec({code:`return await apps.${id}.for({tabId:${tabId}}).api.search({text:'chapter'});`,sessionId:'scope-test',scope:{allowedTabIds:[],getCurrentTabId:()=>0}})
  if (wrongScope.ok) throw new Error('Out-of-scope extension call succeeded')
  // Independent edits race through real IndexedDB compare-and-swap publication.
  const updated = structuredClone(bundle)
  updated.manifest.actions.count = {description:'Count supplied items',effects:'local',input:{type:'array'},output:{type:'number'}}
  updated.source += '\nmodule.exports.count = async (ctx, items) => items.length;'
  updated.tests.push({name:'count',action:'count',mode:'fixture',input:[1,2],assert:[{equals:2}]})
  // Existing methods use deterministic RPC fixtures for the edit test.
  updated.tests[0] = {name:'search',action:'api.search',mode:'fixture',input:{text:'chapter'},replies:{'page.fetch':[{status:200,text:JSON.stringify([{id:'record-1',title:'Read chapter four'}])}]},assert:[{minItems:1}]}
  updated.tests[1] = {name:'show',action:'browser.show',mode:'fixture',input:{},replies:{
    'page.fetch':[{status:200,text:JSON.stringify([{id:'record-1',title:'Read chapter four'}])}],
    'page.snapshot':[{text:'[e1] link Read chapter four'}], 'page.click':[{}], 'page.waitForLoad':[{}], 'page.eval':['Read chapter four'], 'tabs.activate':[{}],
  },assert:[{path:'id',equals:'record-1'}]}
  const drafts = await Promise.all([h.vfs.extensions('stage',{bundle:updated,expectedRevision:1}),h.vfs.extensions('stage',{bundle:updated,expectedRevision:1})])
  for (const draft of drafts) {
    const check = await run(`return await api.extensions.test(${JSON.stringify({draftId:draft.draftId,bindings:{tabId,origin:'http://127.0.0.1:8766'}})});`)
    if (!check.ok) throw new Error(JSON.stringify(check))
  }
  const race = await Promise.allSettled(drafts.map(d => h.vfs.extensions('publish',{draftId:d.draftId,expectedRevision:1})))
  if (race.filter(r=>r.status==='fulfilled').length !== 1 || !String(race.find(r=>r.status==='rejected')?.reason).includes('RevisionConflict')) throw new Error('Publication race did not conflict')
  const added = await run(`return await apps.${id}.count([1,2,3]);`,'repl-test-later-chat')
  const old = await run(`return await apps.${id}.api.search({text:'chapter'});`,'repl-test-later-chat')
  return {id,revision:published.revision,first:first.length,fresh:fresh.length,added,old:old.length,scopeBlocked:!wrongScope.ok,conflict:true,docsChars:delivery.extensionBlock.length,tabId}
}, {moduleFile,id:state.replId})
assert.equal(result.first,1);assert.equal(result.fresh,1);assert.equal(result.added,3);assert.equal(result.old,1)
console.log('PASS real Chrome: stage/test/publish, API + snapshot/click/display, fresh chat, first-request docs, scope, concurrent edit, compatible method addition',result)
console.log(await snapshot({page:state.fixture}))
console.log(await getLatestLogs({page:state.dev,sinceLastCall:true,search:/error|failed/i,count:5}))
