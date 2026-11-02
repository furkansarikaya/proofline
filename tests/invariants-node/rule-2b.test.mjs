// @ts-check
// Core invariants 1 and 2 (CONTRIBUTING.md), the Node copy of tests/invariants/invariants-test.sh: each test really attempts the forbidden action against the
// real control plane (the Node core) in a throwaway project. A change to these files needs the same `Invariant-test-change:` statement as the shell copy.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A, IMPLEMENTED, accepted, gateStatus, pipe, project, refused, say, verbs, writeFileSync } from '../core/legacy-lib.mjs';

const CRITICAL = `scaffold orchestrated no CRITICAL; ${IMPLEMENTED}`;

// Rule 2b: SECRETS and SECURITY run again after any product-code change; a dependency or configuration change makes the run full tier.
test('inv2b: product code reruns SECRETS and SECURITY; dependency and config changes require both', () => {
  const failTests = "rec REVIEW_TESTS FAIL high 'REVIEW_TESTS-1|blocking|impl_test.txt:1|the test asserts nothing about the empty key|traced: empty key -> nil'; A handoff LC IMPLEMENTING >/dev/null";
  // one recipe for the common state (the expensive part), then each case adds its own fix on a copy
  const common = `${CRITICAL}; pass_all; ${failTests}`;
  const d = project(common);
  accepted(verbs(d, "worker FIX pass impl.txt 'impl: lookup of a missing key is nil'; A handoff LC IMPLEMENTED >/dev/null"), 'a product-code fix');
  for (const g of ['SECRETS', 'SECURITY']) assert.notEqual(gateStatus(d, g), 'pass', `${g} carried over a product-code change`);
  const e = project(common);
  accepted(verbs(e, "worker FIX pass impl_test.txt 'test: lookup of a missing key is nil'; A handoff LC IMPLEMENTED >/dev/null"), 'a test-only fix');
  assert.notEqual(gateStatus(e, 'SECRETS'), 'pass', 'SECRETS carried over a test-only change');
  for (const f of ['package.json', 'main.tf']) {
    const g = project('scaffold standalone no STANDARD manual; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null');
    writeFileSync(`${g}/${f}`, '{}\n');
    assert.equal(A(g, ['tier', 'LC']).out.trim(), 'full', `a change to ${f} is not tier full`);
    const required = pipe(g, 'gates').split(/\s+/);
    assert.ok(required.includes('SECURITY') && required.includes('SECRETS'), `tier full for ${f} lacks SECURITY or SECRETS: ${required}`);
  }
});
