// @ts-check
// Behaviour of gates-test.sh sc_waiver_persists, sc_waiver_key_edges, sc_waiver_group as absolute Node tests (tests/legacy-port-map.tsv): a waiver
// follows its finding across gate re-runs and nothing else; a waiver without a resolvable line binds its record only; same-rule findings are one
// request, one approval and one `waive --group`.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { A, accepted, approveAsUser, buildState, copyOf, fixRound, gateStatus, gateStatusIn, implemented, must, read, refused, rec, say, stage, template, worker } from './legacy-lib.mjs';

/** The run at IMPLEMENTED, built once (scaffold, then the worker evidence) and copied per test. */
const base = () => copyOf(stage(template('scaffold orchestrated no STANDARD'), 'implemented', implemented));
const F = 'VERIFY-1|blocking|impl.txt:1|cache never invalidated on write|traced';
const G = 'VERIFY-2|blocking|impl.txt:1|an unrelated problem|traced';

test('a waiver follows the finding across gate re-runs; a new place or a changed finding asks again', () => {
  const d = base();
  rec(d, 'VERIFY', 'FAIL', F, G);
  approveAsUser(d, 'waive:VERIFY-1', 'approve VERIFY-1');
  accepted(A(d, ['waive', 'LC', 'VERIFY-1', '--reason', 'the user accepted the cache gap for this task']), 'waive');
  assert.equal(gateStatus(d, 'VERIFY'), 'fail', 'the second finding no longer blocks');
  rec(d, 'VERIFY', 'FAIL', F);
  assert.equal(gateStatusIn(d, 'VERIFY'), 'waived', 'a gate re-run on the same content asked for the waiver again');
  rec(d, 'VERIFY', 'FAIL', F, G);
  fixRound(d, 'impl: unrelated fix');
  rec(d, 'VERIFY', 'FAIL', F);
  assert.equal(gateStatusIn(d, 'VERIFY'), 'waived', 'a re-run on changed content (the cited line untouched) lost the waiver');
  rec(d, 'VERIFY', 'FAIL', 'VERIFY-1|blocking|impl.txt:2|cache never invalidated on write|traced');
  assert.equal(gateStatusIn(d, 'VERIFY'), 'fail', 'the same rule at a NEW place was waived');
  rec(d, 'VERIFY', 'FAIL', 'VERIFY-1|blocking|impl.txt:1|cache never invalidated on delete|traced');
  assert.equal(gateStatusIn(d, 'VERIFY'), 'fail', 'a changed finding kept the waiver');
});

test('a waiver without a resolvable line binds its record only; a backslash line keeps its copies apart', () => {
  const d = base();
  for (const loc of ['impl.txt', 'impl.txt:99']) {
    rec(d, 'VERIFY', 'FAIL', `VERIFY-1|blocking|${loc}|cache never invalidated on write|traced`);
    approveAsUser(d, 'waive:VERIFY-1', 'approve VERIFY-1');
    accepted(A(d, ['waive', 'LC', 'VERIFY-1', '--reason', 'the user accepted the cache gap for this task']), 'waive');
    assert.equal(gateStatus(d, 'VERIFY'), 'waived', `the waiver did not apply to its own record (${loc})`);
    rec(d, 'VERIFY', 'FAIL', `VERIFY-1|blocking|${loc}|cache never invalidated on write|traced`);
    assert.equal(gateStatusIn(d, 'VERIFY'), 'fail', `a waiver without a resolvable line covered a later record (${loc})`);
  }
  buildState(() => {   // copies of a line: the same line twice with another between
    must(d, ['handoff', 'LC', 'IMPLEMENTING']);
    for (const line of ['same\\nline', 'other', 'same\\nline']) worker(d, 'FIX', 'pass', 'impl.txt', line);
    must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  });
  const n2 = read(d, 'impl.txt').split('\n').length - 1; const n1 = n2 - 2;
  rec(d, 'VERIFY', 'FAIL', `VERIFY-1|blocking|impl.txt:${n2}|cache never invalidated on write|traced`);
  approveAsUser(d, 'waive:VERIFY-1', 'approve VERIFY-1');
  accepted(A(d, ['waive', 'LC', 'VERIFY-1', '--reason', 'the user accepted the second copy for this task']), 'waive the second copy');
  rec(d, 'VERIFY', 'FAIL', `VERIFY-1|blocking|impl.txt:${n2}|cache never invalidated on write|traced`);
  assert.equal(gateStatusIn(d, 'VERIFY'), 'waived', 'the waiver lost its own copy');
  rec(d, 'VERIFY', 'FAIL', `VERIFY-1|blocking|impl.txt:${n1}|cache never invalidated on write|traced`);
  assert.equal(gateStatusIn(d, 'VERIFY'), 'fail', 'a waiver for one copy of a line with a backslash covered the other');
});

test('same-rule findings are one request, one approval and one waive --group; another rule stays blocking', () => {
  const d = base();
  rec(d, 'VERIFY', 'FAIL', 'VERIFY-1|blocking|impl.txt:1|hard-coded spacing 13px on line 4|traced', 'VERIFY-2|blocking|impl.txt:1|hard-coded spacing 17px on line 9|traced', 'VERIFY-3|blocking|impl.txt:1|hard-coded spacing 21px on line 12|traced', 'VERIFY-4|blocking|impl.txt:1|focus ring removed|traced');
  const rq = accepted(A(d, ['request-approval', 'LC', 'waive:VERIFY-1']), 'request');
  assert.ok(rq.out.includes('covers 3 findings of the same rule'), 'the request did not present the 3 same-rule findings as one decision');
  say(d, 'I approve the waiver of VERIFY-1.');
  accepted(A(d, ['approve', 'LC', 'waive:VERIFY-1']), 'the waiver sentence');
  refused(A(d, ['waive', 'LC', 'VERIFY-1', '--group', '--reason', 'the user accepted the spacing rule for this task'], { role: 'reviewer' }), 'a group waiver by a reviewer', 'command denied');
  accepted(A(d, ['waive', 'LC', 'VERIFY-1', '--group', '--reason', 'the user accepted the spacing rule for this task']), 'group waiver');
  assert.equal(readdirSync(`${d}/.agents/runs/LC/waivers`).filter((n) => n.endsWith('.yaml')).length, 3, 'the group waiver did not write 3 waivers');
  assert.equal(gateStatus(d, 'VERIFY'), 'fail', 'the finding of another rule was waived with the group');
  refused(A(d, ['waive', 'LC', 'VERIFY-4', '--reason', 'the user accepted the focus ring for this task']), 'a second finding waived with the consumed approval', "needs the user's approval");
});
