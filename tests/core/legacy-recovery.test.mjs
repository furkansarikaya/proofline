// @ts-check
// Behaviour of lifecycle-test.sh scenario_tree_recovery and batch-test.sh sc_commands_check (without its batch-summary half) as absolute Node tests
// (tests/legacy-port-map.tsv): the user's approval of the inspected tree keeps the run and every gate runs again, no agent accepts it; the commands
// proposal is approved only by a reply newer than the request, bound to this proposal's hash, consumed on apply.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, IMPLEMENTED, accepted, approveAsUser, gateStatus, project, read, refused, say, verbs } from './legacy-lib.mjs';

test('tree recovery: the user\'s approval of the inspected tree keeps the run, every gate runs again, no agent accepts it', () => {
  const d = project(`scaffold orchestrated; ${IMPLEMENTED}; pass_all`);
  writeFileSync(`${d}/impl.txt`, 'a change from outside every window\n', { flag: 'a' });
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE over a change outside every window');
  const inspect = accepted(A(d, ['tree-inspect', 'LC']), 'tree-inspect').out;
  assert.ok(inspect.includes('attested tree') && inspect.includes('impl.txt'), `tree-inspect does not show the tree: ${inspect}`);
  refused(A(d, ['tree-accept', 'LC']), 'tree-accept without the user\'s approval', 'needs your approval');
  refused(A(d, ['tree-accept', 'LC'], { role: 'reviewer' }), 'a reviewer accepted the tree');
  refused(A(d, ['tree-accept', 'LC']), 'tree-accept ran on an approval of nothing');
  approveAsUser(d, 'tree', 'approve the tree');
  writeFileSync(`${d}/impl.txt`, 'one more late change\n', { flag: 'a' });
  refused(A(d, ['tree-accept', 'LC']), 'an approval of an older tree covered a newer one', 'needs your approval');
  approveAsUser(d, 'tree', 'I approve the tree.');
  accepted(A(d, ['tree-accept', 'LC']), 'tree-accept with the user\'s approval');
  assert.match(read(d, '.agents/runs/LC/RUN.yaml'), /^ {2}state: "IMPLEMENTING"$/m, 'the handoff did not go back to IMPLEMENTING');
  for (const g of A(d, ['pipeline', 'LC']).out.split('\n').filter((l) => l.startsWith('gate.'))) assert.ok(!/=pass/.test(g), `gate ${g} stayed green on the stale content after the tree was accepted`);
  refused(A(d, ['tree-accept', 'LC']), 'a second accept of the same tree');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED after the accepted tree');
  accepted(verbs(d, 'pass_all'), 'the gates run again');
  accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE after the gates ran again on the accepted tree');
  void gateStatus;
});

test('commands-check passes only on a commands approval bound to this proposal\'s hash, newer than the request, consumed on apply', () => {
  const d = project('scaffold standalone no COMPLEX manual');
  mkdirSync(`${d}/.agents/local/commands`, { recursive: true });
  const pf = `${d}/.agents/local/commands/PROPOSAL.tsv`;
  writeFileSync(pf, 'test\tnpm test\n');
  const notApproved = 'does not approve the commands';
  refused(A(d, ['commands-check']), 'commands-check without any approval', notApproved);
  assert.ok(accepted(A(d, ['request-approval', '-', 'commands']), 'request').out.includes('commands.test: npm test'), 'the request does not show the proposed commands');
  say(d, 'approve commands', { time: 1000 });
  A(d, ['approve-pending']);
  refused(A(d, ['commands-check']), 'a reply older than the request', notApproved);
  for (const t of ['looks good', 'do not approve commands']) { say(d, t); A(d, ['approve-pending']); refused(A(d, ['commands-check']), `commands-check on '${t}'`, notApproved); }
  say(d, 'approve commands'); A(d, ['approve-pending']);
  assert.ok(A(d, ['commands-check']).out.includes('approved by the user'), `approve commands: ${A(d, ['commands-check']).text}`);
  assert.ok(readdirSync(`${d}/.agents/local/approvals`).some((n) => n.endsWith('-commands.yaml') && !n.includes('request')), 'no approval of the kind commands was recorded');
  // a proposal changed after the approval has no approval bound to it
  copyFileSync(pf, `${d}/proposal.keep`);
  writeFileSync(pf, 'test\tnpm test\nlint\trm -rf x\n');
  refused(A(d, ['commands-check']), 'a forged proposal is not covered by the approval of another', notApproved);
  copyFileSync(`${d}/proposal.keep`, pf);
  assert.ok(A(d, ['commands-check']).out.includes('approved by the user'), 'the approved proposal is not accepted again before it is applied');
  writeFileSync(pf, '#proposed_at\t0\ntest\tnpm test\n');
  refused(A(d, ['commands-check']), 'a proposal that claims a time is another proposal', notApproved);
  copyFileSync(`${d}/proposal.keep`, pf);
  // applied once: the approval is consumed, so the same proposal replayed is refused until asked and answered again
  accepted(A(d, ['approval-consume', '-', 'commands']), 'the commands approval was not consumed');
  refused(A(d, ['commands-check']), 'a replayed proposal after the apply', notApproved);
});
