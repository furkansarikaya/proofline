// @ts-check
// Issue 265 package B (A275): the deterministic measurement. AC-3 the build record holds the duration per test, AC-4 budgets by test kind from config and plan,
// scaled by timeouts.scale, AC-5 the control plane runs the new tests twice and a different outcome or a duration outside the tolerance stops the handoff.
// No test waits and none reads a clock: the tolerance maths gets a fake runner that returns fixed milliseconds, the durations are fixed strings, and the CLI
// tests use tiny commands whose outcome is decided by a counter file, not by time.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Config, configLines } from '../../control-plane/agents/scripts/core/config.mjs';
import { ledgerAppend } from '../../control-plane/agents/scripts/core/lock.mjs';
import { DEFAULTS, KINDS, budgetCheck, budgetTable, doubleRun, kindOf, parseDurations, planKinds, toleranceOf, withinTolerance } from '../../control-plane/agents/scripts/core/testmeasure.mjs';
import { A, accepted, project, refused, tmp, wclose, wev, wopen } from '../lib/harness.mjs';
import { posix } from '../lib/winpath.mjs';
import { setCmd } from './helper-lib.mjs';

/** @param {string} text */
const cfgOf = (text) => new Config('x', configLines(text));
const SHIPPED = cfgOf(readFileSync(path.join(import.meta.dirname, '..', '..', 'control-plane', 'agents', 'config.yaml'), 'utf8'));

// ---- the pure maths ---------------------------------------------------------------------------------------------------------------

test('parseDurations reads name=ms entries and skips what is not a number', () => {
  assert.deepEqual(parseDurations('lookup returns the stored value=0.42; empty key=12; broken; also=-3; x=abc'), [{ name: 'lookup returns the stored value', ms: 0.42 }, { name: 'empty key', ms: 12 }]);
  assert.deepEqual(parseDurations(''), []);
});

test('planKinds reads the test kinds and the budget lines; kindOf matches a recorded name to its bullet, else the default', () => {
  const pk = planKinds('## Tests\n\n- AC-1: `a.test` "returns the value" — x (test_kind: integration)\n- AC-2: `b.test` "fails on empty" — y (test_kind: unit)\n\n## Test budgets\n\n- integration: test 500 ms; suite 4000 ms\n- unit: default\n');
  assert.deepEqual(pk.names, [{ name: 'returns the value', kind: 'integration' }, { name: 'fails on empty', kind: 'unit' }]);
  assert.deepEqual([...pk.budgets], [['integration', { test: 500, suite: 4000 }], ['unit', 'default']]);
  assert.equal(kindOf('Returns the value', pk.names, 'e2e'), 'integration');
  assert.equal(kindOf('fails on empty key', pk.names, 'e2e'), 'unit');
  assert.equal(kindOf('something else', pk.names, 'e2e'), 'e2e');
});

test('budgets: the plan wins over config, config over the built-in default, timeouts.scale scales both, default means config', () => {
  const none = new Map();
  assert.deepEqual(budgetTable(cfgOf(''), none).unit, { test: DEFAULTS.unit.test_ms, suite: DEFAULTS.unit.suite_ms, source: 'config' });
  const cfg = cfgOf('test_budgets:\n  unit:\n    test_ms: 300\n    suite_ms: 900\ntimeouts:\n  scale: 2\n');
  assert.deepEqual(budgetTable(cfg, none).unit, { test: 600, suite: 1800, source: 'config' });
  assert.deepEqual(budgetTable(cfg, new Map([['unit', { test: 100, suite: 400 }]])).unit, { test: 200, suite: 800, source: 'plan' });
  assert.deepEqual(budgetTable(cfg, new Map([['unit', /** @type {'default'} */ ('default')]])).unit, { test: 600, suite: 1800, source: 'config' });
  assert.equal(budgetTable(cfgOf('test_budgets:\n  e2e:\n    test_ms: abc\n'), none).e2e.test, DEFAULTS.e2e.test_ms, 'a value that is not a number falls back to the default');
});

