// @ts-check
// Issue 265 package B (A275): the deterministic measurement. AC-3 the build record holds the duration per test, AC-4 budgets by test kind from config and plan,
// scaled by timeouts.scale, AC-5 the control plane runs the new tests twice and a different outcome or a duration outside the tolerance stops the handoff.
// No test waits and none reads a clock: the tolerance maths gets a fake runner that returns fixed milliseconds, the durations are fixed strings, and the CLI
// tests use tiny commands whose outcome is decided by a counter file, not by time.
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { Config, configLines } from '../../control-plane/agents/scripts/core/config.mjs';
import { ledgerAppend } from '../../control-plane/agents/scripts/core/lock.mjs';
import { DEFAULTS, KINDS, budgetCheck, budgetTable, doubleRun, durationsExceedWall, greenRecords, kindOf, parseDurations, planKinds, realRunner, testCmdPin, toleranceOf, withinTolerance } from '../../control-plane/agents/scripts/core/testmeasure.mjs';
import { A, accepted, cached, codeKey, copyOf, project, refused, sha256, tmp, wclose, wev, wopen } from '../lib/harness.mjs';
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
function stamp(d, testCmd = '') {
  ledgerAppend(path.join(d, '.agents/runs/LC'), 'lead', 'start', '-', 'PLANNED', 'task=tasks/LC.md adapter=markdown measure=1');
  ledgerAppend(path.join(d, '.agents/runs/LC'), 'lead', 'test-cmd-pin', '-', '-', `testcmd=${testCmdPin(testCmd === '' ? [] : [testCmd])}`); // what a real start records: the project test command as the run started
}
const PLAN = '\n## Tests\n\n- AC-1: `impl_test.txt` "slow one" — it is slow (test_kind: unit)\n- AC-2: `impl_test.txt` "fast one" — it is fast (test_kind: unit)\n\n## Test budgets\n\n- unit: test 100 ms; suite 1000 ms\n';
/** RED recorded and the implementation changed, so the next GREEN is accepted; the window is left open. @param {string} d */
function redThenFix(d) {
  const w = wopen(d);
  appendFileSync(path.join(d, 'impl_test.txt'), 'test: lookup returns the stored value\n');
  wev(d, 'RED', 'fail');
  appendFileSync(path.join(d, 'impl.txt'), 'impl: lookup returns the stored value\n');
  return w;
}
/**
 * A project at the point every test below starts from (RED recorded, the implementation changed, the window open), built once per code and options and copied: the
 * cost of the five agent.sh calls that get there is paid once, not by every test. `stamped: false` is a run as an older version started it.
 * @param {{ stamped?: boolean, scaffold?: Record<string, unknown>, testCmd?: string }} [o] testCmd: the commands.test the run started with @returns {{ d: string, w: string }}
 */
function seeded(o = {}) {
  const stamped = o.stamped !== false;
  const key = `tm-${codeKey()}-${sha256(JSON.stringify([stamped, o.scaffold ?? {}, o.testCmd ?? ''])).slice(0, 12)}`;
  const d = copyOf(cached(key, (work) => {
    const b = project({ topology: 'orchestrated', ...(o.scaffold ?? {}) });
    if (stamped) stamp(b, o.testCmd);
    const w = redThenFix(b);
    writeFileSync(path.join(b, '.seed-window'), w);
    cpSync(b, work, { recursive: true });
    rmSync(b, { recursive: true, force: true });
  }));
  const w = readFileSync(path.join(d, '.seed-window'), 'utf8');
  rmSync(path.join(d, '.seed-window'));
  return { d, w };
}
/** The plan section that lists the command that runs the new tests. @param {string} command */
const verif = (command) => `\n## Verification commands\n\n- \`${command}\`\n`;
/** @param {string} d @param {string} command @param {string} [extra] */
const green = (d, command, extra = '') => A(d, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: `command: ${command}\ntarget: impl.txt,impl_test.txt\n${extra}` });

test('a run started with the stamp must report test_durations with GREEN; a run started before it need not (old recordings stay valid)', () => {
  const s = seeded();
  refused(green(s.d, 'go test ./...'), 'GREEN without durations in a stamped run', 'GREEN evidence requires `test_durations');
  accepted(green(s.d, 'go test ./...', 'test_durations: lookup=1\n'), 'GREEN with durations');
  const o = seeded({ stamped: false });
  accepted(green(o.d, 'go test ./...'), 'GREEN without durations in a run that has no stamp');
});

