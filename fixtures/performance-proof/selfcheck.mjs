// Proves the planted facts of the performance-proof fixture built in <dir> (EXPECTED.md items 1-9; the traps
// 10-14 are the same cases: a status other than the expected one is the trap firing; traps 15-18 are checked
// explicitly at the end). usage: node selfcheck.mjs <built-dir>
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enter, fail, repoRootOf, run } from '../selfcheck-lib.mjs';

const scripts = path.join(repoRootOf(import.meta.url), 'skills/performance-proof/scripts');
const cmp = path.join(scripts, 'compare-bench.mjs');
const val = path.join(scripts, 'validate-performance.mjs');
enter();
const tmp = mkdtempSync(path.join(tmpdir(), 'performance-proof-selfcheck-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
const T = (/** @type {string} */ f) => path.join(tmp, f);
const node = (/** @type {string[]} */ args) => run(process.execPath, args);
const readJson = (/** @type {string} */ f) => JSON.parse(readFileSync(f, 'utf8'));
writeFileSync(T('env.txt'), ['os=Linux 6.8.0 x86_64', 'cpu_count=8', 'load_avg_before=0.4', 'command=synthetic', 'warmup_runs=1', 'runs=12', 'order=interleaved',
  'timer=date', 'base_rev=b', 'change_rev=c', 'started_at=2026-10-13T10:00:00Z', 'finished_at=2026-10-13T10:01:00Z'].map((l) => `${l}\n`).join(''));

/** expect CASE STATUS [compare-bench options...]: the report's status, and the report is left in r.json. @param {string} c @param {string} want @param {...string} opts */
function expect(c, want, ...opts) {
  const b = existsSync(`samples/${c}-base.json`) ? `samples/${c}-base.json` : `samples/${c}-base.csv`;
  const ch = existsSync(`samples/${c}-change.json`) ? `samples/${c}-change.json` : `samples/${c}-change.csv`;
  const r = node([cmp, '--base', b, '--change', ch, '--command', 'synthetic', '--tool-source', 'fixture', ...opts]);
  process.stderr.write(r.err);   // the shell selfcheck let compare-bench's notes through
  if (r.status !== 0) fail(`${c}: compare-bench exited ${r.status}`);
  writeFileSync(T('r.json'), r.out);
  const got = JSON.parse(r.out).status;
  if (got !== want) fail(`${c} ${opts.join(' ')}: want ${want}, got ${got}`);
}

expect('c1', 'FAIL');
expect('c2', 'INCONCLUSIVE');
expect('c3', 'PASS');
expect('c4', 'PASS');
expect('c5', 'INCONCLUSIVE');
expect('c6', 'INCONCLUSIVE');
const c7 = node([cmp, '--base', 'samples/c7-base.json', '--change', 'samples/c7-change.json']);
if (c7.status === 0) fail('c7: unit mismatch was compared');
if (!(c7.status === 2 && c7.out === '' && c7.err.includes('unit mismatch'))) fail("c7: want exit 2 with 'unit mismatch' and no report");
expect('c8', 'FAIL');
expect('c8', 'PASS', '--plan', 'PLAN-20.md');
const src = readJson(T('r.json')).thresholds.source;
if (src !== 'plan') fail(`c8 --plan: source ${src}, want plan`);
expect('c8', 'PASS', '--config', '.agents/config.yaml');
expect('c8', 'FAIL', '--config', '.agents/config.yaml', '--plan', 'PLAN-12.md');
// A budget given on the command line is a what-if: PASS, but source `cli (unverified)` and never a valid report.
expect('c8', 'PASS', '--budget-pct', '20', '--env', T('env.txt'));
if (!readFileSync(T('r.json'), 'utf8').includes('"source": "cli (unverified)"')) fail('c8 --budget-pct: source is not cli (unverified)');
if (node([val, T('r.json')]).status === 0) fail('a cli budget report validated');
// An unparseable plan budget is a note in the report and refused by the validator.
expect('c8', 'FAIL', '--plan', 'PLAN-abc.md');
if (!readFileSync(T('r.json'), 'utf8').includes('budget_pct=abc is not a number')) fail('c8 PLAN-abc: no note about the unparseable budget');
if (node([val, T('r.json'), '--plan', 'PLAN-abc.md']).status === 0) fail('a plan with an unparseable budget_pct validated');
expect('c9', 'FAIL', '--direction', 'higher');

// A compare-bench report without an environment block is not a valid report.
expect('c1', 'FAIL');
if (node([val, T('r.json')]).status === 0) fail('a report without environment validated');
// Trap 15/16: the direction contradicts the unit (time is lower-is-better, a rate higher-is-better).
for (const [c, d] of [['c1', 'higher'], ['c9', 'lower']]) {
  const r = node([cmp, '--base', `samples/${c}-base.json`, '--change', `samples/${c}-change.json`, '--direction', d]);
  if (r.status === 0) fail(`${c} --direction ${d} was compared`);
  if (!r.err.includes('contradicts unit')) fail(`${c} --direction ${d}: no 'contradicts unit' refusal`);
}
// Trap 17/18: a valid c3 report (PASS) with a shopped seed is invalid; unverified thresholds never submit PASS.
expect('c3', 'PASS', '--env', T('env.txt'));
writeFileSync(T('config.yaml'), '');
writeFileSync(T('PLAN.md'), '## Risk\n\nperformance_critical: yes\n');
if (!node([val, T('r.json'), '--config', T('config.yaml'), '--plan', T('PLAN.md'), '--rows']).out.split('\n').includes('result: PASS')) fail('c3 verified: not PASS');
if (!node([val, T('r.json'), '--rows']).out.split('\n').includes('result: UNSUPPORTED')) fail('c3 unverified: submitted as something other than UNSUPPORTED');
const shopped = readJson(T('r.json')); shopped.measurements[0].delta.seed = 19; writeFileSync(T('r.json'), JSON.stringify(shopped));
if (node([val, T('r.json'), '--config', T('config.yaml'), '--plan', T('PLAN.md')]).status === 0) fail('a report with seed 19 validated');
// Trap 19/20: unit aliases are times; a unit without a known direction needs the plan's direction=.
/** a copy of a samples file with another unit @param {string} from @param {string} unit @param {string} to */
const withUnit = (from, unit, to) => { const d = readJson(from); d.unit = unit; writeFileSync(to, JSON.stringify(d)); };
for (const u of ['milliseconds', 'MS', 'μs']) {
  withUnit('samples/c1-base.json', u, T('ab.json')); withUnit('samples/c1-change.json', u, T('ac.json'));
  if (node([cmp, '--base', T('ab.json'), '--change', T('ac.json'), '--metric', 'value', '--direction', 'higher']).status === 0) fail(`c1 as ${u} --direction higher was compared`);
}
withUnit('samples/c9-base.json', 'score', T('sb.json')); withUnit('samples/c9-change.json', 'score', T('sc.json'));
if (node([cmp, '--base', T('sb.json'), '--change', T('sc.json'), '--direction', 'higher']).status === 0) fail("c9 as score was compared without the plan's direction");
writeFileSync(T('PLAN-dir.md'), '## Risk\n\nperformance_critical: yes direction=higher\n');
const expectDir = JSON.parse(node([cmp, '--base', T('sb.json'), '--change', T('sc.json'), '--plan', T('PLAN-dir.md')]).out).status;
if (expectDir !== 'FAIL') fail(`c9 as score with the plan's direction=higher: want FAIL, got ${expectDir}`);
console.log('selfcheck: performance-proof ok');
