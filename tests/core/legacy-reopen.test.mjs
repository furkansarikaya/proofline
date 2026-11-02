// @ts-check
// Behaviour of lifecycle-test.sh scenario_reopen_approval_kinds (A152): a reopen approval names the run's own id and exists only for a FAILED or
// BLOCKED run; the user's reply is what lets `reopen` run (tests/legacy-port-map.tsv).
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
