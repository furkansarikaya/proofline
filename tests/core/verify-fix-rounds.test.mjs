// @ts-check
// A326 (A324.5): a verifier's own retry is not a fix round. VERIFY failed and then passed on the same content, with no implementer run, amendment or
// evidence-only repair in between, reports 0 fix rounds; a real fix, a failing review of unchanged content and the bound itself count as before.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { A, gfail, gpass, must, pipe, project, worker } from '../lib/harness.mjs';

const recipe = { topology: 'orchestrated', testCrit: 'AC-2', taskExtra: '- AC-2: second behavior' };
before(() => { project(recipe); });   // warm the shared template so no test pays for the first build
const mk = () => {
  const d = project(recipe);
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  return d;
};
/** @param {string} d */
const report = (d) => A(d, ['report-facts', 'LC']).out;

test('VERIFY failed then passed on the same content: no fix round in the pipe value or the completion report', () => {
  const d = mk();
  gfail(d, 'VERIFY', 'impl.txt');
  assert.equal(pipe(d, 'fix_round'), '1', 'a failing VERIFY with nothing after it is still a round');
  gpass(d, 'VERIFY');
  assert.equal(pipe(d, 'fix_round'), '0');
  assert.ok(report(d).includes('- Fix rounds: 0 of 2'), report(d));
});

test('a real fix between the failing and the passing VERIFY still counts', () => {
  const d = mk();
  gfail(d, 'VERIFY', 'impl.txt'); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: a fix after the failing VERIFY');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  gpass(d, 'VERIFY');
  assert.equal(pipe(d, 'fix_round'), '1', 'the fix changed the content: one round');
});

test('only VERIFY has the retry form: a review that failed and then passed on the same content is a round', () => {
  const e = mk();
  gfail(e, 'REVIEW_SMALL', 'impl.txt');
  gpass(e, 'REVIEW_SMALL');
  assert.equal(pipe(e, 'fix_round'), '1');
});

test('a verifier retry takes nothing from the budget: after it, one failing review is round 1 of 2', () => {
  const d = mk();
  gfail(d, 'VERIFY', 'impl.txt'); gpass(d, 'VERIFY');
  gfail(d, 'QA', 'impl.txt');
  assert.equal(pipe(d, 'fix_round'), '1');
  assert.ok(report(d).includes('- Fix rounds: 1 of 2'), report(d));
});
