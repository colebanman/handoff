// Shadow-root form controls with independent component state, modeled on the
// spl-input/spl-textarea shape observed in the SmartRecruiters failure trace.
window.configureShadow = (config = {}) => {
  const form = document.getElementById('form');
  form.replaceChildren();
  document.querySelectorAll('[role=listbox],#test-overlay').forEach(n => n.remove());
  const records = [], targets = [], events = [];
  const mount = (kind, label, id) => {
    const host = document.createElement('test-form-field'); host.id = id;
    host.setAttribute('label', label); host.style.cssText = 'display:block;margin:12px;width:340px';
    form.append(host);
    const root = host.attachShadow({ mode: config.closed ? 'closed' : 'open' });
    const wrapper = document.createElement('test-form-inner'); root.append(wrapper);
    const inner = wrapper.attachShadow({ mode: 'open' });
    let control;
    const render = () => {
      inner.replaceChildren();
      const style = document.createElement('style'); style.textContent = 'input,textarea,select,button{font:16px system-ui;box-sizing:border-box}textarea{width:320px;height:90px}button{width:260px;height:35px}[role=listbox]{background:white;border:1px solid}[role=option]{padding:8px}'; inner.append(style);
      control = document.createElement(kind === 'dropdown' ? 'button' : kind === 'checkbox' ? 'input' : kind);
      control.id = 'control'; control.setAttribute('aria-label', label);
      if (kind === 'checkbox') control.type = 'checkbox';
      if (kind === 'input') control.type = 'text';
      if (kind === 'select') control.innerHTML = '<option>Yes</option><option>No</option>';
      if (kind === 'dropdown') {
        control.textContent = 'Select One'; control.setAttribute('aria-haspopup','listbox'); control.setAttribute('aria-expanded','false'); control.setAttribute('aria-controls','menu');
        control.onclick = () => {
          const popup = document.createElement('div'); popup.id = 'menu'; popup.setAttribute('role','listbox');
          for (const value of ['Yes','No']) {
            const option = document.createElement('div'); option.setAttribute('role','option'); option.textContent = value;
            option.onclick = () => { control.textContent = value; record.value = value; control.setAttribute('aria-expanded','false'); popup.remove(); };
            popup.append(option);
          }
          inner.append(popup); control.setAttribute('aria-expanded','true');
        };
      }
      inner.append(control);
    };
    const record = { host, get control(){return control}, value: kind === 'checkbox' ? false : kind === 'select' ? 'Yes' : '', render };
    render();
    // This model state is deliberately outside the native node. Events must
    // cross both shadow boundaries for a saved value to update.
    // Native checkbox input is composed; its native change event deliberately
    // is not. Match normal component wiring instead of requiring an impossible
    // cross-boundary native change from a user click.
    host.addEventListener(kind === 'checkbox' ? 'input' : 'change', e => {
      events.push({id,type:e.type,composed:e.composed});
      record.value = kind === 'checkbox' ? control.checked : control.value;
      if (config.rerender && record === records[0]) records[1].render();
      if (config.dependent && record === records[0] && !inner.querySelector('[required]')) {
        const extra = document.createElement('input'); extra.required = true; extra.setAttribute('aria-label','New detail'); inner.append(extra);
      }
    });
    records.push(record); targets.push(control); return record;
  };
  if (config.light) {
    const textarea = document.createElement('textarea'); textarea.id='plain'; textarea.setAttribute('aria-label','Description'); form.append(textarea); targets.push(textarea);
  } else if (config.choices) {
    mount('dropdown','First answer','first'); mount('dropdown','Second answer','second'); mount('checkbox','Confirmed','check'); mount('select','Native answer','native');
  } else {
    mount('input','Location','location'); mount('textarea','Description','description');
    const link = document.createElement('input'); link.id='link'; link.setAttribute('aria-label','Website'); form.append(link); targets.push(link);
  }
  if (config.disabled) records[0].host.setAttribute('aria-disabled','true');
  if (config.hidden) records[0].host.setAttribute('aria-hidden','true');
  if (config.covered) { const cover=document.createElement('div');cover.id='test-overlay';cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white';document.body.append(cover); }
  window.shadowFixture = {
    targets,
    read: () => ({
      values: records.length ? [...records.map(r=>r.control.type==='checkbox'?r.control.checked:r.control.tagName==='BUTTON'?r.control.textContent:r.control.value), ...(config.choices?[]:[targets.at(-1).value])] : targets.map(n=>n.value),
      saved: records.map(r=>r.value), events,
    }),
  };
};
