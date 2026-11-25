// @ts-check
// A353 (issue 338 items B4 and C2): the read-set of a gate is derived and recorded by the control plane; a gate whose read-set is unchanged keeps its pass after a fix round, an amend or a reopen;
// SECURITY re-runs when product code changed; a forged or stale read-set re-runs the gate; a reopened run opens its fix round from the recorded findings; a re-review needs no code change.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, accepted, gateStatus, must, passAll, rec, refused, say, scaffold } from '../lib/harness.mjs';
import { worker2 } from './gates-s4-lib.mjs';

const RUN = '.agents/runs/LC';
const NOTES = 'REVIEW_TESTS-1|blocking|impl_test.txt:1|the test asserts nothing about the empty key|traced: empty key -> nil';
const RULES = 'REVIEW_RULES-1|blocking|impl.txt:1|lookup returns the wrong value for an empty key|traced: empty key -> nil; scan: grep -n lookup impl.txt; instances: single';

/** A CRITICAL run at IMPLEMENTED with every gate passed. */
function passed() {
  const d = scaffold({ cls: 'CRITICAL' });
  worker2(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker2(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  passAll(d);
  return d;
}
/** The newest gate record file of a gate. @param {string} d @param {string} g */
const recordOf = (d, g) => `${d}/${RUN}/gates/${readdirSync(`${d}/${RUN}/gates`).filter((n) => n.endsWith(`-${g}.yaml`)).sort().pop()}`;
const rsOf = (/** @type {string} */ d, /** @type {string} */ g) => readFileSync(recordOf(d, g).replace(/\.yaml$/, '.readset'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')[0]);
/** One fix round on one file: FIX evidence, then IMPLEMENTED. @param {string} d @param {string} f @param {string} line */
function fix(d, f, line) { worker2(d, 'FIX', 'pass', f, line); must(d, ['handoff', 'LC', 'IMPLEMENTED']); }

test('every record carries a read-set the control plane derived: reviewers of plan, rules and security do not read the tests, the others read the whole patch', () => {
  const d = passed();
  for (const g of ['REVIEW_PLAN', 'REVIEW_RULES', 'SECURITY']) {
    assert.match(readFileSync(recordOf(d, g), 'utf8'), /^readset_sha256: "[0-9a-f]{64}"$/m, `${g} record has no read-set hash`);
    assert.deepEqual(rsOf(d, g), ['impl.txt'], `${g} reads the product file only`);
  }
  for (const g of ['REVIEW_TESTS', 'QA', 'VERIFY']) assert.deepEqual(rsOf(d, g), ['impl.txt', 'impl_test.txt'], `${g} reads the whole patch`);
});

test('a test-only fix round keeps REVIEW_PLAN, REVIEW_RULES and SECURITY; product code re-runs SECURITY; SECRETS and REVIEW_TESTS always run', () => {
  let d = passed();
  rec(d, 'REVIEW_TESTS', 'FAIL', [NOTES]); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  fix(d, 'impl_test.txt', 'test: a missing key is nil');
  for (const g of ['REVIEW_PLAN', 'REVIEW_RULES', 'SECURITY']) assert.equal(gateStatus(d, g), 'pass', `${g} must survive a test-only change`);
  for (const g of ['SECRETS', 'REVIEW_TESTS', 'VERIFY']) assert.notEqual(gateStatus(d, g), 'pass', `${g} must run again`);
  d = passed();
  rec(d, 'REVIEW_TESTS', 'FAIL', [NOTES]); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  fix(d, 'impl.txt', 'impl: a missing key is nil');
  assert.notEqual(gateStatus(d, 'SECURITY'), 'pass', 'SECURITY must run after a product change');
  assert.notEqual(gateStatus(d, 'REVIEW_RULES'), 'pass');
});

test('forging: a record whose read-set file was edited, or claims the files of the new tree, does not keep its pass', () => {
  for (const variant of ['smaller', 'claims-new-tree']) {
    const d = passed();
    rec(d, 'REVIEW_TESTS', 'FAIL', [NOTES]); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
    fix(d, variant === 'smaller' ? 'impl_test.txt' : 'impl.txt', `change for ${variant}`);
    if (variant === 'smaller') assert.equal(gateStatus(d, 'SECURITY'), 'pass', 'fixture: a test-only change keeps SECURITY');
    // the agent rewrites the read-set of the SECURITY record: empty, or a hash of its own choosing for the product file
    writeFileSync(recordOf(d, 'SECURITY').replace(/\.yaml$/, '.readset'), variant === 'smaller' ? '' : 'impl.txt|forged\n');
    assert.notEqual(gateStatus(d, 'SECURITY'), 'pass', `${variant}: an edited read-set kept the pass`);
  }
});

test('an amend with a test-only fix keeps the unchanged gates', () => {
  const d = passed();
  accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE');
  accepted(A(d, ['amend', 'LC'], { input: 'reason: the user asked for one more test case\nfix_scope: impl_test.txt\nfix_instruction: add the test the user asked for, nothing else\nauthorized_by: the user\n' }), 'amend');
  fix(d, 'impl_test.txt', 'test: one more case');
  for (const g of ['REVIEW_PLAN', 'REVIEW_RULES', 'SECURITY']) assert.equal(gateStatus(d, g), 'pass', `${g} after the amend`);
});

/** A run whose REVIEW_TESTS failed in 3 rounds, terminated FAILED and reopened with the user's approval. */
function reopened() {
  const d = passed();
  for (const l of ['a', 'b']) { rec(d, 'REVIEW_TESTS', 'FAIL', [NOTES]); must(d, ['handoff', 'LC', 'IMPLEMENTING']); fix(d, 'impl_test.txt', `test: ${l}`); }
  rec(d, 'REVIEW_TESTS', 'FAIL', [NOTES]);
  must(d, ['terminate', 'LC', 'FAILED'], { input: 'reason: out of rounds for this test\nevidence: gates/*-REVIEW_TESTS.yaml\n' });
  must(d, ['request-approval', 'LC', 'reopen:LC']);
  say(d, 'I approve the reopen of LC'); must(d, ['approve', 'LC', 'reopen:LC']);
  must(d, ['reopen', 'LC'], { input: 'reason: the user gave a new instruction for the tests\n' });
  return d;
}

test('a reopened run opens its fix round from the recorded findings, keeps the gates that passed, and needs no gate dispatched to say the content is unchanged', () => {
  const d = reopened();
  assert.equal(gateStatus(d, 'REVIEW_PLAN'), 'pass'); assert.equal(gateStatus(d, 'SECURITY'), 'pass');
  assert.notEqual(gateStatus(d, 'REVIEW_TESTS'), 'pass');
  assert.match(A(d, ['next', 'LC']).out, /note=reopened run \(A353\).*handoff LC IMPLEMENTING/);
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'the fix round of a reopened run');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED without a change', 'must change the tree');
  fix(d, 'impl_test.txt', 'test: the new instruction');
  for (const g of ['REVIEW_PLAN', 'REVIEW_RULES', 'SECURITY']) assert.equal(gateStatus(d, g), 'pass', `${g} survives the test-only fix of a reopened run`);
  assert.notEqual(gateStatus(d, 'REVIEW_TESTS'), 'pass');
});

test('a finding of another content is not a recorded finding: a reopened run whose tree drifted needs its gates again', () => {
  const d = reopened();
  writeFileSync(`${d}/impl_test.txt`, `${readFileSync(`${d}/impl_test.txt`, 'utf8')}drift\n`);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'a finding on other content', 'no open gate finding');
});

test('a re-review needs no code change: once per finding, with a reason, on the unchanged tree only', () => {
  const d = passed();
  rec(d, 'REVIEW_RULES', 'FAIL', [RULES]);
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED on the same tree', 'must change the tree');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED', '--re-review'], { input: 'reason: short\n' }), 're-review with a thin reason', 'reason');
  refused(A(d, ['handoff', 'LC', 'CODE_DONE', '--re-review']), '--re-review on another phase', 'IMPLEMENTED only');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED', '--re-review'], { input: 'reason: the finding cites a line the plan declares out of scope\n' }), 're-review');
  assert.equal(gateStatus(d, 'REVIEW_RULES'), 'fail', 'the finding stays until a reviewer says otherwise');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED', '--re-review'], { input: 'reason: a second look at the very same finding please\n' }), 'a second re-review of one finding', 'already used');
});
