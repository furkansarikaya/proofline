// @ts-check
// Issue 266 package 3b (A277): the budget derivation, on recorded reports (tests/fixtures/budget-samples/: two runs, a twice report whose slower run counts). No network, no clock.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cleanUp, derive, jsonFiles, main, maxima } from './derive-budgets.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const samples = path.join(repo, 'tests', 'fixtures', 'budget-samples');
const reports = jsonFiles(samples).map((p) => JSON.parse(readFileSync(p, 'utf8')));
const base = { enforce: true, kinds: { unit: { test_ms: 2000, suite_ms: 30000 }, integration: { test_ms: 10000, suite_ms: 120000 } }, dirs: { 'tests/core': { kind: 'integration' } }, files: { 'tests/old.test.mjs': { test_ms: 1 } } };

test('cleanUp rounds up to a clean number: 500 below 10 s, 5 s below 100 s, 10 s above', () => {
  assert.deepEqual([1, 500, 501, 9999, 10000, 12001, 99999, 100001].map(cleanUp), [500, 500, 1000, 10000, 10000, 15000, 100000, 110000]);
});

test('maxima: the maximum over all reports; the slower run of a twice report counts; the suite total is the largest file total', () => {
  const m = maxima(reports);
  assert.deepEqual(m.get('tests/core/a.test.mjs'), { test: 7000, suite: 9000, testName: 'slow one' });
  assert.deepEqual(m.get('tests/generator/g.test.mjs'), { test: 3100, suite: 3100, testName: 'g' });
  assert.equal(m.get('tests/core/b.test.mjs')?.suite, 900);
});

test('derive: maximum x margin rounded up, never below the kind default; a file at its kind default gets no row; old rows are replaced; the rest of the base is kept', () => {
  const { budgets, rows } = derive(base, reports, { testMargin: 2, suiteMargin: 1.7 });
  assert.equal(budgets.enforce, true);
  assert.deepEqual(budgets.dirs, base.dirs);
  // g: 3100 x 2 = 6200 -> 6500 (unit; the suite 3100 x 1.7 stays under the floor 30000); a: 7000 x 2 -> 15000 over the integration floor 10000, 9000 x 1.7 under 120000; b: under both floors, no row
  assert.deepEqual(budgets.files, { 'tests/core/a.test.mjs': { test_ms: 15000, suite_ms: 120000 }, 'tests/generator/g.test.mjs': { test_ms: 6500, suite_ms: 30000 } });
  assert.equal(rows.length, 3);
  const tight = derive(base, reports, { testMargin: 4, suiteMargin: 20 });
  assert.deepEqual(tight.budgets.files['tests/core/a.test.mjs'], { test_ms: 30000, suite_ms: 180000 });
});

test('main: the same samples give the same bytes, a bad report or no report or a bad option is refused with 2', () => {
  const run = (/** @type {string[]} */ a) => { let out = ''; const st = main(a, { write: (s) => { out += s; } }); return { st, out }; };
  const base1 = path.join(repo, 'tests', 'fixtures', 'budget-samples-base.json');
  const r1 = run(['--base', base1, samples]);
  assert.equal(r1.st, 0);
  assert.equal(run(['--base', base1, samples]).out, r1.out);
  assert.deepEqual(Object.keys(JSON.parse(r1.out).files), ['tests/core/a.test.mjs', 'tests/generator/g.test.mjs']);
  assert.equal(run([]).st, 2);
  assert.equal(run(['--bogus', samples]).st, 2);
  assert.equal(run(['--test-margin', '0.5', samples]).st, 2);
  let msg = '';
  assert.equal(main(['--base', base1, 'x'], { write: (s) => { msg += s; }, list: () => ['bad.json'], read: (p) => (p === base1 ? '{}' : 'not json') }), 2);
  assert.match(msg, /not a JSON report/);
  assert.equal(main(['--base', base1, 'x'], { write: () => {}, list: () => [], read: () => '{}' }), 2);
});
