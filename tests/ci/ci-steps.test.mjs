// @ts-check
// The `skill-tests` and `gate` commands of tests/ci/ci-steps.mjs (A251): the logic of two multi-line CI steps, now one-line `node` steps. Injected exec/list/env, no process is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateFailures, main } from './ci-steps.mjs';

/** @param {string[]} argv @param {Parameters<typeof main>[1]} io */
function run(argv, io) {
  /** @type {string[]} */ const out = [];
  const status = main(argv, { write: (s) => out.push(s), ...io });
  return { status, out: out.join('') };
}

test('skill-tests: test files in tests/skills run first, then the benchmark tests', () => {
  /** @type {string[]} */ const calls = [];
  const r = run(['skill-tests'], { list: () => ['a.test.mjs', 'README.md'], exec: (p, a) => { calls.push(`${p} ${a.join(' ')}`); return 0; } });
  assert.equal(r.status, 0);
  assert.deepEqual(calls, ['node --test tests/skills/', 'node --test tests/benchmark/benchmark.test.mjs']);
  assert.equal(r.out, '');
});

test('skill-tests: no test file there prints the SKIPPED line and still runs the benchmark tests', () => {
  /** @type {string[]} */ const calls = [];
  const r = run(['skill-tests'], { list: () => ['README.md'], exec: (p, a) => { calls.push(a.join(' ')); return 0; } });
  assert.equal(r.status, 0);
  assert.deepEqual(calls, ['--test tests/benchmark/benchmark.test.mjs']);
  assert.equal(r.out, 'SKIPPED: no tests/skills/*.test.mjs yet\n');
  const missing = run(['skill-tests'], { list: () => { throw new Error('ENOENT'); }, exec: () => 0 });
  assert.match(missing.out, /SKIPPED/);
});

test('skill-tests: the first failing status ends the step, the benchmark tests are then not run (the shell step stopped at the first failure)', () => {
  /** @type {string[]} */ const calls = [];
  const r = run(['skill-tests'], { list: () => ['a.test.mjs'], exec: (_p, a) => { calls.push(a.join(' ')); return 3; } });
  assert.equal(r.status, 3);
  assert.equal(calls.length, 1);
  const r2 = run(['skill-tests'], { list: () => [], exec: () => 5 });
  assert.equal(r2.status, 5);
});

test('gate: success and skipped jobs pass, a failed or cancelled job fails, an unreadable context fails closed', () => {
  const ok = JSON.stringify({ changes: { result: 'success' }, fixtures: { result: 'skipped' }, types: { result: 'success' } });
  assert.deepEqual(gateFailures(ok), []);
  assert.deepEqual(gateFailures(JSON.stringify({ a: { result: 'success' }, b: { result: 'failure' }, c: { result: 'cancelled' } })), ['b', 'c']);
  for (const bad of [undefined, '', 'not json', '[]', '{}', 'null', JSON.stringify({ a: {} }), JSON.stringify({ a: null })]) assert.notDeepEqual(gateFailures(bad), [], String(bad));
  assert.equal(run(['gate'], { env: { NEEDS_JSON: ok } }).status, 0);
  assert.equal(run(['gate'], { env: { NEEDS_JSON: ok } }).out, 'all jobs passed or were skipped\n');
  assert.equal(run(['gate'], { env: { NEEDS_JSON: JSON.stringify({ a: { result: 'failure' } }) } }).status, 1);
  assert.equal(run(['gate'], { env: {} }).status, 1);
});
