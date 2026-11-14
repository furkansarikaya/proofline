// @ts-check
// Issue 266 package 1 (A277): the duration tool. No test waits, reads a clock or runs a real test suite for its maths: the runner is injected and returns recorded reporter
// output (tests/fixtures/test-durations/run1.jsonl, run2.jsonl). One smoke test starts the real reporter on a three-line test file in a throwaway folder.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tmp } from '../lib/harness.mjs';
import { analyse, main, parseEvents, renderText, summarize } from './test-durations.mjs';
import report, { lineOf } from './test-durations-reporter.mjs';

const fx = (/** @type {string} */ n) => readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'test-durations', n), 'utf8');
const OPT = { top: 3, ratio: 4, floorMs: 2000 };

test('parseEvents: reads the JSON lines of the reporter and ignores any other line', () => {
  const ev = parseEvents(fx('run1.jsonl'));
  assert.equal(ev.length, 11);
  assert.deepEqual(ev[0], { file: 'tests/a.test.mjs', name: 'fast', nesting: 1, ms: 2.5, outcome: 'pass', suite: false });
  assert.deepEqual(parseEvents('{broken\n{"file":1}\n\n'), []);
});

test('summarize: names a nested test after its parents, sums the top level per file, numbers repeated names', () => {
  const s = summarize(parseEvents(fx('run1.jsonl')));
  assert.deepEqual(s.tests.map((t) => `${t.file}|${t.name}`), [
    'tests/a.test.mjs|Suite A > fast', 'tests/a.test.mjs|Suite A > outer', 'tests/a.test.mjs|Suite A > outer > inner', 'tests/a.test.mjs|Suite A > slow',
    'tests/b.test.mjs|flaky outcome', 'tests/b.test.mjs|jittery', 'tests/b.test.mjs|only in run 1', 'tests/b.test.mjs|top level', 'tests/b.test.mjs|twice', 'tests/b.test.mjs|twice #2',
  ]);
  assert.deepEqual(s.files, [{ file: 'tests/b.test.mjs', ms: 3115, tests: 6 }, { file: 'tests/a.test.mjs', ms: 950, tests: 4 }]);
  assert.equal(s.total_ms, 4065);
});

test('analyse, one run: the slowest tests, the file totals and the failures, in a fixed order', () => {
  const a = analyse([{ status: 0, events: parseEvents(fx('run1.jsonl')) }], OPT);
  assert.deepEqual(a.slowest.map((t) => [t.name, t.max_ms]), [['top level', 3000], ['Suite A > slow', 900], ['jittery', 100]]);
  assert.deepEqual(a.files.map((f) => [f.file, f.min_ms, f.max_ms]), [['tests/b.test.mjs', 3115, 3115], ['tests/a.test.mjs', 950, 950]]);
  assert.deepEqual([a.total_min_ms, a.total_max_ms, a.failed, a.unstable], [4065, 4065, [], []]);
});

test('analyse, two runs: outcome, missing and duration differences are unstable; a small or proportional change is not', () => {
  const runs = [{ status: 0, events: parseEvents(fx('run1.jsonl')) }, { status: 1, events: parseEvents(fx('run2.jsonl')) }];
  const a = analyse(runs, OPT);
  assert.deepEqual(a.unstable.map((u) => `${u.reason}:${u.name}`), ['outcome:flaky outcome', 'duration:jittery', 'missing:only in run 1']);
  assert.deepEqual(a.failed, [{ file: 'tests/b.test.mjs', name: 'flaky outcome' }]);
  assert.deepEqual([a.total_min_ms, a.total_max_ms], [4065, 6858]);
  // slow went 900 -> 1100 ms: inside the tolerance of 2000 ms, so stable; with a floor of 100 ms and a ratio of 1.1 it is unstable
  assert.ok(!a.unstable.some((u) => u.name.endsWith('slow')));
  const strict = analyse(runs, { top: 3, ratio: 1.1, floorMs: 100 });
  assert.ok(strict.unstable.some((u) => u.name === 'Suite A > slow'));
});

test('renderText: tables with min and max, a failed list and the unstable list', () => {
  const runs = [{ status: 0, events: parseEvents(fx('run1.jsonl')) }, { status: 1, events: parseEvents(fx('run2.jsonl')) }];
  const t = renderText(analyse(runs, OPT));
  assert.match(t, /^runs 2; 10 tests in 2 files; total 4065 ms \(min\) \/ 6858 ms \(max\); exit statuses 0,1\n/);
  assert.match(t, /\n {4}3000\.0 {5}3100\.0 {2}tests\/b\.test\.mjs :: top level\n/);
  assert.match(t, /\nfailed \(1\)\n {2}tests\/b\.test\.mjs :: flaky outcome\n/);
  assert.match(t, /\n {2}duration: tests\/b\.test\.mjs :: jittery \[pass \/ pass\] \[100 \/ 2600 ms\]\n/);
});

