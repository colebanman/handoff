// Real React Select fixture. The test dependency is development-only and is
// never imported by the extension's production entries.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import Select from 'react-select';
import AsyncSelect from 'react-select/async';
const root = createRoot(document.getElementById('app'));
const choices = [{label:'Yes',value:'yes'},{label:'No',value:'no'}];
let generation = 0;
function App({config}) {
  const count = config.mixed ? 6 : 2;
  const [values,setValues] = useState(Array.from({length:count},()=>config.initial ? choices.find(o=>o.label===config.initial) : null));
  const [texts,setTexts] = useState(Array(6).fill(''));
  const [queries,setQueries] = useState(Array(count).fill(''));
  const [revision,setRevision] = useState(0);
  const [dependent,setDependent] = useState(false);
  window.fixtureModel = { values:values.map(v=>Array.isArray(v)?v.map(o=>o.label):v?.label??null), texts:[...texts], queries:[...queries] };
  useEffect(()=>{window.fixtureReady=true;},[]);
  const update=(i,value)=>{
    window.fixtureChanges++;
    if(config.reject||config.queryOnly) return;
    setValues(old=>old.map((v,n)=>n===i?value:v));
    if(config.rerender && i===0)setRevision(r=>r+1);
    if(config.dependent && i===0)setDependent(true);
  };
  return <form onSubmit={e=>{e.preventDefault();window.fixtureSubmits++;}}>
    <h1>Combobox regression fixture</h1>
    {config.mixed&&texts.map((v,i)=><label key={i}>Text {i+1}<input data-plain="" id={'plain-'+i} value={v} onChange={e=>setTexts(old=>old.map((s,n)=>n===i?e.target.value:s))}/></label>)}
    {Array.from({length:count},(_,i)=>{
      const Component=config.async?AsyncSelect:Select;
      const options=config.duplicate?[...choices,{label:'No',value:'another-no'}]:choices;
      return <section key={i+':'+revision}>
        <label id={'label-'+i} htmlFor={'choice-'+i}>Answer {i+1}</label>
        <Component inputId={'choice-'+i} instanceId={'choice-'+i} name={'answer-'+i} aria-labelledby={'label-'+i}
          classNamePrefix={config.noPrefix?undefined:(config.prefix||'select')} isMulti={!!config.multi} isSearchable={!config.readonly}
          isClearable={true} options={options} value={values[i]} onChange={v=>update(i,v)}
          defaultInputValue={config.initialQuery||''}
          inputValue={config.queryOnly?queries[i]:undefined}
          onInputChange={(text,action)=>{if(action.action==='input-change')setQueries(old=>old.map((s,n)=>n===i?text:s));}}
          loadOptions={input=>new Promise(resolve=>setTimeout(()=>resolve(options.filter(o=>o.label.toLowerCase().includes(input.toLowerCase()))),120))}
          defaultOptions={false} menuPortalTarget={config.portal?document.body:undefined}/>
      </section>;
    })}
    {dependent&&<label>New detail<input required aria-label="New detail"/></label>}
    {config.unrelated&&<aside className="select__value-container"><div className="select__single-value">No</div></aside>}
    <button type="submit">Submit</button>
  </form>;
}
window.configureCombobox=(config={})=>{
  window.fixtureReady=false;window.fixtureChanges=0;window.fixtureSubmits=0;
  flushSync(()=>root.render(<App key={++generation} config={config}/>));
};
window.fixtureTargets=()=>Array.from(document.querySelectorAll('input[data-plain],input[role=combobox]'));
window.configureCombobox();
