// @ts-check
// Core invariants 3, 5 and 6 against the evidence-only repair of a fix round (A325, `worker-evidence ID GREEN rerun`): the repair is a convenience for one narrow finding, never a way
// to produce an approval, a waiver or a gate pass, and never a way to close a finding that needs a tree change.
// Not yet mechanical (said here instead of faked): that the REVIEW_TESTS reviewer who judges the new durations is a different agent from the implementer is the lead's dispatch discipline plus
// role-bound commands; the script enforces the role boundary, which is what is tested.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { A, accepted, refused } from '../lib/harness.mjs';
import { count, ledger, must, reopened, rerun, warm } from '../core/evidence-repair-lib.mjs';

before(() => warm([[], [['SECURITY']], [['REVIEW_RULES']], [['VERIFY']]]));

test('evidence repair, invariants 3 and 5: the repair writes no approval, waiver or gate record; the implementer cannot pass or waive the gate it repaired, and CODE_DONE waits for the reviewer', () => {
  const d = reopened();
  const gates = count(d, 'gates');
  accepted(rerun(d), 'the repair');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED after the repair');
  assert.equal(count(d, 'gates'), gates, 'a gate record appeared');
  assert.equal(count(d, 'approvals'), 0, 'an approval appeared');
  assert.equal(count(d, 'waivers'), 0, 'a waiver appeared');
  assert.doesNotMatch(ledger(d), /event=(approve|waive|approval)/, 'the ledger holds an approval or a waiver row');
  refused(A(d, ['gate', 'LC', 'REVIEW_TESTS', 'pass'], { role: 'implementer' }), 'the implementer passed the repaired gate');
  refused(A(d, ['waive', 'LC', 'REVIEW_TESTS-1', '--reason', 'the durations were re-recorded by the control plane'], { role: 'implementer' }), 'the implementer waived the finding');
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE before the reviewer judged the new evidence', 'CODE_DONE blocked');
});

for (const also of [['SECURITY'], ['REVIEW_RULES'], ['VERIFY']]) {
  test(`evidence repair, invariant 6: in doubt the finding stays blocking: a failing ${also[0]} cannot be closed by the repair`, () => {
    const d = reopened(also);
    refused(rerun(d), `a repair beside a failing ${also[0]}`, 'has an open finding');
    assert.doesNotMatch(ledger(d), /event=evidence-repair/);
  });
}

test('evidence repair, invariant 6: in doubt the finding stays blocking: hand-recorded durations on an unchanged tree are no fix', () => {
  const d = reopened();
  must(d, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: 'command: node .git/er-run.mjs\ntarget: impl.txt,impl_test.txt\ntest_durations: slow one=5.5; fast one=0.75\n' });
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'an unchanged tree with hand-recorded durations', 'a fix must change the tree');
});
