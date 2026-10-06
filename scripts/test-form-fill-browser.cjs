// Real production CdpService.fill/select and form-page code, through real CDP.
// Bundle with the driver into /tmp/form-fill-e2e/run.js (see docs/research/form-fill-implementation.md).
// Serve scripts on localhost:8767; run in your OWN Playwriter session, repeating
// until done:true. Only the raw Chrome transport and cosmetic cursor are adapted.
var fs = require('node:fs');
if (!state.productionFormTest) {
  var library = FormDriver;
  var owned = await context.newPage();
  await owned.goto('http://127.0.0.1:8767/form-actions-fixture.html', {waitUntil:'domcontentloaded'});
  console.log('URL:', owned.url());
  console.log(await snapshot({page:owned}));
  console.log(await getLatestLogs({page:owned,sinceLastCall:true}));
  var cdp = await getCDPSession({page:owned});
  await cdp.send('Accessibility.enable');
  var impl = Object.create(library.CdpServiceImpl.prototype);
  Object.assign(impl, {
    tabState: new Map([[1,{refMap:new Map()}]]), fillingTabs:new Set(),
    activityCursor:{show(){},async showAndWait(){}},
    send: async (_tab, method, params, signal) => {
      if(signal?.aborted) throw new DOMException('Cancelled','AbortError');
      return cdp.send(method, params);
    },
  });
  var scenarios = [
    {name:'immediate',config:{},expected:4},
    {name:'delayed-open',config:{openDelay:100},expected:4},
    {name:'delayed-commit',config:{commitDelay:140},expected:4},
    {name:'lingering-popup',config:{exitDelay:250},expected:4},
    {name:'rerender',config:{rerender:true},expected:4},
    {name:'unrelated-options',config:{decoy:true},expected:4},
    {name:'reordered-options',config:{reordered:true},expected:4},
    {name:'duplicate-option',config:{duplicate:true},expected:0},
    {name:'missing-option',config:{missing:true},expected:0},
    {name:'disabled',config:{disabled:true},expected:0},
    {name:'dependent-question',config:{dependent:true},expected:1},
    {name:'rejected-selection',config:{reject:true},expected:0},
    {name:'no-popup-link',config:{},expected:4,unlink:true},
    {name:'native-mixed',native:true,expected:3},
    {name:'already-satisfied',native:true,already:true,expected:3},
    {name:'native-events',native:true,events:true,expected:1},
    {name:'native-duplicate',native:true,duplicate:true,expected:0},
    {name:'changed-earlier-value',native:true,reset:true,expected:1},
    {name:'covered-control',config:{},covered:true,expected:0},
    {name:'missing-explicit-link',config:{decoy:true},wrongLink:true,expected:0},
    {name:'duplicate-popup-links',config:{},dualLink:true,expected:4},
    {name:'unknown-checkbox-state',native:true,unknownCheck:true,expected:0},
    {name:'already-open-dropdown',config:{},open:true,expected:4},
  ];
  state.productionFormTest={page:owned,cdp,impl,service:library.guardFormActions(impl),queue:scenarios,results:[]};
}
var h=state.productionFormTest;
for(var count=0;count<4 && h.queue.length;count++) {
  var test=h.queue.shift();
  await h.page.evaluate(config=>window.configure(config),test.config||{});
  if(test.unlink) await h.page.evaluate(()=>{
    // Simulate a custom component with no explicit popup relationship.
    for(const b of document.querySelectorAll('#form button')) {
      const open=b.onclick;
      b.onclick=function(e){open.call(this,e);this.removeAttribute('aria-controls')};
    }
  });
  if(test.covered) await h.page.evaluate(()=>{
    const overlay=document.createElement('div');overlay.id='test-overlay';overlay.style.cssText='position:fixed;inset:0;background:white;z-index:99999';document.body.append(overlay);
  });
  if(test.wrongLink||test.dualLink) await h.page.evaluate(test=>{
    for(const b of document.querySelectorAll('#form button')){
      const open=b.onclick;b.onclick=function(e){open.call(this,e);if(test.wrongLink)this.setAttribute('aria-controls','missing-popup');else this.setAttribute('aria-owns',this.getAttribute('aria-controls'));};
    }
  },test);
  if(test.native) await h.page.evaluate(test=>{
    document.getElementById('form').innerHTML=`<label>Name <input id="name" value="old" /></label><label>State <select id="state"><option>Yes</option><option>No</option>${test.duplicate?'<option>No</option>':''}</select></label><label><input id="check" type="checkbox"/>Confirmed</label><button id="next" disabled>Save</button>`;
    window.nativeEvents=[];
    document.getElementById('name').addEventListener('input',()=>{document.getElementById('next').disabled=false;});
    document.getElementById('state').addEventListener('input',()=>window.nativeEvents.push('input'));
    document.getElementById('state').addEventListener('change',()=>{
      window.nativeEvents.push('change');
      if(test.reset) document.getElementById('name').value='reset';
    });
    if(test.unknownCheck) document.getElementById('check').indeterminate=true;
    if(test.already){document.getElementById('name').value='Ada';document.getElementById('state').value='No';document.getElementById('check').checked=true;}
  },test);
  var tree=await h.cdp.send('Accessibility.getFullAXTree');
  var nodes=tree.nodes.filter(n=>!n.ignored);
  var targets=test.native
    ? [nodes.find(n=>n.role?.value==='textbox' && n.name?.value?.trim()==='Name'),nodes.find(n=>n.role?.value==='combobox' && n.name?.value?.trim()==='State'),nodes.find(n=>n.role?.value==='checkbox' && n.name?.value?.trim()==='Confirmed')]
    : nodes.filter(n=>n.role?.value==='button' && n.name?.value==='Select One Required');
  if(targets.some(n=>!n)||targets.length!==(test.native?3:4)) throw new Error('Fixture capture failed');
  h.impl.tabState.get(1).refMap=new Map(targets.map((n,i)=>[`e${i}`,n.backendDOMNodeId]));
  if(test.open){await h.service.click(1,'e0');console.log(await snapshot({page:h.page}));console.log(await getLatestLogs({page:h.page,sinceLastCall:true}));}
  var fields=test.native?[{ref:'e0',text:'Ada'},{ref:'e1',select:'No'},{ref:'e2',checked:true}]:targets.map((_,i)=>({ref:`e${i}`,select:'No'}));
  if(test.events||test.duplicate) fields=[fields[1]];
  if(test.unknownCheck) fields=[fields[2]];
  var start=Date.now();
  var result=test.events?await h.service.select(1,'e1','No'):await h.service.fill(1,fields);
  var elapsedMs=Date.now()-start;
  await h.page.evaluate(()=>window.fixture.idle());
  var truth=test.native?await h.page.evaluate(()=>({
    values:[document.getElementById('name').value,document.getElementById('state').value,document.getElementById('check').checked],events:window.nativeEvents,
  })):await h.page.evaluate(()=>window.fixture.read());
  var verified=result.fields.filter(f=>f.status==='verified').length;
  var pass=verified===test.expected;
  if(test.native) {
    if(test.unknownCheck) pass=pass&&!result.ok&&result.fields[0].status==='unattempted'&&truth.values[2]===false;
    else if(test.events) pass=pass&&result.ok&&truth.events.join(',')==='input,change';
    else if(test.duplicate) pass=pass&&!result.ok&&truth.events.length===0;
    else if(test.reset) pass=pass&&!result.ok&&result.fields[0].status==='uncertain'&&result.fields[2].status==='unattempted';
    else pass=pass&&result.ok&&JSON.stringify(truth.values)===JSON.stringify(['Ada','No',true])&&(!test.already||truth.events.length===0);
  } else pass=pass&&truth.values.filter(v=>v==='No').length===test.expected&&!truth.unintended&&!truth.boundaryExceeded&&result.ok===(test.expected===4);
  h.results.push({test:test.name,pass,elapsedMs,result,truth});
  console.log(h.results.at(-1));
  if(test.covered) await h.page.evaluate(()=>document.getElementById('test-overlay')?.remove());
  console.log(await getLatestLogs({page:h.page,sinceLastCall:true}));
}
fs.writeFileSync('/tmp/form-fill-e2e/results.json',JSON.stringify({results:h.results,remaining:h.queue.length},null,2));
console.log({done:!h.queue.length,runs:h.results.length,failed:h.results.filter(r=>!r.pass).length,remaining:h.queue.length});
if(!h.queue.length){await h.page.close();delete state.productionFormTest;}
