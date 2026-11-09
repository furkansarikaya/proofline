// @ts-check
// Core invariant 5: the agent that wrote the change cannot review it. Core invariant 6: in doubt the safe side wins.
// Not yet mechanical (said here instead of faked): separation of an implementer from a reviewer SESSION (two agents with the same role name) is the lead's
// dispatch discipline plus role-bound commands; the script enforces the role boundary, which is what is tested.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { A, IMPLEMENTED, accepted, gateStatus, project, readdirSync, refused, verbs } from '../core/legacy-lib.mjs';

test('inv5: the implementer (and any non-owner role) cannot record a review or any gate', () => {
  const d = project(`scaffold orchestrated no CRITICAL; ${IMPLEMENTED}`);
  /** The result file is built and recorded in ONE shell session (the library removes its temporary folder when it ends). */
  const recordAs = (/** @type {string} */ role, /** @type {string} */ gate) => verbs(d, `f=$(result_for ${gate} PASS high); AS ${role} record LC --file "$f"`);
  const notRecorded = (/** @type {{ text: string, status: number | null }} */ r, /** @type {string} */ what) => {
    refused(r, what);
    assert.doesNotMatch(r.text, /result file not found/, `${what}: the result file did not exist, so nothing was tested`);
  };
  for (const g of ['REVIEW_PLAN', 'REVIEW_RULES', 'REVIEW_TESTS', 'SECURITY', 'QA', 'VERIFY']) {
    notRecorded(recordAs('implementer', g), `the implementer recorded ${g}`);
    notRecorded(recordAs('explorer', g), `an explorer recorded ${g}`);
  }
  refused(A(d, ['gate', 'LC', 'REVIEW_RULES', 'PASS'], { role: 'implementer' }), 'the implementer ran a gate command');
  refused(A(d, ['secret-scan', 'LC'], { role: 'implementer' }), 'the implementer ran secret-scan');
  refused(A(d, ['submit', 'LC', '--focus', 'rules+tests', '--confidence', 'high', '--findings', 'none', '--agent', 'self1'], { role: 'implementer' }), 'the implementer submitted a review');
  assert.deepEqual(existsSync(`${d}/.agents/runs/LC/gates`) ? readdirSync(`${d}/.agents/runs/LC/gates`).filter((n) => !n.includes('manifest')) : [], [], 'a rejected self-review left a gate record');
  notRecorded(recordAs('verifier', 'REVIEW_RULES'), 'a reviewer result recorded by the verifier');
  // control: the owner of the gate is accepted (the helper builds a valid result)
  accepted(recordAs('reviewer', 'REVIEW_RULES'), 'the reviewer could not record REVIEW_RULES');
});

test('inv6: low confidence, restated findings and unclear deltas do not pass a gate', () => {
  const d = project(`scaffold orchestrated no CRITICAL; ${IMPLEMENTED}`);
  accepted(verbs(d, 'rec REVIEW_RULES PASS low'), 'low-confidence PASS');
  assert.equal(gateStatus(d, 'REVIEW_RULES'), 'pass_low', 'a low-confidence PASS is not pass_low');
  accepted(verbs(d, "rec REVIEW_RULES FAIL high 'REVIEW_RULES-1|blocking|impl.txt:1|wrong default|traced: empty key -> nil; scan: grep -n lookup impl.txt; instances: single'"), 'blocking finding');
  refused(verbs(d, `rec REVIEW_RULES FAIL high 'REVIEW_RULES-1|info|impl.txt:1|wrong default|traced: empty key -> nil' 'REVIEW_RULES-2|blocking|impl.txt:3|new finding|traced: x; scan: grep -n lookup impl.txt; instances: single'`), 'a blocking finding became info', 'is info, and was blocking');
  // a pass after a test-only fix is carried only when the delta is provably tests: an undeterminable delta reruns the gate
  const e = project(`scaffold orchestrated no CRITICAL; ${IMPLEMENTED}; pass_all; rec REVIEW_TESTS FAIL high 'REVIEW_TESTS-1|blocking|impl_test.txt:1|the test asserts nothing about the empty key|traced: empty key -> nil'; A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl_test.txt 'test: lookup of a missing key is nil'; printf 'unplanned\\n' > stray.txt`);
  A(e, ['handoff', 'LC', 'IMPLEMENTED']);
  for (const g of ['REVIEW_RULES', 'SECURITY', 'SECRETS', 'VERIFY']) assert.notEqual(gateStatus(e, g), 'pass', `${g} was carried over a change it could not prove irrelevant`);
});
