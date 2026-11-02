// @ts-check
// Behaviour of lifecycle-test.sh scenario_reopen_approval_kinds (A152): a reopen approval names the run's own id and exists only for a FAILED or
// BLOCKED run; the user's reply is what lets `reopen` run (tests/legacy-port-map.tsv).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, accepted, project, refused, say, waitUntil } from './legacy-lib.mjs';

const FAILED_RUN = `export SC_TEST_CRIT=AC-2 SC_TASK_EXTRA='- AC-2: second behavior'; scaffold orchestrated; unset SC_TEST_CRIT SC_TASK_EXTRA;
worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value';
A handoff LC IMPLEMENTED >/dev/null; gfail REVIEW_SMALL impl_test.txt; A handoff LC IMPLEMENTING >/dev/null;
worker FIX pass impl_test.txt 'test: default for an empty key'; A handoff LC IMPLEMENTED >/dev/null; gfail QA impl.txt; A handoff LC IMPLEMENTING >/dev/null;
worker FIX pass impl.txt 'impl: second attempt'; A handoff LC IMPLEMENTED >/dev/null; gpass REVIEW_SMALL; gpass QA; gfail VERIFY impl.txt;
printf 'reason: the empty-key contract cannot be met within the frozen plan scope\\nevidence: gates/*-VERIFY.yaml fail on the third content\\n' | A terminate LC FAILED >/dev/null`;
const reason = 'reason: the budget decision was made and the verifier false alarm is fixed\n';

test('reopen approval: own id only, FAILED or BLOCKED runs only', () => {
  const d = project(FAILED_RUN);
  refused(A(d, ['request-approval', 'LC', 'reopen:OTHER']), 'a reopen approval for another run', 'names another run');
  accepted(A(d, ['request-approval', 'LC', 'reopen:LC']), 'the reopen approval for a FAILED run');
  say(d, 'I approve the reopen of OTHER');
  refused(A(d, ['approve', 'LC', 'reopen:OTHER']), 'an approval for another run id');
  say(d, 'I approve the reopen of LC');
  accepted(A(d, ['approve', 'LC', 'reopen:LC']), 'the reopen approval');
  waitUntil(Math.floor(Date.now() / 1000));
  accepted(A(d, ['reopen', 'LC'], { input: reason }), 'reopen');
  refused(A(d, ['request-approval', 'LC', 'reopen:LC']), 'a reopen approval on a run that is no longer terminal', 'FAILED or BLOCKED run');
});

const JOINT_RUN = `SC_PLAN_EXTRA=$(printf '\\n## Tests\\n\\n- AC-1: \`impl.txt\` "one"\\n- AC-2: \`impl_test.txt\` "two"\\n'); export SC_PLAN_EXTRA; ${FAILED_RUN}; unset SC_PLAN_EXTRA;
sed -i.bak 's/^  mutation_budget: .*/  mutation_budget: 1/' .agents/config.yaml; rm -f .agents/config.yaml.bak`;

test('reopen: one joint question, one reply records both approvals, then reopen applies budget and reopen', () => {
  const d = project(JOINT_RUN);
  const requests = () => readdirSync(`${d}/.agents/runs/LC/approvals`).filter((n) => n.includes('-request-'));
  const first = A(d, ['reopen', 'LC'], { input: reason });
  refused(first, 'reopen ran without any answer');
  assert.ok(first.text.includes('Raise the budget to 2 and reopen the run LC?'), `no joint question: ${first.text}`);
  assert.equal((first.text.match(/REOPEN SUMMARY/g) ?? []).length, 1, 'more than one summary');
  assert.equal(requests().length, 2, 'expected exactly the two joint requests');
  refused(A(d, ['reopen', 'LC'], { input: reason }), 'second run without an answer applied');
  assert.equal(requests().length, 2, 'a repeated reopen wrote more requests');
  refused(A(d, ['approve', 'LC', 'reopen:LC']), 'a model approved the joint question');
  say(d, 'approve mutation budget');
  refused(A(d, ['approve', 'LC', 'mutation_budget']), 'budget words alone approved the joint budget request');
  refused(A(d, ['approve', 'LC', 'reopen:LC']), 'budget words alone approved the joint reopen request');
  assert.deepEqual(readdirSync(`${d}/.agents/runs/LC/approvals`).filter((n) => !n.includes('-request-')), [], 'a budget-only reply approved something');
  say(d, 'I approve the reopen of LC');
  accepted(A(d, ['approve', 'LC', 'mutation_budget']), 'the one reply did not approve the budget');
  accepted(A(d, ['approve', 'LC', 'reopen:LC']), 'the one reply did not approve the reopen');
  accepted(A(d, ['reopen', 'LC'], { input: reason }), 'reopen refused after the joint reply');
  assert.equal(readFileSync(`${d}/.agents/runs/LC/mutation_budget`, 'utf8').trim(), '2', 'the budget was not raised');
  assert.match(readFileSync(`${d}/.agents/runs/LC/RUN.yaml`, 'utf8'), /^ {2}state: "PLANNING"$/m);
});
