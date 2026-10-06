/** Read-only trace analysis; accepts `handoff-bridge tools ... --json` or chat export.
 * node scripts/backtest-form-actions.mjs /path/to/trace.json [browser-results.json]
 * Prints aggregate metrics without copying application answers/personal data.
 * `at` is the UI tool-card start (input streaming can precede execution), whereas
 * durationMs measures execution. Wall-window figures are approximate, not a
 * provider-only latency measurement. No model-success counterfactual is claimed.
 */
import { readFileSync } from 'node:fs';
if (!process.argv[2]) throw new Error('Usage: node scripts/backtest-form-actions.mjs <trace.json> [browser-results.json]');
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const flatten = items => items.flatMap(t => t.kind === 'tool' ? [t, ...flatten(t.childItems || [])] : []);
const chats = input.toolCalls ? [{ id: input.chatId, calls: input.toolCalls }] :
  (input.chats || input).map(c => ({ id: c.id, calls: flatten(c.transcript || []) }));
const target = t => t.input?.__target;
const opening = t => t.toolName === 'browser_click' &&
  (target(t)?.role === 'combobox' || (target(t)?.role === 'button' && /select|choose|dropdown/i.test(target(t)?.name || '')));
const selection = t => t.toolName === 'browser_click' && target(t)?.role === 'option';
const median = nums => { const a = nums.toSorted((a,b) => a-b); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m-1]+a[m])/2; };
const report = { evidence: [], limitations: [
  'Card timestamps may start during argument streaming. Gaps include model generation, network, scheduling and argument streaming; not isolated reasoning time.',
  'Tool outputs from the bridge can be truncated. A later corrective action is evidence of rework, not proof of the precise browser failure.',
  'Removing fixed waits is an arithmetic counterfactual. Batch performance is measured separately on synthetic Chrome fixtures; historical actions are never rerun.',
] };
for (const chat of chats) {
  const calls = chat.calls, segments = [];
  for (let i = 0; i < calls.length;) {
    const start = i, pairs = [];
    while (opening(calls[i] || {}) && selection(calls[i + 1] || {}) && calls[i].input?.tabId === calls[i + 1].input?.tabId) {
      pairs.push(calls[i], calls[i + 1]); i += 2;
    }
    if (pairs.length) {
      const first = pairs[0], last = pairs.at(-1);
      const toolMs = pairs.reduce((n,t) => n + (t.durationMs || 0), 0);
      const windowMs = last.at + (last.durationMs || 0) - first.at;
      segments.push({ startIndex: start, fields: pairs.length / 2, clicks: pairs.length,
        approximateWindowMs: windowMs, recordedToolMs: toolMs,
        approximateOutsideToolMs: windowMs - toolMs, fixedWaitBudgetMs: pairs.length * 400,
        maxWindowReductionFromRemoving400msPercent: +(pairs.length * 400 / windowMs * 100).toFixed(1) });
    } else i++;
  }
  const batches = [];
  for (let i = 0; i < calls.length; i++) {
    const t = calls[i], code = t.input?.code;
    if (t.toolName !== 'sandbox_exec' || typeof code !== 'string' || !/api\.page\.(?:fill|select|click)\s*\(/.test(code)) continue;
    const refs = [...code.matchAll(/['"](e\d+(?:-\d+)?)['"]/g)].map(m => m[1]);
    const reattempts = calls.slice(i + 1).filter(n => n.toolName === 'browser_click' && refs.includes(n.input?.ref));
    batches.push({ index: i, durationMs: t.durationMs, reportedFieldCount: refs.length,
      fieldTargetsClickedAgain: new Set(reattempts.map(n => n.input.ref)).size,
      verification: 'Not inferred from source code; inspect the recorded driver result.' });
  }
  if (segments.length || batches.length) report.evidence.push({ chatId: chat.id, segments, batches });
}
if (process.argv[3]) {
  const captured = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  // First rotation is warm-up/pilot; compare the two unchanged measured rotations.
  const results = captured.results.filter(r => r.repeat > 0);
  report.browser = { runs: results.length, warmupRunsExcluded: captured.results.length - results.length,
    remaining: captured.remaining, modes: {} };
  for (const mode of [...new Set(results.map(r => r.mode))]) {
    const rows = results.filter(r => r.mode === mode);
    report.browser.modes[mode] = {
      runs: rows.length, expectedOutcomes: rows.filter(r => r.pass).length,
      trialsWithFalseCompletion: rows.filter(r => r.falseCompletion).length,
      trialsWithUnintendedWrites: rows.filter(r => r.unintended).length,
      trialsThatCrossedDependency: rows.filter(r => r.boundaryExceeded).length,
      scenarios: Object.fromEntries([...new Set(rows.map(r => r.scenario))].map(s => {
        const a = rows.filter(r => r.scenario === s);
        return [s, { medianDriverMs: median(a.map(r => r.driverMs)), pass: a.filter(r => r.pass).length, runs: a.length,
          stopReasons: [...new Set(a.map(r => r.stop))] }];
      })),
    };
  }
}
console.log(JSON.stringify(report, null, 2));
