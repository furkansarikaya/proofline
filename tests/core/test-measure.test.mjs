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
import { before, test } from 'node:test';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { Config, configLines } from '../../control-plane/agents/scripts/core/config.mjs';
import { ledgerAppend } from '../../control-plane/agents/scripts/core/lock.mjs';
import { DEFAULTS, KINDS, budgetCheck, budgetTable, doubleRun, durationsExceedWall, greenRecords, kindOf, parseDurations, planKinds, realRunner, testCmdPin, toleranceOf, withinTolerance } from '../../control-plane/agents/scripts/core/testmeasure.mjs';
import { A, accepted, cached, codeKey, copyOf, project, refused, sha256, tmp, wclose, wev, wopen } from '../lib/harness.mjs';
import { supersededGreens } from '../../control-plane/agents/scripts/core/testmeasure.mjs';
import { missingFindings } from '../../control-plane/agents/scripts/core/testreview.mjs';
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

test('planKinds takes the test names before the description only: a quoted value in the description or in a code span is data, not a test (COMPLEX run, "book club" and "sci-fi")', () => {
  const bullets = [
    '- AC-2: `tests/api.test.js` "POST tags normalises and returns the book" — returns 200 with `["book club", "sci-fi"]`; a later GET returns the same (test_kind: integration)',
    '- AC-3: `tests/api.test.js` "adding an existing tag in other case keeps one tag" -- adding "SCI-FI" to a book tagged "sci-fi" leaves one (test_kind: integration)',
    '- AC-4: `a.test` "first name", "second name" and "third - name" – the tag "x" is stored (test_kind: unit)',
    '- AC-5: `b.test` "no description at all" (test_kind: unit)',
    '- AC-6: `c.test` "kept" - expects "data" (test_kind: unit)',
    '- AC-7: `d - e.test` "dash in the file" — expects "data" (test_kind: unit)',
  ];
  const pk = planKinds(`## Tests\n\n${bullets.join('\n')}\n`);
  assert.deepEqual(pk.names.map((x) => x.name), [
    'post tags normalises and returns the book',
    'adding an existing tag in other case keeps one tag',
    'first name', 'second name', 'third - name',
    'no description at all', 'kept', 'dash in the file',
  ]);
});

test('planKinds (A343): a bullet with no dash and no quoted name takes no name; a quote inside a code span is code, not a name', () => {
  const names = (/** @type {string} */ b) => planKinds(`## Tests\n${b}\n`).names.map((x) => x.name);
  // the real bullet of the smoke batch: no dash, no quoted name, quotes only inside code spans
  assert.deepEqual(names('- AC-1: `tests/whisper.test.js` asserts `whisper("Hello")` equals `"hello..."` (test_kind: unit)'), []);
  // a code span with quotes before the dash, then a dash: the fallback reads quotes after the dash only
  assert.deepEqual(names('- AC-1: `t.test` `f("a")` — returns "b" (test_kind: unit)'), ['b']);
  assert.deepEqual(names('- AC-1: `t.test` `f("a")` — returns `x` (test_kind: unit)'), []);
  // a quoted name with code spans (quotes inside) in the description keeps exactly the name
  assert.deepEqual(names('- AC-1: `t.test` "whisper lowers" — `whisper("Hello")` equals `"hello..."` (test_kind: unit)'), ['whisper lowers']);
  // a name before the code span and no dash keeps the name (documented limit of A316 unchanged)
  assert.deepEqual(names('- AC-1: `t.test` "whisper" asserts `f("x")` (test_kind: unit)'), ['whisper']);
});

