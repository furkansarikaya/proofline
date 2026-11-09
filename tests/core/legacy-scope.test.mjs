// @ts-check
// Absolute Node port of the former enforcement-test.sh out_of_scope: a change outside the plan scope is blocked at verify-scope and at the IMPLEMENTED handoff.
// The refusal names the unexpected path and only that path (the in-scope test file the worker also changed is not named). Nothing is compared with a shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A, project, refused, verbs } from './legacy-lib.mjs';

test('out_of_scope: an out-of-scope change is blocked at verify-scope and handoff IMPLEMENTED', () => {
  const dir = project('scaffold orchestrated no COMPLEX ""');
  const w = verbs(dir, "wopen; printf 'outside the plan\\n' > other.txt; printf 'test\\n' >> impl_test.txt; wev RED fail; wclose");
  assert.equal(w.status, 0, w.text);
  const scope = A(dir, ['verify-scope', 'LC']);
  refused(scope, 'verify-scope', 'unexpected or unmapped task-introduced paths:\nother.txt\n');
  assert.ok(!scope.text.includes('impl_test.txt'), `the in-scope test file is named: ${scope.text}`);
  const handoff = A(dir, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(handoff, 'handoff IMPLEMENTED', 'unexpected or unmapped task-introduced paths:\nother.txt\n');
});