test('the build record holds the duration per test and the budget findings, and show prints them', () => {
  const { d, w } = seeded({ scaffold: { planExtra: PLAN } });
  setCmd(d, 'test', 'node --version');
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

/**
 * The constant plan command of the counter tests: the plan text is the same in every test, so the seeded project is shared (one build, not one per test). The script and its
 * counter file live inside the per-test project copy, at relative paths, and are written after the copy is made.
 */
const COUNTER = 'node .git/tm-run.mjs';
/** A test command whose exit status comes from a counter file inside the project: the first run passes, the later runs exit with SECOND. @param {string} d @param {string} second */
function counterIn(d, second) {
  const counter = path.join(d, '.git/tm-count');
  writeFileSync(counter, '');
  const script = path.join(d, '.git/tm-run.mjs');
  // the counter sits beside the script, so the relative plan command and the absolute one that the build record runs (in its own export) count into the same file
  writeFileSync(script, `import { appendFileSync, readFileSync } from 'node:fs';\nconst counter = new URL('tm-count', import.meta.url);\nappendFileSync(counter, 'x');\nprocess.exit(readFileSync(counter, 'utf8').length === 1 ? 0 : ${Number(second)});\n`);
  return { command: COUNTER, buildCommand: `node ${posix(script)}`, runs: () => readFileSync(counter, 'utf8').length };
}
/** @param {string} second @returns {{ d: string, w: string, c: ReturnType<typeof counterIn> }} the seeded project with the counter command listed in the plan */
function counterProject(second, extraScaffold = {}) {
  const { d, w } = seeded({ scaffold: { planExtra: verif(COUNTER), ...extraScaffold } });
  return { d, w, c: counterIn(d, second) };
}

test('IMPLEMENTED runs the new tests twice: a test that passes once and fails once stops the handoff, and nothing is retried', () => {
  const { d, w, c } = counterProject('1');
  setCmd(d, 'test', c.buildCommand);
  accepted(green(d, c.command, 'test_durations: lookup=1\n'), 'GREEN');
  wclose(d, w);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a flaky test', 'IMPLEMENTED blocked: STABILITY');
  assert.equal(c.runs(), 2, 'exactly two runs: the second one decided, no third');
});

test('a stability block is latched: IMPLEMENTED again on the same content stays blocked and runs nothing', () => {
  const { d, w, c } = counterProject('1');
  setCmd(d, 'test', c.buildCommand);
  accepted(green(d, c.command, 'test_durations: lookup=1\n'), 'GREEN');
  wclose(d, w);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'attempt 1', 'IMPLEMENTED blocked: STABILITY');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'attempt 2 on the same tree', 'unstable on exactly this content');
  assert.equal(c.runs(), 2, 'the second attempt ran nothing');
  assert.match(readFileSync(path.join(d, '.agents/runs/LC/LEDGER.log'), 'utf8'), /event=test-measure-block .* detail=patch=[0-9a-f]+$/m);
});

test('IMPLEMENTED with a stable test passes, records one ledger row, and runs the command twice (plus the one build record run)', () => {
  const { d, w, c } = counterProject('0');
  setCmd(d, 'test', c.buildCommand);
  accepted(green(d, c.command, 'test_durations: lookup=1\n'), 'GREEN');
  wclose(d, w);
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a stable test');
  assert.equal(c.runs(), 3, 'the double run (2) and the build record that IMPLEMENTED makes (1)');
  assert.match(readFileSync(path.join(d, '.agents/runs/LC/LEDGER.log'), 'utf8'), /event=test-measure .* detail=tests=1 double_run=1 not_run=0 budget_findings=0 stability_findings=0 blockers=0 retries=0$/m);
});

