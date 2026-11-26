// @ts-check
// C4 (issue 338, A364): weight by work type. (b) test and fixture files are not counted by max_scope_paths and big work gets bounded class defaults; (a) a LIGHT profile
// for content and docs tasks, decided by the control plane from the task type and the manifest, never from a claim; (c) a forecast at plan approval from the recorded runs;
// (d) the plan approval shows the test review budget.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { forecastRows, quantile } from '../../control-plane/agents/scripts/core/forecast.mjs';
import { A, accepted, commitAll, rv, warmDefaultTemplate, project } from '../lib/harness.mjs';
import { Z, installCore, pv, rebase, rrun, wr } from './risk-s1-lib.mjs';

before(() => { warmDefaultTemplate(); });

const cfgSet = (/** @type {string} */ d, /** @type {(t: string) => string} */ f) => { const c = path.join(d, '.agents/config.yaml'); writeFileSync(c, f(readFileSync(c, 'utf8'))); };
const tests25 = () => `\n## Tests\n\n${Array.from({ length: 25 }, (_, i) => `- AC-${i + 1}: behaviour ${i + 1} (test_kind: unit)`).join('\n')}\n`;

/** A standalone run of a task with front matter `fm`, class `cls`, new scope paths `newPaths` and a plan body. @param {string} fm @param {string} cls @param {string} newPaths @param {string} [body] */
function lrun(fm, cls, newPaths, body = '') {
  const d = project({ topology: 'standalone', layout: 'no', cls, autonomy: 'manual', taskFm: fm });
  const out = ['---', 'scope:', '  - path: impl.txt', '    criteria: [AC-1]', '  - path: impl_test.txt', '    criteria: [AC-1]'];
  for (const p of newPaths.split(/\s+/).filter(Boolean)) out.push(`  - path: ${p}`, '    new: true', '    criteria: [AC-1]', '    tdd_exemption: "static artifact with no executable behavior; the risk focus checks it"');
  out.push('---', '# Plan', '', '## Assumptions', 'none', '', '## Architecture', 'one storage map; no new module', body);
  writeFileSync(path.join(d, '.agents/runs/LC/PLAN.md'), `${out.join('\n')}\n`);
  installCore(d);
  return d;
}
/** The shipped config of the control plane (with the class defaults the test projects leave out). @param {string} d */
const withClassDefaults = (d) => writeFileSync(path.join(d, '.agents/config.yaml'), readFileSync(path.join(import.meta.dirname, '../../control-plane/agents/config.yaml'), 'utf8'));
const snap = (/** @type {string} */ d) => A(d, ['pipeline', 'LC']).out;

// ---- (b) the scope limit does not count test and fixture files ----------------------------------------------------------------------

test('c4_scope_uncounted: test files and fixture files are not code paths of max_scope_paths; product files still are', () => {
  const d = rrun('STANDARD', 'tests/a.test.js tests/b.test.js tests/c.test.js tests/fixtures/d.json');
  cfgSet(d, (t) => t.replace(/^( {4}max_scope_paths:) 15$/m, '$1 2'));
  commitAll(d, 'limits'); rebase(d);
  accepted(A(d, ['classify', 'LC', 'STANDARD', 'review']), 'classify');
  accepted(Z(d, ['freeze', 'LC']), 'one product path and five test or fixture paths under a limit of two');
  const bad = rrun('STANDARD', 'src/p.js src/q.js tests/a.test.js');
  cfgSet(bad, (t) => t.replace(/^( {4}max_scope_paths:) 15$/m, '$1 2'));
  commitAll(bad, 'limits'); rebase(bad);
  accepted(A(bad, ['classify', 'LC', 'STANDARD', 'review']), 'classify');
  const m = Z(bad, ['freeze', 'LC']);
  assert.notEqual(m.status, 0, 'three product paths froze under a limit of two');
  assert.match(m.text, /code paths|allows at most 2/);
});

// ---- (a) the light profile ---------------------------------------------------------------------------------------------------------

test('c4_light: a content task of class STANDARD with text and page files is light: no mutation testing, the design group off; a feature task is not', () => {
  const light = lrun('type: content', 'STANDARD', 'site/index.html site/style.css');
  const p = snap(light);
  assert.equal(pv(p, 'profile'), 'light', p);
  assert.equal(pv(p, 'mutation_testing'), 'off');
  assert.equal(pv(p, 'design_group'), 'off');
  const feature = lrun('type: feature', 'STANDARD', 'site/index.html site/style.css');
  const q = snap(feature);
  assert.equal(pv(q, 'profile'), 'full', q);
  assert.equal(pv(q, 'mutation_testing'), 'on');
  assert.equal(pv(q, 'design_group'), 'optional');
});