test('the shipped config.yaml and the built-in defaults carry the same numbers', () => {
  for (const k of KINDS) {
    assert.equal(Number(SHIPPED.get(`test_budgets.${k}.test_ms`, '')), DEFAULTS[/** @type {'unit'} */ (k)].test_ms, `${k} test_ms`);
    assert.equal(Number(SHIPPED.get(`test_budgets.${k}.suite_ms`, '')), DEFAULTS[/** @type {'unit'} */ (k)].suite_ms, `${k} suite_ms`);
  }
  assert.equal(Number(SHIPPED.get('test_stability.ratio', '')), DEFAULTS.stability.ratio);
  assert.equal(Number(SHIPPED.get('test_stability.floor_ms', '')), DEFAULTS.stability.floor_ms);
  assert.equal(SHIPPED.get('test_budgets.default_kind', ''), DEFAULTS.default_kind);
});

test('a test over its budget is a finding that names the test and its measured duration; the suite of a kind has its own finding', () => {
  const pk = planKinds('## Tests\n- AC-1: `a` "slow one" — x (test_kind: unit)\n- AC-2: `a` "fast one" — x (test_kind: unit)\n\n## Test budgets\n- unit: test 100 ms; suite 150 ms\n');
  const r = budgetCheck([{ name: 'slow one', ms: 5000 }, { name: 'fast one', ms: 90 }], pk.names, cfgOf(''), pk.budgets);
  assert.deepEqual(r.findings, [
    'BUDGET test "slow one" (unit) took 5000 ms, over its 100 ms test budget (plan)',
    'BUDGET suite unit took 5090 ms for 2 test(s), over its 150 ms suite budget (plan)',
  ]);
  assert.deepEqual(budgetCheck([{ name: 'fast one', ms: 90 }], pk.names, cfgOf(''), pk.budgets).findings, []);
});

test('tolerance: the absolute floor protects tiny tests, the ratio protects big ones, outside both is a finding', () => {
  const tol = { ratio: 3, floorMs: 100 };
  assert.equal(withinTolerance(1, 90, tol), true, 'a 90x jump of a tiny test is under the floor');
  assert.equal(withinTolerance(1000, 2900, tol), true, 'under the ratio');
  assert.equal(withinTolerance(1000, 3000, tol), true, 'exactly the ratio');
  assert.equal(withinTolerance(1000, 3001, tol), false);
  assert.equal(withinTolerance(3001, 1000, tol), false, 'symmetric');
  assert.deepEqual(toleranceOf(cfgOf('')), { ratio: DEFAULTS.stability.ratio, floorMs: DEFAULTS.stability.floor_ms });
  assert.deepEqual(toleranceOf(cfgOf('test_stability:\n  ratio: 2.5\n  floor_ms: 40\ntimeouts:\n  scale: 2\n')), { ratio: 2.5, floorMs: 80 });
});

/** A runner that answers from a script and counts its calls. @param {Array<{ status: number, ms: number, timedOut?: boolean }>} answers */
function scripted(answers) {
  /** @type {string[]} */ const calls = [];
  return { calls, runner: (/** @type {string} */ c) => { calls.push(c); return /** @type {any} */ (answers[calls.length - 1]); } };
}
const TOL = { ratio: 3, floorMs: 100 };

test('double run: two equal passes are stable and each command runs exactly twice (no retry)', () => {
  const s = scripted([{ status: 0, ms: 10 }, { status: 0, ms: 12 }, { status: 0, ms: 500 }, { status: 0, ms: 600 }]);
  const r = doubleRun(['t1', 't2'], s.runner, TOL);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(s.calls, ['t1', 't1', 't2', 't2']);
});

test('double run: a different outcome is a stability finding and the loop stops at once (no second command, no third run)', () => {
  const s = scripted([{ status: 0, ms: 10 }, { status: 1, ms: 10 }]);
  const r = doubleRun(['t1', 't2'], s.runner, TOL);
  assert.deepEqual(r.findings, ['STABILITY `t1` exited 0 on run 1 and 1 on run 2 of the same commit']);
  assert.deepEqual(s.calls, ['t1', 't1']);
});