test('a measured run blocks on a GREEN command that is neither configured nor in the plan; listed in the plan it is run twice; an older run only gets a note', () => {
  const blocked = seeded();
  accepted(green(blocked.d, 'node -e 0', 'test_durations: lookup=1\n'), 'GREEN');
  wclose(blocked.d, blocked.w);
  const r = A(blocked.d, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(r, 'a narrow command not in the plan', 'is neither an entry of the plan\'s ## Verification commands nor the configured test command');
  assert.match(r.text, /`node -e 0` is neither an entry/);

  const listed = seeded({ scaffold: { planExtra: '\n## Verification commands\n\n- `node -e 0`\n' } });
  accepted(green(listed.d, 'node -e 0', 'test_durations: lookup=1\n'), 'GREEN');
  wclose(listed.d, listed.w);
  accepted(A(listed.d, ['handoff', 'LC', 'IMPLEMENTED']), 'a narrow command listed in the plan');
  assert.match(readFileSync(path.join(listed.d, '.agents/runs/LC/LEDGER.log'), 'utf8'), /event=test-measure .* detail=tests=1 double_run=1 not_run=0 /m);

  const old = seeded({ stamped: false });
  accepted(green(old.d, 'go test ./...'), 'GREEN');
  wclose(old.d, old.w);
  assert.match(accepted(A(old.d, ['handoff', 'LC', 'IMPLEMENTED']), 'an older run').text, /note: not run twice: `go test \.\/\.\.\.` is neither a configured command/);
});

test('the configured test command (as the run started) needs no plan listing: it is double-run, a flaky one stops the handoff and a stable one passes', () => {
  const f = seeded({ testCmd: COUNTER, scaffold: { planExtra: verif('node --version') } }); // the run started with COUNTER as commands.test; the plan lists something else
  const c = counterIn(f.d, '1');
  setCmd(f.d, 'test', COUNTER);
  accepted(green(f.d, COUNTER, 'test_durations: lookup=1\n'), 'GREEN with the configured test command');
  wclose(f.d, f.w);
  refused(A(f.d, ['handoff', 'LC', 'IMPLEMENTED']), 'a flaky configured test command', 'IMPLEMENTED blocked: STABILITY');
  assert.equal(c.runs(), 2, 'run exactly twice');
  const s = seeded({ testCmd: COUNTER, scaffold: { planExtra: verif('node --version') } });
  const c2 = counterIn(s.d, '0');
  setCmd(s.d, 'test', COUNTER);
  accepted(green(s.d, COUNTER, 'test_durations: lookup=1\n'), 'GREEN');
  wclose(s.d, s.w);
  accepted(A(s.d, ['handoff', 'LC', 'IMPLEMENTED']), 'a stable configured test command');
  assert.ok(c2.runs() >= 2);
});

test('commands.test edited after the run started does not count: an uncommitted edit to `true` and GREEN `true` stays blocked and the plan command is not skipped', () => {
  const { d, w, c } = counterProject('1');
  setCmd(d, 'test', 'true');
  accepted(green(d, 'true', 'test_durations: lookup=1\n'), 'GREEN with the tampered command');
  wclose(d, w);
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(r, 'a tampered commands.test', 'is neither an entry of the plan\'s ## Verification commands nor the configured test command');
  assert.match(r.text, /commands\.test changed since the run started to `true`; only the command the run started with counts/);
  assert.equal(c.runs(), 0, 'the plan command did not run, and the tampered one was not accepted in its place');
});

test('commands.test changed by a commit after the start is blocked too', () => {
  const { d, w } = counterProject('1');
  setCmd(d, 'test', 'true');
  const id = ['-c', 'user.email=a@b.c', '-c', 'user.name=a'];
  execFileSync('git', [...id, 'add', '-f', '.agents/config.yaml'], { cwd: d });
  execFileSync('git', [...id, 'commit', '-q', '-m', 'tamper'], { cwd: d });
  accepted(green(d, 'true', 'test_durations: lookup=1\n'), 'GREEN with the tampered command');
  wclose(d, w);
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  assert.notEqual(r.status, 0);
  assert.match(r.text, /IMPLEMENTED blocked: the GREEN command `true`/);
});

test('the block message says what to do without a plan amendment when a test command is configured, and asks for an amendment only when none is', () => {
  const a = seeded({ testCmd: 'node --version' });
  setCmd(a.d, 'test', 'node --version');
  accepted(green(a.d, 'node -e 0', 'test_durations: lookup=1\n'), 'GREEN');
  wclose(a.d, a.w);
  const ra = A(a.d, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(ra, 'an unlisted command with a configured test command', 're-record GREEN with the project test command (`node --version`)');
  assert.match(ra.text, /no plan amendment is needed/);
  assert.doesNotMatch(ra.text, /refreeze/);
  const b = seeded();
  accepted(green(b.d, 'node -e 0', 'test_durations: lookup=1\n'), 'GREEN');
  wclose(b.d, b.w);
  refused(A(b.d, ['handoff', 'LC', 'IMPLEMENTED']), 'nothing configured, nothing listed', 'a plan amendment and a refreeze must list the narrow command');
});

test('a configured command that the plan does not list does not satisfy the double run (it never has to run the new tests): the handoff is blocked', () => {
  const { d, w } = seeded();
  setCmd(d, 'lint', 'node --version');
  accepted(green(d, 'node --version', 'test_durations: lookup=1\n'), 'GREEN');
  wclose(d, w);
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(r, 'a configured lint command as the GREEN command', 'is neither an entry of the plan\'s ## Verification commands nor the configured test command');
  assert.match(r.text, /a configured build or lint command does not count/);
});

test('the latch is keyed on the content, not on the commit: an empty commit stays blocked and an amend never passes; with the same content, a real change of the content runs the double run again', () => {
  const { d, w, c } = counterProject('1');
  setCmd(d, 'test', c.buildCommand);
  accepted(green(d, c.command, 'test_durations: lookup=1\n'), 'GREEN');
  wclose(d, w);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'attempt 1', 'IMPLEMENTED blocked: STABILITY');
  const id = ['-c', 'user.email=a@b.c', '-c', 'user.name=a'];
  execFileSync('git', [...id, 'commit', '-q', '--allow-empty', '-m', 'empty'], { cwd: d });
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'after an empty commit', 'unstable on exactly this content');
  assert.equal(c.runs(), 2, 'no attempt after the first ran anything');
  const w2 = wopen(d);
  appendFileSync(path.join(d, 'impl_test.txt'), 'test: a changed test\n');
  wclose(d, w2);
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  assert.doesNotMatch(r.text, /unstable on exactly this content/, 'a changed patch is not latched');
  assert.ok(c.runs() > 2, 'the double run ran again on the changed content');
  execFileSync('git', [...id, 'commit', '-q', '--amend', '--allow-empty', '-m', 'amended'], { cwd: d });
  assert.notEqual(A(d, ['handoff', 'LC', 'IMPLEMENTED']).status, 0, 'an amend that rewrites the base is refused (stale plan) before the latch is even asked; it never passes');
});

