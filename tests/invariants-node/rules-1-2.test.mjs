// @ts-check
// Core invariants 1 and 2 (CONTRIBUTING.md), the Node copy of tests/invariants/invariants-test.sh: each test really attempts the forbidden action against the
// real control plane (the Node core) in a throwaway project. A change to these files needs the same `Invariant-test-change:` statement as the shell copy.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A, IMPLEMENTED, accepted, gateStatus, pipe, project, refused, say, verbs, writeFileSync } from '../core/legacy-lib.mjs';

const CRITICAL = `scaffold orchestrated no CRITICAL; ${IMPLEMENTED}`;

// Rule 1: no CODE_DONE while a required gate has not passed for the current content, unless the user waived it.
test('inv1: CODE_DONE needs every required gate passed for the current content', () => {
  const d = project(CRITICAL);
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'inv1 CODE_DONE with no gate run', 'of LC is');
  accepted(verbs(d, 'for g in $(required); do [ "$g" != VERIFY ] || continue; if [ "$g" = SECRETS ]; then A secret-scan LC >/dev/null; else gpass "$g"; fi; done'), 'gates');
  accepted(verbs(d, 'for g in $(A pipeline LC | sed -n "s/^focus\\.\\([A-Z_]*\\)\\.\\([a-z]*\\)=.*/\\1 \\2/p" | tr " " ":"); do RF_FOCUS=${g#*:} gpass "${g%%:*}"; done'), 'focus gates');
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'inv1 CODE_DONE while VERIFY has not run', 'VERIFY');
  accepted(verbs(d, 'gpass VERIFY'), 'VERIFY');
  accepted(verbs(d, 'gfail REVIEW_RULES impl.txt'), 'blocking finding');
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'inv1 CODE_DONE over a blocking finding', 'REVIEW_RULES');
  accepted(verbs(d, 'gpass REVIEW_RULES'), 'rules passed again');
  writeFileSync(`${d}/impl.txt`, 'late edit\n', { flag: 'a' });
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'inv1 CODE_DONE after the tree changed since the passes');
});

// Rule 2a: SECRETS and SECURITY findings cannot be waived, not even with the user's approval sentence.
test('inv2a: a SECRETS or SECURITY finding is never waived, whoever asks', () => {
  const d = project("scaffold orchestrated no CRITICAL; worker RED fail impl_test.txt 'test: lookup'; worker GREEN pass impl.txt 'PLANTED_SECRET=abc'; A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null");
  assert.equal(gateStatus(d, 'SECRETS'), 'fail', 'the planted secret was not a FAIL');
  accepted(verbs(d, "rec SECURITY FAIL high 'SECURITY-1|blocking|impl.txt:1|injection reachable from input|traced: input -> eval'"), 'SECURITY finding');
  for (const f of ['SECRETS-1', 'SECURITY-1']) {
    refused(A(d, ['request-approval', 'LC', `waive:${f}`]), `a ${f} waiver approval was requested`, 'never waivable');
    say(d, `I approve the waiver of ${f}.`);
    refused(A(d, ['waive', 'LC', f, '--reason', 'the user accepts this risk for the release']), `${f} waived with the user's own sentence`, 'never waivable');
  }
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE over unwaivable findings');
});

// Rule 2b: SECRETS and SECURITY run again after any product-code change; a dependency or configuration change makes the run full tier.
test('inv2b: product code reruns SECRETS and SECURITY; dependency and config changes require both', () => {
  const failTests = "rec REVIEW_TESTS FAIL high 'REVIEW_TESTS-1|blocking|impl_test.txt:1|the test asserts nothing about the empty key|traced: empty key -> nil'; A handoff LC IMPLEMENTING >/dev/null";
  const d = project(`${CRITICAL}; pass_all; ${failTests}; worker FIX pass impl.txt 'impl: lookup of a missing key is nil'; A handoff LC IMPLEMENTED >/dev/null`);
  for (const g of ['SECRETS', 'SECURITY']) assert.notEqual(gateStatus(d, g), 'pass', `${g} carried over a product-code change`);
  const e = project(`${CRITICAL}; pass_all; ${failTests}; worker FIX pass impl_test.txt 'test: lookup of a missing key is nil'; A handoff LC IMPLEMENTED >/dev/null`);
  assert.notEqual(gateStatus(e, 'SECRETS'), 'pass', 'SECRETS carried over a test-only change');
  for (const f of ['package.json', 'main.tf']) {
    const g = project('scaffold standalone no STANDARD manual; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null');
    writeFileSync(`${g}/${f}`, '{}\n');
    assert.equal(A(g, ['tier', 'LC']).out.trim(), 'full', `a change to ${f} is not tier full`);
    const required = pipe(g, 'gates').split(/\s+/);
    assert.ok(required.includes('SECURITY') && required.includes('SECRETS'), `tier full for ${f} lacks SECURITY or SECRETS: ${required}`);
  }
});