test('double run: a duration outside the tolerance is a stability finding that names both durations', () => {
  const r = doubleRun(['t1'], scripted([{ status: 0, ms: 1000 }, { status: 0, ms: 4000 }]).runner, TOL);
  assert.deepEqual(r.findings, ['STABILITY `t1` took 1000 ms on run 1 and 4000 ms on run 2 of the same commit, outside the tolerance (ratio 3, floor 100 ms)']);
});

test('double run: failing on both runs contradicts the recorded GREEN; a time-out is a finding on its run and the second run is skipped', () => {
  assert.match(doubleRun(['t1'], scripted([{ status: 2, ms: 5 }, { status: 2, ms: 5 }]).runner, TOL).findings[0], /exited 2 on both runs, but its GREEN evidence records a pass/);
  const s = scripted([{ status: 124, ms: 60000, timedOut: true }]);
  const r = doubleRun(['t1'], s.runner, TOL);
  assert.match(r.findings[0], /hit the time limit on run 1/);
  assert.equal(s.calls.length, 1);
});

// ---- the control plane: recorder, build record, handoff ----------------------------------------------------------------------------

/** Stamp a scaffolded run as started by this version (a real `start` writes the row; a scaffold writes none, which is how an older run looks). @param {string} d */
function stamp(d) { ledgerAppend(path.join(d, '.agents/runs/LC'), 'lead', 'start', '-', 'PLANNED', 'task=tasks/LC.md adapter=markdown measure=1'); }
const PLAN = '\n## Tests\n\n- AC-1: `impl_test.txt` "slow one" — it is slow (test_kind: unit)\n- AC-2: `impl_test.txt` "fast one" — it is fast (test_kind: unit)\n\n## Test budgets\n\n- unit: test 100 ms; suite 1000 ms\n';
/** RED recorded and the implementation changed, so the next GREEN is accepted. @param {string} d */
function redThenFix(d) {
  const w = wopen(d);
  appendFileSync(path.join(d, 'impl_test.txt'), 'test: lookup returns the stored value\n');
  wev(d, 'RED', 'fail');
  appendFileSync(path.join(d, 'impl.txt'), 'impl: lookup returns the stored value\n');
  return w;
}
/** @param {string} d @param {string} command @param {string} [extra] */
const green = (d, command, extra = '') => A(d, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: `command: ${command}\ntarget: impl.txt,impl_test.txt\n${extra}` });

test('a run started with the stamp must report test_durations with GREEN; a run started before it need not (old recordings stay valid)', () => {
  const stamped = project({ topology: 'orchestrated' }); stamp(stamped);
  const w = redThenFix(stamped);
  refused(green(stamped, 'go test ./...'), 'GREEN without durations in a stamped run', 'GREEN evidence requires `test_durations');
  accepted(green(stamped, 'go test ./...', 'test_durations: lookup=1\n'), 'GREEN with durations');
  wclose(stamped, w);
  const old = project({ topology: 'orchestrated' });
  const w2 = redThenFix(old);
  accepted(green(old, 'go test ./...'), 'GREEN without durations in a run that has no stamp');
  wclose(old, w2);
});

test('the build record holds the duration per test and the budget findings, and show prints them', () => {
  const d = project({ topology: 'orchestrated', planExtra: PLAN }); stamp(d);
  setCmd(d, 'test', 'node --version');
  const w = redThenFix(d);
  accepted(green(d, 'node --version', 'test_durations: slow one=5000; fast one=40\n'), 'GREEN');
  wclose(d, w);
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.match(r.out, /^test-durations:\n {2}slow one \(unit\): 5000 ms\n {2}fast one \(unit\): 40 ms$/m);
  assert.match(r.out, /^finding: BUDGET test "slow one" \(unit\) took 5000 ms, over its 100 ms test budget \(plan\)$/m);
  assert.match(r.out, /^finding: BUDGET suite unit took 5040 ms for 2 test\(s\), over its 1000 ms suite budget \(plan\)$/m);
  assert.equal(A(d, ['build-record', 'LC', 'show'], { role: 'reviewer' }).out, r.out, 'a reviewer reads the same record');
});