test('recorded durations that add up to more than the whole command took are a finding that blocks', () => {
  const { d, w } = seeded({ scaffold: { planExtra: verif('node --version') } });
  setCmd(d, 'test', 'node --version');
  accepted(green(d, 'node --version', 'test_durations: lookup=900000\n'), 'GREEN');
  wclose(d, w);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a made-up duration', 'DURATIONS the recorded test durations of `node --version` add up to 900000 ms');
});

test('a DURATIONS block is not latched: re-recording the GREEN evidence with honest durations clears it on the same content, and the message says to re-record', () => {
  const { d, w } = seeded({ scaffold: { planExtra: verif('node --version') } });
  setCmd(d, 'test', 'node --version');
  accepted(green(d, 'node --version', 'test_durations: lookup=900000\n'), 'GREEN with a made-up duration');
  wclose(d, w);
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(r, 'a made-up duration', 'DURATIONS the recorded test durations');
  assert.match(r.text, /Re-record the GREEN evidence with the durations read from the real run output/);
  assert.doesNotMatch(readFileSync(path.join(d, '.agents/runs/LC/LEDGER.log'), 'utf8'), /event=test-measure-block /, 'a durations block is not a stability latch');
  const w2 = wopen(d);
  accepted(green(d, 'node --version', 'test_durations: lookup=1\n'), 'GREEN re-recorded with an honest duration');
  wclose(d, w2);
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'the same content passes once the evidence is honest');
});