test('renderText: a test name with a newline or an escape sequence stays one printable line', () => {
  const ev = parseEvents('{"file":"a.test.mjs","name":"x\\ny\\u001b[31mred","nesting":0,"ms":1,"outcome":"fail","suite":false}\n');
  const t = renderText(analyse([{ status: 1, events: ev }], OPT));
  assert.ok(!/[\u0000-\u0009\u000b-\u001f]/.test(t));
  assert.match(t, / {2}a\.test\.mjs :: x y {1}\[31mred\n/);
});

test('main: --twice runs the injected runner twice, --json and --out carry the same report, the exit status says unstable, usage errors are 2', () => {
  const outs = [fx('run1.jsonl'), fx('run2.jsonl')];
  /** @type {string[][]} */ const calls = [];
  const io = { run: (/** @type {string[]} */ args) => { calls.push(args); return { status: 0, stdout: /** @type {string} */ (outs.shift()) }; }, load: () => [1.234, 2, 3] };
  let text = '';
  const file = path.join(tmp('durations-'), 'out.json');
  const st = main(['--twice', '--json', '--load', '--top', '2', '--out', file, '--', 'tests/x/*.test.mjs', '--test-name-pattern=a'], { ...io, write: (s) => { text += s; } });
  assert.equal(st, 1);
  assert.deepEqual(calls, [['tests/x/*.test.mjs', '--test-name-pattern=a'], ['tests/x/*.test.mjs', '--test-name-pattern=a']]);
  const j = JSON.parse(text);
  assert.equal(j.runs, 2); assert.equal(j.slowest.length, 2); assert.deepEqual(j.load[0], [[1.23, 2, 3], [1.23, 2, 3]]);
  assert.equal(readFileSync(file, 'utf8'), text);
  const quiet = main(['--', 'a.test.mjs'], { run: () => ({ status: 0, stdout: fx('run1.jsonl') }), write: () => {} });
  assert.equal(quiet, 0);
  for (const bad of [[], ['--', ], ['--top', '0', '--', 'a'], ['--bogus', '--', 'a'], ['--ratio', 'x', '--', 'a'], ['a.test.mjs']]) {
    let msg = '';
    assert.equal(main(bad, { run: () => assert.fail('no run'), write: (s) => { msg += s; } }), 2, bad.join(' '));
    assert.match(msg, /usage: test-durations\.mjs/);
  }
});

test('the reporter: one JSON line per finished test or suite, files relative, skip and todo named, other events ignored', async () => {
  const cwd = path.resolve('/work/repo');
  const abs = path.join(cwd, 'tests', 'a.test.mjs');
  assert.equal(lineOf({ type: 'test:start', data: {} }, cwd), null);
  assert.deepEqual(JSON.parse(/** @type {string} */ (lineOf({ type: 'test:pass', data: { name: 'x', nesting: 1, file: abs, details: { duration_ms: 1.5, type: 'test' } } }, cwd))), { file: 'tests/a.test.mjs', name: 'x', nesting: 1, ms: 1.5, outcome: 'pass', suite: false });
  assert.equal(JSON.parse(/** @type {string} */ (lineOf({ type: 'test:fail', data: { name: 'x', nesting: 0, file: abs, details: { duration_ms: 1, type: 'suite' } } }, cwd))).outcome, 'fail');
  assert.equal(JSON.parse(/** @type {string} */ (lineOf({ type: 'test:pass', data: { name: 'x', nesting: 0, file: abs, skip: 'why', details: { duration_ms: 0 } } }, cwd))).outcome, 'skip');
  assert.equal(JSON.parse(/** @type {string} */ (lineOf({ type: 'test:pass', data: { name: 'x', nesting: 0, file: abs, todo: true, details: { duration_ms: 0 } } }, cwd))).outcome, 'todo');
  async function* src() { yield { type: 'test:diagnostic', data: {} }; yield { type: 'test:pass', data: { name: 'y', nesting: 0, file: '', details: { duration_ms: 2 } } }; }
  const got = [];
  for await (const l of report(src())) got.push(l);
  assert.deepEqual(got, ['{"file":"","name":"y","nesting":0,"ms":2,"outcome":"pass","suite":false}\n']);
});

test('smoke: the real reporter and runner on a three-line test file give the table (Node event shape)', () => {
  const d = tmp('durations-smoke-');
  writeFileSync(path.join(d, 'one.test.mjs'), "import { test } from 'node:test';\ntest('adds', () => {});\ntest('adds more', () => {});\n");
  let text = '';
  const st = main(['--json', '--', path.join(d, 'one.test.mjs')], { write: (s) => { text += s; } });
  assert.equal(st, 0);
  const j = JSON.parse(text);
  assert.equal(j.tests, 2); assert.deepEqual(j.slowest.map((/** @type {any} */ t) => t.name).sort(), ['adds', 'adds more']);
  assert.equal(j.files.length, 1);
});