test('planKinds (A343): a quoted name keeps the backticks inside it; a star bullet is read; the validator copy of the scan and of the bullet predicate is identical', async () => {
  const names = (/** @type {string} */ b) => planKinds(`## Tests\n${b}\n`).names.map((x) => x.name);
  assert.deepEqual(names('- AC-1: `t.test` "`--json` prints json" — x (test_kind: unit)'), ['`--json` prints json']);
  assert.deepEqual(names('- AC-1: `t.test` "`--json`" — x (test_kind: unit)'), ['`--json`']);
  assert.deepEqual(names('- AC-1: `t.test` "has `code` in" — x (test_kind: unit)'), ['has `code` in']);
  assert.deepEqual(names('* AC-1: `t.test` "zero at threshold" asserts `f("x")` (test_kind: unit)'), ['zero at threshold']);
  assert.deepEqual(names('* AC-1: `t.test` asserts `test("zero at threshold")` (test_kind: unit)'), []);
  // a backtick span that opens first hides its quotes, a quote that opens first hides its backticks
  assert.deepEqual(names('- AC-1: `t.test` `a "b" c` "d" — x (test_kind: unit)'), ['d']);
  const { readFileSync } = await import('node:fs');
  const grab = (/** @type {string} */ f) => { const t = readFileSync(new URL(f, import.meta.url), 'utf8'); const a = t.indexOf('function scanTestBullet'); return { fn: t.slice(a, t.indexOf('\n}\n', a)), sep: /const reSeparator = .*/.exec(t)?.[0], bullet: /\/\^\\s\*\[-\*\]\\s\+AC-\\d\+:\/i/.exec(t)?.[0] }; };
  const a1 = grab('../../control-plane/agents/scripts/core/testmeasure.mjs'); const a2 = grab('../../skills/plan-contract/scripts/validate-plan.mjs');
  assert.ok(a1.fn.length > 200 && a1.bullet !== undefined);
  assert.deepEqual(a2, a1, 'the validator keeps an identical copy of the scan, the separator and the bullet predicate');
  const v = await import('../../skills/plan-contract/scripts/validate-plan.mjs');
  const lines = ['- AC-1: `t` "`--json`" — x (test_kind: unit)', '* AC-1: `t` `f("a")` — "b" (test_kind: unit)', '- AC-1: `t` asserts `f("a")` (test_kind: unit)', '- AC-1: `t` "has `code` in" and "z - y" - q (test_kind: unit)'];
  // the validator accepts a line exactly when the parser reads a name before the dash
  for (const l of lines) assert.equal(v.hasTestName(l), /^\s*[-*]\s+AC-\d+:\s*(?:`[^`]*`\s*)*(?:"[^"]*[^"\s][^"]*")/.test(l), l);
});

test('planKinds (A343 round 2): an unmatched backtick is text; a double-backtick span is code; adjacent quotes keep the old name', () => {
  const names = (/** @type {string} */ b) => planKinds(`## Tests\n${b}\n`).names.map((x) => x.name);
  assert.deepEqual(names('- AC-1: `tests/a.test.js "zero at threshold" — x (test_kind: unit)'), ['zero at threshold']);
  assert.deepEqual(names('- AC-1: `a.test` ``ship("5000")`` — x (test_kind: unit)'), []);
  assert.deepEqual(names('- AC-1: `a.test` ``a ` b "c"`` "d" — x (test_kind: unit)'), ['d']);
  assert.deepEqual(names('- AC-1: `a.test` ```x``` "e" — y (test_kind: unit)'), ['e']);
  assert.deepEqual(names('- AC-1: `a.test` ``x` "f" — y (test_kind: unit)'), ['f']);
  assert.deepEqual(names('- AC-1: `a.test` ""edge"" — y (test_kind: unit)'), ['edge']);
});

test('planKinds: separators, quotes in code spans after the separator, and the limit of a bullet with no separator', () => {
  const names = (/** @type {string} */ b) => planKinds(`## Tests\n${b}\n`).names.map((x) => x.name);
  // the name list ends at an en dash, "--" or a spaced hyphen; everything after is description
  assert.deepEqual(names('- AC-1: `a.test` "one", "two" – stores "x" (test_kind: unit)'), ['one', 'two']);
  assert.deepEqual(names('- AC-1: `a.test` "one" -- stores "x" (test_kind: unit)'), ['one']);
  assert.deepEqual(names('- AC-1: `a.test` "one" - stores "x" (test_kind: unit)'), ['one']);
  // quotes inside code spans after the separator are data
  assert.deepEqual(names('- AC-1: `a.test` "one" — returns `{"tags": ["a b"]}` and "c d" (test_kind: unit)'), ['one']);
  // a quoted name containing a dash does not end the list
  assert.deepEqual(names('- AC-1: `a.test` "one - two" — x (test_kind: unit)'), ['one - two']);
  // documented limit: with no separator every quoted string is still read as a test name
  assert.deepEqual(names('- AC-1: `a.test` "one" returns "data" (test_kind: unit)'), ['one', 'data']);
});

test('planKinds: indented, nested, star, tab and two-digit bullets keep their names; a bullet naming no test before the dash reads every quote', () => {
  const names = (/** @type {string} */ b) => planKinds(`## Tests\n${b}\n`).names.map((x) => x.name);
  const tail = '`a.test` "real one" — expects "x" (test_kind: unit)';
  for (const marker of ['  - AC-1:', '    - AC-1:', '- AC-1:', '* AC-1:', '\t- AC-1:', '  * AC-12:', '- AC-12:']) assert.deepEqual(names(`${marker} ${tail}`), ['real one'], marker);
  assert.deepEqual(names('    - AC-1: "real one" (test_kind: unit)'), ['real one']);
  assert.deepEqual(names('  - AC-1: "only names", "two" (test_kind: unit)'), ['only names', 'two']);
  // no name before the dash: the old behaviour for that bullet, every quoted string is a name
  assert.deepEqual(names('- AC-1: `a.test` — "must run" (test_kind: unit)'), ['must run']);
  assert.deepEqual(names('- AC-1: foo - "must run" (test_kind: unit)'), ['must run']);
  assert.deepEqual(names('- AC-1: (test_kind: unit) — `a.test` "n" and "m"'), ['n', 'm']);
  // the COMPLEX case is unchanged: names before the dash, data values after
  assert.deepEqual(names('- AC-2: `t.js` "POST tags" — returns `["book club", "sci-fi"]` (test_kind: integration)'), ['post tags']);
  // not covered: no name before the dash and quoted DATA after it still reads the data as names
  assert.deepEqual(names('- AC-1: `a.test` — returns "book club" (test_kind: unit)'), ['book club']);
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

// The cold build of a seed (a code change makes every seed new) is paid here, once, outside any test: the first test that used a variant was 4 times slower than its second run (A311 pattern).
before(() => {
  for (const o of [
    {}, { stamped: false }, { scaffold: { planExtra: PLAN } }, { scaffold: { planExtra: verif(COUNTER) } }, { scaffold: { planExtra: verif(COUNTER), scopeNamed: '.gitlab-ci.yml' } },
    { scaffold: { planExtra: '\n## Verification commands\n\n- `node -e 0`\n' } }, { scaffold: { planExtra: verif('node --version') } },
    { testCmd: COUNTER, scaffold: { planExtra: verif('node --version') } }, { testCmd: 'node --version' },
  ]) rmSync(seeded(o).d, { recursive: true, force: true });
});

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
  assert.match(readFileSync(path.join(d, '.agents/runs/LC/LEDGER.log'), 'utf8'), /event=test-measure .* detail=tests=1 double_run=1 not_run=0 budget_findings=0 stability_findings=0 blockers=0 retries=0 greens=1$/m);
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

test('a stamped run with no pin row accepts plan-listed commands only, and its block message asks for a plan amendment, not for the project test command', () => {
  const { d, w } = seeded({ testCmd: 'node --version' });
  setCmd(d, 'test', 'node --version');
  const ledger = path.join(d, '.agents/runs/LC/LEDGER.log');
  // a run started before the pin existed has no test-cmd-pin row
  writeFileSync(ledger, readFileSync(ledger, 'utf8').split('\n').filter((l) => !l.includes(' event=test-cmd-pin ')).join('\n'));
  accepted(green(d, 'node --version', 'test_durations: lookup=1\n'), 'GREEN');
  wclose(d, w);
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  assert.notEqual(r.status, 0);
  assert.match(r.text, /a plan amendment and a refreeze must list the narrow command/);
  assert.doesNotMatch(r.text, /re-record GREEN with the project test command/);
});

test('only the latest GREEN record decides: an earlier unlisted command that a later listed one replaced is a note, a later unlisted one after a listed one blocks', () => {
  const a = counterProject('0');
  accepted(green(a.d, 'node -e 0', 'test_durations: lookup=1\n'), 'GREEN-1, an unlisted direct runner');
  wclose(a.d, a.w);
  const w2 = wopen(a.d);
  accepted(green(a.d, a.c.command, 'test_durations: lookup=1\n'), 'GREEN-2, the listed command');
  wclose(a.d, w2);
  const ra = accepted(A(a.d, ['handoff', 'LC', 'IMPLEMENTED']), 'the latest GREEN is listed');
  assert.match(ra.text, /note: superseded: the earlier GREEN command `node -e 0`/);
  assert.ok(a.c.runs() >= 2, 'the latest command was double-run');

  const b = counterProject('0');
  accepted(green(b.d, b.c.command, 'test_durations: lookup=1\n'), 'GREEN-1, the listed command');
  wclose(b.d, b.w);
  const w3 = wopen(b.d);
  accepted(green(b.d, 'node -e 0', 'test_durations: lookup=1\n'), 'GREEN-2, an unlisted command');
  wclose(b.d, w3);
  refused(A(b.d, ['handoff', 'LC', 'IMPLEMENTED']), 'the latest GREEN is unlisted', 'the GREEN command `node -e 0` is neither an entry');
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

// ---- A336: one supersession rule for the IMPLEMENTED handoff and the REVIEW_TESTS demand ------------------------------------------------

/** @param {string} command @param {string} durations `name=ms; ...` @param {boolean} [genuine] */
const rec = (command, durations, genuine = true) => ({ file: 'x', command, durations: durations === '' ? [] : durations.split(';').map((e) => ({ name: e.split('=')[0].trim(), ms: Number(e.split('=')[1]) })), genuine });
/** @param {ReturnType<typeof rec>[]} gs @returns {ReturnType<typeof rec>[]} the records named GREEN-1.. in order */
const numbered = (gs) => gs.map((g, i) => ({ ...g, file: `GREEN-${i + 1}.yaml` }));
const allowOnly = (/** @type {string} */ ...ok) => (/** @type {string} */ c) => ok.includes(c);

test('A336 supersededGreens: the COMPLEX sequence (a narrow command, then the allowed one that covers the same tests) is superseded; every negative stays a finding', () => {
  const T = 'a=1; b=2; c=3';
  const sup = (/** @type {ReturnType<typeof rec>[]} */ gs, /** @type {(c: string) => boolean} */ ok = allowOnly('npm test'), /** @type {any} */ can = undefined) => supersededGreens(numbered(gs), ok, can);
  assert.deepEqual([...sup([rec('node --test x', T), rec('npm test', T)])], [['node --test x', ['GREEN-2']]], 'positive');
  assert.deepEqual([...sup([rec('node --test x', 'a=1; B=2'), rec('npm test', 'b=5; A=6; extra=1')])], [['node --test x', ['GREEN-2']]], 'case-insensitive names, the later record may cover more');
  assert.deepEqual([...sup([rec('node --test x', 'a=1; b=2'), rec('npm test', 'a=1'), rec('npm test', 'b=2')])], [['node --test x', ['GREEN-2', 'GREEN-3']]], 'covered by two later records together');
  assert.equal(sup([rec('node --test x', T)]).size, 0, 'no later record: the only coverage');
  assert.equal(sup([rec('node --test x', T), rec('npm test', 'a=1; b=2')]).size, 0, 'the later record covers fewer tests');
  assert.equal(sup([rec('node --test x', T), rec('node --test y', T)]).size, 0, 'the later record has a command that is not allowed');
  assert.equal(sup([rec('npm test', T), rec('node --test x', T)]).size, 0, 'order reversed: the allowed record is earlier');
  assert.equal(sup([rec('node --test x', T), rec('npm test', T), rec('node --test x', 'a=1')]).size, 0, 'the narrow command recorded again after the covering one is the latest');
  assert.equal(sup([rec('node --test x', ''), rec('npm test', T)]).size, 0, 'a record with no duration claims nothing that could be covered: stays a finding');
  assert.equal(sup([rec('node --test x', T), rec('npm test', '')]).size, 0, 'a later record with no durations covers nothing');
  assert.equal(sup([rec('node --test x', T), rec('npm test', T)], allowOnly('npm test'), () => false).size, 0, 'a later record the caller does not accept (repair, forged, not double-run)');
  assert.equal(sup([rec('node --test x', T), rec('npm test', T)], allowOnly('node --test x', 'npm test')).size, 0, 'an allowed command is never superseded');
  assert.equal(sup([rec('node --test x', T), rec('', T)], () => true).size, 0, 'a record without a command is not a superseder');
});

test('A336 handoff: an earlier unlisted command is superseded only when the later listed record covers its tests; one that is the only coverage of a test blocks', () => {
  const a = counterProject('0');
  accepted(green(a.d, 'node -e 0', 'test_durations: lookup=1; other=2\n'), 'GREEN-1, an unlisted direct runner with two tests');
  wclose(a.d, a.w);
  const w2 = wopen(a.d);
  accepted(green(a.d, a.c.command, 'test_durations: lookup=1\n'), 'GREEN-2, the listed command covers only one');
  wclose(a.d, w2);
  const r = A(a.d, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(r, 'the narrow command is the only coverage of "other"', 'the GREEN command `node -e 0` is neither an entry');
  assert.match(r.text, /no later accepted record with an allowed command covers these tests of it: "other"; record a GREEN with a plan-listed or project test command that reports durations for these tests/);
  assert.doesNotMatch(r.text, /"lookup"/, 'the covered test is not listed');

  const b = counterProject('0');
  accepted(green(b.d, 'node -e 0', 'test_durations: lookup=1\n'), 'GREEN-1');
  wclose(b.d, b.w);
  const w3 = wopen(b.d);
  accepted(green(b.d, 'node -e 1', 'test_durations: lookup=1\n'), 'GREEN-2, another unlisted command');
  wclose(b.d, w3);
  const rb = A(b.d, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(rb, 'the later record has a command that is not allowed', 'is neither an entry');
  assert.match(rb.text, /`node -e [01]`/);
});

test('A336 handoff: a covering record that an evidence-repair row names, or with a forged plan hash, does not supersede the narrow command', () => {
  const make = () => {
    const a = counterProject('0');
    accepted(green(a.d, 'node -e 0', 'test_durations: lookup=1\n'), 'GREEN-1, the narrow command');
    wclose(a.d, a.w);
    const w2 = wopen(a.d);
    accepted(green(a.d, a.c.command, 'test_durations: lookup=1\n'), 'GREEN-2, the listed command');
    wclose(a.d, w2);
    return a.d;
  };
  const d1 = make();
  ledgerAppend(path.join(d1, '.agents/runs/LC'), 'lead', 'evidence-repair', 'IMPLEMENTING', 'IMPLEMENTING', 'finding=011-reviewer-tests.yaml patch=x commands=1 records=GREEN-2 tests=x');
  const r1 = A(d1, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(r1, 'the covering record is a repair row record', 'the GREEN command `node -e 0` is neither an entry');
  assert.match(r1.text, /covers these tests of it: "lookup"/);
  const d2 = make();
  const f = path.join(d2, '.agents/runs/LC/worker-evidence/GREEN-2.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/plan_sha256: "[0-9a-f]+"/, `plan_sha256: "${'0'.repeat(64)}"`));
  const r2 = A(d2, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(r2, 'the covering record has a forged plan hash', 'the GREEN command `node -e 0` is neither an entry');
  assert.match(r2.text, /covers these tests of it: "lookup"/);
});

test('A336 REVIEW_TESTS: the superseded narrow command is shown as such and is not demanded as a finding; the demand returns for every tampered, repaired, uncounted or unclean case', () => {
  const ledgerOf = (/** @type {string} */ d) => path.join(d, '.agents/runs/LC/LEDGER.log');
  const base = () => {
    const a = counterProject('0');
    accepted(green(a.d, 'node -e 0', 'test_durations: lookup=1\n'), 'GREEN-1, the narrow command');
    wclose(a.d, a.w);
    const w2 = wopen(a.d);
    accepted(green(a.d, a.c.command, 'test_durations: lookup=1\n'), 'GREEN-2, the listed command');
    wclose(a.d, w2);
    accepted(A(a.d, ['handoff', 'LC', 'IMPLEMENTED']), 'the narrow command is superseded');
    return a.d;
  };
  const ctxOf = (/** @type {string} */ d) => new Context({ env: { PATH: process.env.PATH ?? '' }, cwd: d, stdout: { write: () => true }, stderr: { write: () => true }, scriptPath: `${d}/.agents/scripts/agent.sh` }, `${d}/.agents/scripts/agent.sh`);
  const demands = (/** @type {string} */ d) => missingFindings(ctxOf(d), 'LC', { findings: [] }).filter((m) => /that the control plane did not run twice/.test(m));
  const d = base();
  const built = copyOf(d);
  assert.deepEqual(demands(d), [], 'no finding is demanded for the superseded narrow command');
  const inputs = A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' }).out;
  assert.match(inputs, /green-command: `node -e 0` source=superseded by GREEN-2 /);
  assert.match(inputs, new RegExp(`green-command: \`${COUNTER}\` source=plan-listed`));
  const json = JSON.parse(A(d, ['build-record', 'LC', 'scan', '--json'], { role: 'reviewer' }).out);
  assert.deepEqual(json.measurement.green_commands.find((/** @type {any} */ g) => g.command === 'node -e 0'), { command: 'node -e 0', source: 'superseded', superseded_by: ['GREEN-2'] });

  const mutate = (/** @type {string} */ what, /** @type {(dir: string) => void} */ f) => { const x = copyOf(built); f(x); assert.equal(demands(x).length, 1, what); assert.match(demands(x)[0], /node -e 0/, what); };
  mutate('a row from before the count existed supersedes nothing', (x) => writeFileSync(ledgerOf(x), readFileSync(ledgerOf(x), 'utf8').replace(/ greens=\d+/, '')));
  mutate('a record made after the last row (count 1) cannot supersede', (x) => writeFileSync(ledgerOf(x), readFileSync(ledgerOf(x), 'utf8').replace(/ greens=2/, ' greens=1')));
  mutate('a row that says nothing was run twice', (x) => writeFileSync(ledgerOf(x), readFileSync(ledgerOf(x), 'utf8').replace('double_run=1', 'double_run=0')));
  mutate('a row with a stability finding', (x) => writeFileSync(ledgerOf(x), readFileSync(ledgerOf(x), 'utf8').replace('stability_findings=0', 'stability_findings=1')));
  mutate('a row with a blocker', (x) => writeFileSync(ledgerOf(x), readFileSync(ledgerOf(x), 'utf8').replace(/blockers=0/, 'blockers=1')));
  mutate('a superseding record that an evidence-only repair row names', (x) => ledgerAppend(path.join(x, '.agents/runs/LC'), 'lead', 'evidence-repair', 'IMPLEMENTING', 'IMPLEMENTING', 'finding=011-reviewer-tests.yaml patch=x commands=1 records=GREEN-2 tests=x'));
  mutate('a superseding record with a forged plan hash', (x) => { const f = path.join(x, '.agents/runs/LC/worker-evidence/GREEN-2.yaml'); writeFileSync(f, readFileSync(f, 'utf8').replace(/plan_sha256: "[0-9a-f]+"/, `plan_sha256: "${'0'.repeat(64)}"`)); });
  mutate('a superseding record for another task', (x) => { const f = path.join(x, '.agents/runs/LC/worker-evidence/GREEN-2.yaml'); writeFileSync(f, readFileSync(f, 'utf8').replace('task_id: "LC"', 'task_id: "OTHER"')); });
  mutate('a superseding record whose result is not pass', (x) => { const f = path.join(x, '.agents/runs/LC/worker-evidence/GREEN-2.yaml'); writeFileSync(f, readFileSync(f, 'utf8').replace('result: "pass"', 'result: "fail"')); });
  mutate('a superseding record that no longer gives the duration of the claimed test', (x) => { const f = path.join(x, '.agents/runs/LC/worker-evidence/GREEN-2.yaml'); writeFileSync(f, readFileSync(f, 'utf8').replace('lookup=1', 'other=1')); });
  mutate('no later record at all', (x) => rmSync(path.join(x, '.agents/runs/LC/worker-evidence/GREEN-2.yaml')));
});