test('greenRecords orders GREEN-<n> by the number, so the latest record wins past GREEN-9: GREEN-12 replaces the made-up number of GREEN-5', () => {
  const d = project({ topology: 'orchestrated' });
  const ev = path.join(d, '.agents/runs/LC/worker-evidence');
  mkdirSync(ev, { recursive: true });
  for (let n = 1; n <= 12; n++) writeFileSync(path.join(ev, `GREEN-${n}.yaml`), `command: x\ntest_durations: lookup=${n === 5 ? 900000 : n === 12 ? 3 : 7}\n`);
  const ctx = new Context({ env: {}, cwd: d, stdout: { write: () => true }, stderr: { write: () => true }, scriptPath: `${d}/.agents/scripts/agent.sh` }, `${d}/.agents/scripts/agent.sh`);
  const recs = greenRecords(ctx, 'LC');
  assert.deepEqual(recs.map((r) => r.file), Array.from({ length: 12 }, (_, i) => `GREEN-${i + 1}.yaml`));
  const durations = recs.flatMap((r) => r.durations);
  assert.equal(budgetCheck(durations, [], SHIPPED, new Map()).tests[0].ms, 3, 'the latest record (GREEN-12) is the one that counts');
});

test('the latch token holds the plan Verification commands: a plan amendment that changes the listed commands runs the double run again on the same content', () => {
  const { d, w, c } = counterProject('1');
  setCmd(d, 'test', c.buildCommand);
  accepted(green(d, c.command, 'test_durations: lookup=1\n'), 'GREEN');
  wclose(d, w);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'attempt 1', 'IMPLEMENTED blocked: STABILITY');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'attempt 2, the same plan', 'unstable on exactly this content');
  assert.equal(c.runs(), 2);
  // the amendment: the listed commands change (a second command is added) and the freeze record names the new plan hash, as a refreeze would
  const plan = path.join(d, '.agents/runs/LC/PLAN.md');
  const runYaml = path.join(d, '.agents/runs/LC/RUN.yaml');
  const hashOf = (/** @type {string} */ f) => createHash('sha256').update(readFileSync(f)).digest('hex');
  const old = hashOf(plan);
  appendFileSync(plan, '- `node .git/tm-other.mjs`\n');
  const fresh = hashOf(plan);
  for (const f of [runYaml, ...readdirSync(path.join(d, '.agents/runs/LC/worker-evidence')).map((n) => path.join(d, '.agents/runs/LC/worker-evidence', n))]) writeFileSync(f, readFileSync(f, 'utf8').replaceAll(old, fresh)); // the evidence names the plan hash it was recorded against
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  assert.doesNotMatch(r.text, /unstable on exactly this content/, 'a different list of commands is a different measurement');
  assert.ok(c.runs() > 2, 'the double run ran again');
});

test('durationsExceedWall needs the floor AND the ratio, so a small overlap of a parallel runner is not a finding', () => {
  const tol = { ratio: 4, floorMs: 2000 };
  assert.equal(durationsExceedWall(900000, 300, tol), true);
  assert.equal(durationsExceedWall(1500, 300, tol), false, 'under the floor');
  assert.equal(durationsExceedWall(9000, 4000, tol), false, 'under the ratio');
  assert.equal(durationsExceedWall(100, 50000, tol), false, 'a sum far below the wall time is the normal start-up cost, never a finding');
});

test('a retry in the project own CI configuration is reported, from the ecosystems.json data', () => {
  const { d, w, c } = counterProject('0', { scopeNamed: '.gitlab-ci.yml' });
  setCmd(d, 'test', c.buildCommand);
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

// ---- the real runner: the limit holds against a command that ignores TERM ----------------------------------------------------------

test('realRunner: a command that ignores TERM is killed at the limit with its children (verdict 124, nothing left); the run ends by the process exit, not by a wait', { skip: process.platform === 'win32' ? 'POSIX process groups' : false }, () => {
  const dir = tmp('kill');
  const pidFile = path.join(dir, 'child.pid');
  const ctx = /** @type {any} */ ({ root: dir, childEnv: () => process.env });
  const r = realRunner(ctx, 0.3)(`trap '' TERM; sleep 600 & echo $! > ${posix(pidFile)}; wait`);
  assert.equal(r.status, 124);
  assert.equal(r.timedOut, true);
  const pid = readFileSync(pidFile, 'utf8').trim();
  assert.match(pid, /^[0-9]+$/);
  const st = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' }).stdout.trim();
  assert.ok(st === '' || st.startsWith('Z'), `the child of the killed command is gone (ps says "${st}")`);
});
