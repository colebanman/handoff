// Bundled with the production driver by build-form-fill-test.mjs --combobox.
var fs=require('node:fs');
if(!state.comboboxTest){
  var owned=await context.newPage();await owned.goto('http://127.0.0.1:8768/',{waitUntil:'domcontentloaded'});
  console.log(owned.url());console.log(await snapshot({page:owned}));console.log(await getLatestLogs({page:owned,sinceLastCall:true}));
  var cdp=await getCDPSession({page:owned});await cdp.send('Accessibility.enable');
  var impl=Object.create(FormDriver.CdpServiceImpl.prototype);
  Object.assign(impl,{tabState:new Map([[1,{refMap:new Map()}]]),fillingTabs:new Set(),activityCursor:{show(){},async showAndWait(){}},
    send:async(_tab,method,params,signal)=>{if(signal?.aborted)throw new DOMException('Cancelled','AbortError');return cdp.send(method,params);}});
  var tests=[
    {name:'greenhouse-twelve-field-batch',config:{mixed:true},expected:12},
    {name:'async-query-options',config:{async:true},expected:2},
    {name:'portal-popup',config:{portal:true},expected:2},
    {name:'rerender-later-inputs',config:{rerender:true},expected:2},
    {name:'custom-class-prefix',config:{prefix:'application'},expected:2},
    {name:'default-classes',config:{noPrefix:true},expected:2},
    {name:'already-selected',config:{initial:'No'},expected:2,noChange:true},
    {name:'non-searchable-select',config:{readonly:true,initial:'Yes'},expected:2},
    {name:'default-non-searchable-select',config:{readonly:true,noPrefix:true,initial:'Yes'},expected:2},
    {name:'replace-existing-query',config:{initialQuery:'Y'},expected:2},
    {name:'rejected-selection',config:{reject:true},expected:0,unconfirmed:true},
    {name:'query-is-not-committed-value',config:{queryOnly:true,unrelated:true},expected:0,unconfirmed:true},
    {name:'duplicate-labels',config:{duplicate:true},expected:0},
    {name:'multi-select-safe-stop',config:{multi:true},expected:0},
    {name:'new-dependent-question',config:{dependent:true},expected:1},
  ];
  state.comboboxTest={page:owned,cdp,impl,service:FormDriver.guardFormActions(impl),queue:tests,results:[]};
}
var h=state.comboboxTest;
for(var n=0;n<3&&h.queue.length;n++){
  var test=h.queue.shift();await h.page.evaluate(config=>window.configureCombobox(config),test.config);
  await h.page.waitForFunction(()=>window.fixtureReady);
  var remote=await h.cdp.send('Runtime.evaluate',{expression:'window.fixtureTargets()',objectGroup:'fixture-capture',returnByValue:false});
  var props=await h.cdp.send('Runtime.getProperties',{objectId:remote.result.objectId,ownProperties:true});var refs=[];
  for(var p of props.result.filter(p=>/^\d+$/.test(p.name))){var r=await h.cdp.send('DOM.describeNode',{objectId:p.value.objectId});refs.push([`e${p.name}`,r.node.backendNodeId]);}
  await h.cdp.send('Runtime.releaseObjectGroup',{objectGroup:'fixture-capture'});h.impl.tabState.get(1).refMap=new Map(refs);
  var fields=refs.map(([ref],i)=>test.config.mixed&&i<6?{ref,text:'Example '+i}:{ref,select:'No'});
  var start=Date.now();var result=await h.service.fill(1,fields);var elapsedMs=Date.now()-start;
  var truth=await h.page.evaluate(()=>({model:window.fixtureModel,changes:window.fixtureChanges,submits:window.fixtureSubmits,
    queries:window.fixtureTargets().filter(e=>e.getAttribute('role')==='combobox').map(e=>e.value)}));
  var verified=result.fields.filter(f=>f.status==='verified').length;
  var pass=verified===test.expected&&truth.submits===0&&result.ok===(test.expected===fields.length);
  if(test.expected===fields.length)pass=pass&&truth.model.values.every(v=>v==='No')&&truth.queries.every(q=>q==='')&&(!test.config.mixed||truth.model.texts.every((v,i)=>v==='Example '+i));
  else if(test.config.dependent)pass=pass&&truth.model.values[0]==='No'&&truth.model.values[1]===null;
  else pass=pass&&truth.model.values.every(v=>v===null||Array.isArray(v)&&v.length===0);
  if(test.noChange)pass=pass&&truth.changes===0;
  else if(test.expected===fields.length)pass=pass&&truth.changes===(test.config.mixed?6:2);
  if(test.unconfirmed)pass=pass&&result.fields[0].status==='uncertain';
  h.results.push({name:test.name,pass,elapsedMs,result,truth});console.log(h.results.at(-1));console.log(await getLatestLogs({page:h.page,sinceLastCall:true}));
}
fs.writeFileSync('/tmp/form-fill-combobox/results.json',JSON.stringify({results:h.results,remaining:h.queue.length},null,2));
console.log({done:!h.queue.length,tested:h.results.length,failed:h.results.filter(r=>!r.pass).length,remaining:h.queue.length});
if(!h.queue.length){await h.page.close();delete state.comboboxTest;}