test('c4_light_mandatory: the light profile drops no gate (SECRETS, SECURITY and the rest are the tier gates as before)', () => {
  const light = lrun('type: docs', 'STANDARD', 'site/index.html');
  const full = lrun('type: feature', 'STANDARD', 'site/index.html');
  assert.equal(pv(snap(light), 'gates'), pv(snap(full), 'gates'));
  assert.ok(pv(snap(light), 'gates').includes('SECRETS'));
});

test('c4_light_upward: code, dependency, config, CI, a data section, a risk focus or a higher class keep a content task out of the light profile', () => {
  for (const [what, paths] of [['code', 'src/app.js'], ['dependency', 'package.json'], ['CI', '.github/workflows/ci.yml'], ['config', 'config/site.toml']]) {
    const p = snap(lrun('type: content', 'STANDARD', `site/index.html ${paths}`));
    assert.equal(pv(p, 'profile'), 'full', `${what}: ${p}`);
    assert.match(pv(p, 'profile_reason'), /code|dependency|config|CI|risk/, what);
  }
  assert.equal(pv(snap(lrun('type: content', 'STANDARD', 'site/index.html', '\n## Data\n\ndestructive: no\n\nnothing\n')), 'profile'), 'full', 'a Data section');
  assert.equal(pv(snap(lrun('type: content', 'COMPLEX', 'site/index.html')), 'profile'), 'full', 'COMPLEX');
  assert.equal(pv(snap(lrun('type: content', 'STANDARD', 'site/index.html tests/page.test.js tests/fixtures/page.json')), 'profile'), 'light', 'tests and fixtures of the page do not leave it');
});

test('c4_light_diff: a changed file the plan does not name reclassifies upward at the next call; nothing is stored', () => {
  const d = lrun('type: content', 'STANDARD', 'site/index.html');
  assert.equal(pv(snap(d), 'profile'), 'light');
  wr(d, 'src/sneak.js', 'x\n');
  assert.equal(pv(snap(d), 'profile'), 'full');
  assert.match(pv(snap(d), 'profile_reason'), /src\/sneak\.js/);
});

test('c4_light_budget: 25 test criteria need no mutation budget approval in the light profile, and do in a feature task', () => {
  const l = lrun('type: content', 'STANDARD', 'site/index.html', tests25());
  commitAll(l, 'plan'); rebase(l);
  accepted(A(l, ['classify', 'LC', 'STANDARD', 'review']), 'classify');
  const ok = Z(l, ['freeze', 'LC']);
  assert.ok(!/mutation budget/.test(ok.text), ok.text);
  const f = lrun('type: feature', 'STANDARD', 'site/index.html', tests25());
  commitAll(f, 'plan'); rebase(f);
  accepted(A(f, ['classify', 'LC', 'STANDARD', 'review']), 'classify');
  const no = Z(f, ['freeze', 'LC']);
  assert.match(no.text, /mutation budget/);
});

// ---- (b) class defaults ---------------------------------------------------------------------------------------------------------------

test('c4_defaults: fix rounds and the mutation budget have class defaults (STANDARD 2 and 20, COMPLEX and CRITICAL 3 and 30); the global keys still apply where a class has none', () => {
  const run = (/** @type {string} */ cls) => { const d = lrun('type: feature', cls, 'site/index.html'); withClassDefaults(d); return snap(d); };
  assert.equal(pv(run('STANDARD'), 'max_fix_rounds'), '2');
  assert.equal(pv(run('STANDARD'), 'max_mutants'), '20');
  for (const cls of ['COMPLEX', 'CRITICAL']) {
    const p = run(cls);
    assert.equal(pv(p, 'max_fix_rounds'), '3', cls);
    assert.equal(pv(p, 'max_mutants'), '30', cls);
  }
  const g = lrun('type: feature', 'COMPLEX', 'site/index.html');   // the test project has no class key
  assert.equal(pv(snap(g), 'max_fix_rounds'), '2', 'no class key: the review.max_fix_rounds default');
  assert.equal(pv(snap(g), 'max_mutants'), '20');
  const bad = lrun('type: feature', 'COMPLEX', 'site/index.html');
  withClassDefaults(bad); cfgSet(bad, (x) => x.replace(/^( {4}max_fix_rounds:) 3$/m, '$1 11'));
  assert.notEqual(A(bad, ['config-check']).status, 0, 'a class fix round count above 10 is refused by config-check');
});

