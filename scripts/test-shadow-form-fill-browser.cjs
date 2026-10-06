// Bundled with real CdpService code by build-form-fill-test.mjs --shadow.
var fs = require('node:fs');
if (!state.shadowFormTest) {
  var owned=await context.newPage();
  await owned.goto('http://127.0.0.1:8767/form-actions-fixture.html',{waitUntil:'domcontentloaded'});
  console.log(owned.url());console.log(await snapshot({page:owned}));console.log(await getLatestLogs({page:owned,sinceLastCall:true}));
  await owned.addScriptTag({url:'http://127.0.0.1:8767/form-shadow-fixture.js?v='+Date.now()});
  var cdp=await getCDPSession({page:owned});await cdp.send('Accessibility.enable');
  var impl=Object.create(FormDriver.CdpServiceImpl.prototype);
  Object.assign(impl,{tabState:new Map([[1,{refMap:new Map()}]]),fillingTabs:new Set(),activityCursor:{show(){},async showAndWait(){}},
    send:async (_tab,method,params,signal)=>{if(signal?.aborted)throw new DOMException('Cancelled','AbortError');return cdp.send(method,params);}});
  var tests=[
    {name:'shadow-mixed-multiline',config:{},expected:3},
    {name:'plain-multiline-punctuation',config:{light:true},expected:1},
    {name:'standalone-shadow-type',config:{},standalone:true,expected:1},
    {name:'shadow-controls-and-native-events',config:{choices:true},expected:4},
    {name:'shadow-rerender-duplicate-inner-ids',config:{rerender:true},expected:3},
    {name:'shadow-new-dependent-control',config:{dependent:true},expected:1},
    {name:'shadow-disabled-host',config:{disabled:true},expected:0},
    {name:'shadow-hidden-host',config:{hidden:true},expected:0},
    {name:'shadow-covered-checkbox',config:{choices:true,covered:true},checkboxOnly:true,expected:0},
    {name:'closed-root-safe-stop',config:{closed:true},expected:0},
  ];
  state.shadowFormTest={page:owned,cdp,impl,service:FormDriver.guardFormActions(impl),queue:tests,results:[]};
}
var h=state.shadowFormTest;
for(var n=0;n<3&&h.queue.length;n++){
  var test=h.queue.shift();await h.page.evaluate(c=>window.configureShadow(c),test.config);
  console.log(await snapshot({page:h.page,search:/Location|Description|answer|Confirmed/}));
  var remote=await h.cdp.send('Runtime.evaluate',{expression:'window.shadowFixture.targets',objectGroup:'fixture-capture',returnByValue:false});
  var props=await h.cdp.send('Runtime.getProperties',{objectId:remote.result.objectId,ownProperties:true});
  var refs=[];
  for(var p of props.result.filter(p=>/^\d+$/.test(p.name))){var node=await h.cdp.send('DOM.describeNode',{objectId:p.value.objectId});refs.push([`e${p.name}`,node.node.backendNodeId]);}
  await h.cdp.send('Runtime.releaseObjectGroup',{objectGroup:'fixture-capture'});
  h.impl.tabState.get(1).refMap=new Map(refs);
  var text='• Build APIs & dashboards; “quoted” — Café\n• Preserve lines, tabs\tand symbols: 你好 🧪';
  var fields=test.config.light?[{ref:'e0',text}]:test.config.choices?[{ref:'e0',select:'No'},{ref:'e1',select:'No'},{ref:'e2',checked:true},{ref:'e3',select:'No'}]:[{ref:'e0',text:'Remote'},{ref:'e1',text},{ref:'e2',text:'https://example.test/a?x=1&y=2'}];
  if(test.checkboxOnly) fields=[fields[2]];
  var result,start=Date.now();
  try{if(test.standalone){await h.service.type(1,'e1',text,{clear:true});result={ok:true,fields:[{ref:'e1',status:'verified'}]};}else result=await h.service.fill(1,fields);}catch(e){result={ok:false,fields:[],stopped:String(e)}}
  var truth=await h.page.evaluate(()=>window.shadowFixture.read());
  var pass=result.fields.filter(f=>f.status==='verified').length===test.expected;
  if(test.standalone)pass=pass&&truth.values[1]===text&&truth.saved[1]===text;
  else if(test.config.light)pass=pass&&truth.values[0]===text;
  else if(test.expected===4)pass=pass&&JSON.stringify(truth.values)===JSON.stringify(['No','No',true,'No'])&&JSON.stringify(truth.saved)===JSON.stringify(truth.values);
  else if(test.expected===3)pass=pass&&JSON.stringify(truth.values)===JSON.stringify(['Remote',text,'https://example.test/a?x=1&y=2'])&&JSON.stringify(truth.saved)===JSON.stringify(['Remote',text]);
  else if(test.expected===1)pass=pass&&!result.ok&&truth.values[0]==='Remote'&&truth.values[1]==='';
  else pass=pass&&!result.ok&&(!test.checkboxOnly||truth.values[2]===false)&&(!test.config.hidden||truth.values[0]==='');
  h.results.push({name:test.name,pass,elapsedMs:Date.now()-start,result,truth});
  console.log(h.results.at(-1));console.log(await getLatestLogs({page:h.page,sinceLastCall:true}));
}
fs.mkdirSync('/tmp/form-fill-shadow-e2e',{recursive:true});fs.writeFileSync('/tmp/form-fill-shadow-e2e/results.json',JSON.stringify({results:h.results,remaining:h.queue.length},null,2));
console.log({done:!h.queue.length,passed:h.results.filter(r=>r.pass).length,total:h.results.length,remaining:h.queue.length});
if(!h.queue.length){await h.page.close();delete state.shadowFormTest;}
