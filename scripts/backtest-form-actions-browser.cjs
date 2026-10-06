// Run in an OWN Playwriter session from the repo root:
//   python3 -m http.server 8767 --bind 127.0.0.1 --directory scripts
//   playwriter -s <id> -f scripts/backtest-form-actions-browser.cjs --timeout 60000
// Reinvoke until result.done; each invocation runs at most three trials.
// Uses only a page created by this script. No live application changes/model calls.
var fs = require('node:fs');
if (!state.formBacktest) {
  var owned = await context.newPage();
  await owned.goto('http://127.0.0.1:8767/form-actions-fixture.html', { waitUntil: 'domcontentloaded' });
  console.log('URL:', owned.url());
  console.log(await snapshot({ page: owned }));
  console.log(await getLatestLogs({ page: owned, sinceLastCall: true }));
  var cdp = await getCDPSession({ page: owned });
  await cdp.send('Accessibility.enable');
  var scenarios = [
    { name: 'immediate', config: {}, expected: 4 },
    { name: 'delayed-open', config: { openDelay: 100 }, expected: 4 },
    { name: 'delayed-commit', config: { commitDelay: 140 }, expected: 4 },
    { name: 'lingering-popup', config: { exitDelay: 250 }, expected: 4 },
    { name: 'rerender', config: { rerender: true }, expected: 4 },
    { name: 'unrelated-options', config: { decoy: true }, expected: 4 },
    { name: 'reordered-options', config: { reordered: true }, expected: 4 },
    { name: 'duplicate-option', config: { duplicate: true }, expected: 0, stop: 'ambiguous-option' },
    { name: 'missing-option', config: { missing: true }, expected: 0, stop: 'missing-option' },
    { name: 'disabled', config: { disabled: true }, expected: 0, stop: 'disabled' },
    { name: 'dependent-question', config: { dependent: true }, expected: 1, stop: 'form-changed' },
    { name: 'rejected-selection', config: { reject: true }, expected: 0, stop: 'value-not-confirmed' },
  ];
  var queue = [];
  // Rotate order to reduce systematic warm-up/order effects; identical configs.
  for (var repeat = 0; repeat < 3; repeat++) for (var scenario of scenarios) {
    var modes = ['per-click-400ms', 'recorded-fast-loop', 'verified-batch'];
    modes = modes.slice(repeat).concat(modes.slice(0, repeat));
    for (var mode of modes) queue.push({ scenario, mode, repeat });
  }
  state.formBacktest = { page: owned, cdp, queue, results: [] };
}
var h = state.formBacktest;
var role = n => n?.role?.value;
var name = n => n?.name?.value;
var prop = (n, key) => n?.properties?.find(p => p.name === key)?.value;
var pause = ms => new Promise(resolve => setTimeout(resolve, ms));
var observe = async stats => {
  stats.observations++;
  var r = await h.cdp.send('Accessibility.getFullAXTree');
  var nodes = r.nodes.filter(n => !n.ignored);
  return { nodes, byId: new Map(r.nodes.map(n => [n.nodeId, n])) };
};
var descendants = (s, n) => {
  var out = [], seen = new Set();
  var visit = node => { if (!node || seen.has(node.nodeId)) return; seen.add(node.nodeId); out.push(node); for (var id of node.childIds || []) visit(s.byId.get(id)); };
  visit(n); return out;
};
var groups = s => s.nodes.filter(n => role(n) === 'group').map(n => name(n)).sort().join('|');
var field = (s, label) => {
  var matches = s.nodes.filter(n => role(n) === 'group' && name(n) === label);
  if (matches.length !== 1) throw new Error('ambiguous-field');
  var buttons = descendants(s, matches[0]).filter(n => role(n) === 'button');
  if (buttons.length !== 1) throw new Error('ambiguous-control');
  return buttons[0];
};
var ownedOptions = (s, button) => {
  var ids = prop(button, 'controls')?.relatedNodes?.map(n => n.backendDOMNodeId) || [];
  var popups = s.nodes.filter(n => role(n) === 'listbox' && ids.includes(n.backendDOMNodeId));
  if (popups.length !== 1) return undefined;
  return descendants(s, popups[0]).filter(n => role(n) === 'option');
};
var click = async (node, stats) => {
  // Same trusted mouse-event mechanism as src/cdp/service.ts; no Playwright
  // locator auto-waits, cursor animation, or hidden selection helper.
  var backendNodeId = node.backendDOMNodeId;
  await h.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
  var { quads } = await h.cdp.send('DOM.getContentQuads', { backendNodeId });
  if (!quads?.[0]) throw new Error('detached-or-invisible');
  var q = quads[0], x = (q[0] + q[2] + q[4] + q[6]) / 4, y = (q[1] + q[3] + q[5] + q[7]) / 4;
  for (var type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await h.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
  stats.clicks++;
  var logs = await getLatestLogs({ page: h.page, sinceLastCall: true });
  if (logs.length) console.log('Fixture logs:', logs);
};
var until = async (predicate, stats, error) => {
  var deadline = Date.now() + 700;
  do {
    var s = await observe(stats);
    if (predicate(s)) return s;
    await pause(10);
  } while (Date.now() < deadline);
  throw new Error(error);
};
var run = async ({ scenario, mode, repeat }) => {
  await h.page.evaluate(config => window.configure(config), scenario.config);
  var stats = { observations: 0, clicks: 0 }, completed = [], stop = null;
  var initial = await observe(stats), current = initial;
  var labels = ['Question 1', 'Question 2', 'Question 3', 'Question 4'];
  var initialNodes = labels.map(label => field(initial, label));
  var topology = groups(initial), start = Date.now();
  try {
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      var button = mode === 'recorded-fast-loop' ? initialNodes[i] : field(current, label);
      if (mode === 'verified-batch') {
        if (groups(current) !== topology) throw new Error('form-changed');
        if (prop(button, 'disabled')?.value === true) throw new Error('disabled');
      }
      await click(button, stats);
      if (mode === 'per-click-400ms') await pause(400);
      current = mode === 'verified-batch'
        ? await until(s => !!ownedOptions(s, field(s, label)), stats, 'popup-not-ready')
        : await observe(stats);
      var options = mode === 'verified-batch'
        ? ownedOptions(current, field(current, label))
        : current.nodes.filter(n => role(n) === 'option');
      var matches = options.filter(n => name(n) === 'No');
      if (!matches.length) throw new Error('missing-option');
      if (mode === 'verified-batch' && matches.length !== 1) throw new Error('ambiguous-option');
      await click(matches[0], stats);
      if (mode === 'per-click-400ms') await pause(400);
      if (mode === 'verified-batch') {
        current = await until(s => {
          var b = field(s, label);
          return name(b) === 'No Required' && prop(b, 'expanded')?.value === false && prop(b, 'busy')?.value !== true;
        }, stats, 'value-not-confirmed');
      } else if (mode === 'per-click-400ms') current = await observe(stats);
      completed.push(i);
      if (mode === 'verified-batch') {
        for (var done of completed) if (name(field(current, labels[done])) !== 'No Required') throw new Error('previous-value-changed');
        if (groups(current) !== topology) throw new Error('form-changed');
      }
    }
    if (mode === 'recorded-fast-loop') current = await observe(stats);
  } catch (e) { stop = String(e.message || e).slice(0, 160); }
  var driverMs = Date.now() - start;
  // Independent ground truth after all fixture timers, outside measured driver.
  await h.page.evaluate(() => window.fixture.idle());
  var truth = await h.page.evaluate(() => window.fixture.read());
  var falseCompletion = completed.filter(i => truth.values[i] !== 'No').length;
  var correct = truth.values.filter(v => v === 'No').length;
  var pass = correct === scenario.expected && completed.length === scenario.expected &&
    !falseCompletion && !truth.unintended && !truth.boundaryExceeded &&
    (scenario.stop ? stop === scenario.stop : stop === null);
  return { scenario: scenario.name, mode, repeat, driverMs, ...stats, completed: completed.length,
    correct, falseCompletion, unintended: truth.unintended, boundaryExceeded: truth.boundaryExceeded, stop, pass };
};
for (var n = 0; n < 3 && h.queue.length; n++) {
  var result = await run(h.queue.shift()); h.results.push(result); console.log(result);
}
fs.mkdirSync('/tmp/form-backtest', { recursive: true });
fs.writeFileSync('/tmp/form-backtest/browser-results.json', JSON.stringify({
  note: 'Synthetic browser fixtures with real Chrome AX trees and trusted CDP clicks. No model reruns or live Workday mutations. Timings omit model latency/cursor animation. Current 400ms settle simulated explicitly.',
  results: h.results, remaining: h.queue.length,
}, null, 2));
console.log({ done: !h.queue.length, completed: h.results.length, remaining: h.queue.length });
if (!h.queue.length) { await h.page.close(); delete state.formBacktest; }