// ---- (c) the forecast --------------------------------------------------------------------------------------------------------------------

const rec = (/** @type {Record<string, unknown>} */ o) => JSON.stringify({ schema: 'proofline.metrics/1', time: '2026-01-01T00:00:00Z', role: null, focus: null, gate: null, runtime: null, model: null, tokens_in: null, tokens_out: null, turns: null, retries: null, delegations: null, fix_rounds: null, result: 'done', size: null, scope_paths: null, ...o });

test('c4_forecast_math: the median and p90 are nearest-rank values of the recorded runs of the class', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([5], 0.9), 5);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2);
  assert.equal(quantile([4, 1, 3, 2, 10, 9, 8, 7, 6, 5], 0.9), 9);
  const lines = [
    rec({ kind: 'run', task: 'A', class: 'COMPLEX', duration_s: 3600 }), rec({ kind: 'run', task: 'B', class: 'COMPLEX', duration_s: 7200 }), rec({ kind: 'run', task: 'C', class: 'STANDARD', duration_s: 60 }),
    rec({ kind: 'step', task: 'A', duration_s: 600, tokens_total: 1000000 }), rec({ kind: 'step', task: 'B', duration_s: 1200, tokens_total: 3000000 }), rec({ kind: 'step', task: 'C', duration_s: 60, tokens_total: 5 }),
    'not json', rec({ kind: 'run', task: 'D', class: 'COMPLEX', duration_s: 9999, result: 'failed' }),
  ].join('\n');
  const out = forecastRows(lines, 'COMPLEX');
  assert.match(out, /2 finished COMPLEX run/);
  assert.match(out, /wall time median 1\.0 h, p90 2\.0 h/);
  assert.match(out, /agent time median 10 min, p90 20 min/);
  assert.match(out, /tokens median 1\.0M, p90 3\.0M/);
  assert.match(forecastRows(lines, 'CRITICAL'), /no history/);
  assert.match(forecastRows('', 'COMPLEX'), /no history/);
});

test('c4_forecast_approval: the plan approval request prints the forecast and the test review budget; the approval kind is unchanged', () => {
  const d = lrun('type: feature', 'COMPLEX', 'site/index.html', '\n## Test review budget\n\n- rounds: 6\n- minutes: 90\n- mutants: 40\n');
  withClassDefaults(d);
  wr(d, '.agents/local/metrics/records.jsonl', `${[rec({ kind: 'run', task: 'A', class: 'COMPLEX', duration_s: 5400 }), rec({ kind: 'step', task: 'A', duration_s: 1800, tokens_total: 2000000 })].join('\n')}\n`);
  commitAll(d, 'plan'); rebase(d);
  const r = A(d, ['request-approval', 'LC', 'plan']);
  accepted(r, 'request-approval plan');
  assert.match(r.out, /forecast .*1 finished COMPLEX run/);
  assert.match(r.out, /tokens median 2\.0M/);
  assert.match(r.out, /test review budget: rounds 6 \(default 4, needs your scope approval\), minutes 90 \(default 120\), mutants 40 \(default 30, needs your mutation_budget approval\)/);
  const e = lrun('type: feature', 'COMPLEX', 'site/index.html');
  withClassDefaults(e);
  const r2 = A(e, ['request-approval', 'LC', 'plan']);
  assert.match(r2.out, /forecast: no history for COMPLEX/);
  assert.match(r2.out, /test review budget: rounds 4, minutes 120, mutants 30 \(config defaults; the plan states none\)/);
});

// ---- (d) the template --------------------------------------------------------------------------------------------------------------------

test('c4_template: the plan template carries the Test review budget section and says CRITICAL states it', () => {
  const t = readFileSync(path.join(import.meta.dirname, '../../control-plane/agents/templates/PLAN.md'), 'utf8');
  assert.match(t, /^## Test review budget$/m);
  assert.match(t.slice(t.indexOf('## Test review budget')), /CRITICAL/);
  assert.equal(rv(lrun('type: feature', 'STANDARD', 'a.html'), 'pipeline', 'classification'), 'STANDARD');
});