test('a build record of a run with no durations prints no measurement section (a record made before this version looks the same)', () => {
  const d = project({ topology: 'orchestrated' });
  setCmd(d, 'test', 'node --version');
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.doesNotMatch(r.out, /test-durations:|finding:/);
});

/** A test command whose exit status comes from a counter file outside the project: the first run passes, the second run exits with SECOND. @param {string} second */
function counterCommand(second) {
  const dir = tmp('stab');
  const counter = path.join(dir, 'count');
  const script = path.join(dir, 'run.mjs');
  writeFileSync(counter, '');
  writeFileSync(script, `import { appendFileSync, readFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(counter)}, 'x');\nprocess.exit(readFileSync(${JSON.stringify(counter)}, 'utf8').length === 1 ? 0 : ${Number(second)});\n`);
  return { command: `node ${posix(script)}`, runs: () => readFileSync(counter, 'utf8').length };
}

test('IMPLEMENTED runs the new tests twice: a test that passes once and fails once stops the handoff, and nothing is retried', () => {
  const d = project({ topology: 'orchestrated' });
  const c = counterCommand('1');
  setCmd(d, 'test', c.command);
  const w = redThenFix(d);
  accepted(green(d, c.command, 'test_durations: lookup=1\n'), 'GREEN');
  wclose(d, w);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a flaky test', 'IMPLEMENTED blocked: STABILITY');
  assert.equal(c.runs(), 2, 'exactly two runs: the second one decided, no third');
});

test('IMPLEMENTED with a stable test passes, records one ledger row, and runs the command twice (plus the one build record run)', () => {
  const d = project({ topology: 'orchestrated' });
  const c = counterCommand('0');
  setCmd(d, 'test', c.command);
  const w = redThenFix(d);
  accepted(green(d, c.command, 'test_durations: lookup=1\n'), 'GREEN');
  wclose(d, w);
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a stable test');
  assert.equal(c.runs(), 3, 'the double run (2) and the build record that IMPLEMENTED makes (1)');
  assert.match(readFileSync(path.join(d, '.agents/runs/LC/LEDGER.log'), 'utf8'), /event=test-measure .* detail=tests=1 double_run=1 not_run=0 budget_findings=0 stability_findings=0 retries=0$/m);
});

test('a GREEN command that is neither configured nor in the plan is not run by the control plane; it is named', () => {
  const d = project({ topology: 'orchestrated' });
  const w = redThenFix(d);
  accepted(green(d, 'go test ./...', 'test_durations: lookup=1\n'), 'GREEN');
  wclose(d, w);
  const r = accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'handoff');
  assert.match(r.text, /note: not run twice: `go test \.\/\.\.\.` is neither a configured command nor an entry of the plan's Verification commands/);
});

test('a retry in the project own CI configuration is reported, from the ecosystems.json data', () => {
  const d = project({ topology: 'orchestrated', scopeNamed: '.gitlab-ci.yml' });
  const c = counterCommand('0');
  setCmd(d, 'test', c.command);
  const w = redThenFix(d);
  writeFileSync(path.join(d, '.gitlab-ci.yml'), 'test:\n  script: make test\n  retry: 2\n');
  accepted(green(d, c.command, 'test_durations: lookup=1\n'), 'GREEN');
  wclose(d, w);
  const r = accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'handoff');
  assert.match(r.text, /note: the project's own configuration retries a test \(reported, proofline never retries\): \.gitlab-ci\.yml:3 a GitLab job retries on failure/);
});

test('config-check accepts the budget keys and refuses a bad one', () => {
  const d = project({ topology: 'orchestrated' });
  accepted(A(d, ['config-check']), 'the shipped keys');
  const f = path.join(d, '.agents/config.yaml');
  const base = readFileSync(f, 'utf8');
  writeFileSync(f, `${base}\ntest_budgets:\n  unit:\n    test_ms: 0\n`);
  refused(A(d, ['config-check']), 'a zero budget', 'test_budgets.unit.test_ms must be at least 1');
});
