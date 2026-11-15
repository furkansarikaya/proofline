// @ts-check
// A284: a change of the frozen plan's `## Test exceptions` at a refreeze is refused (A276) unless the USER approved it with a `scope` approval for the exact new PLAN.md, recorded
// from the prompt hook and consumed once. No agent can produce that approval (Core invariant 3). Real agent.sh; no waits, no clock reads.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, accepted, approveAsUser, project, refused, say, tsha } from '../lib/harness.mjs';

const PLAN = '\n## Tests\n\n- AC-1: `impl_test.txt` "retries after the delay" — it retries (test_kind: unit)\n\n## Test budgets\n\n- unit: test 100 ms; suite 1000 ms\n\n## Test exceptions\n\n- wait: `tests/sleepy.test.js` -- a real child process signal is awaited here, no clock can fake it\n';
const NEW = '- wait: `tests/other.test.js` -- a real child process signal is awaited here, nothing fakes it\n';
const MEASURE = '- measure: "slow one" -- the runner reports no duration for this test, checked by hand\n';
const REFUSAL = /adds or changes a line of PLAN\.md ## Test exceptions: that section justifies a real wait, a test over its budget or an unmeasured test and is frozen with the first plan; an amendment cannot change it \(awaiting the owner's decision whether the user may approve such a change\)\. Remove the change to the section/;
const RUN = '.agents/runs/LC';

const frozen = () => { const d = project({ topology: 'orchestrated', cls: 'STANDARD', autonomy: 'manual', planExtra: PLAN }); accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze'); return d; };
/** @param {string} d @param {string} n */
const amend = (d, n = '001.md') => { mkdirSync(path.join(d, RUN, 'amendments'), { recursive: true }); writeFileSync(path.join(d, RUN, 'amendments', n), `# amendment ${n}: test exceptions\n`); };
const refreeze = (/** @type {string} */ d, n = '001.md') => A(d, ['refreeze', 'LC', n], { bind: true });
const plan = (/** @type {string} */ d) => path.join(d, RUN, 'PLAN.md');
const ledger = (/** @type {string} */ d) => readFileSync(path.join(d, RUN, 'LEDGER.log'), 'utf8');
const approvals = (/** @type {string} */ d) => readdirSync(path.join(d, RUN, 'approvals')).filter((n) => /^\d{3}-scope\.yaml$/.test(n));
/** Adds a line to the end of the `## Test exceptions` section (the plan ends with other sections after it in some steps). @param {string} d @param {string} line */
const addLine = (d, line) => writeFileSync(plan(d), readFileSync(plan(d), 'utf8').replace(/(## Test exceptions\n[^]*?\n)(\n## |$)/, (_m, a, b) => `${a}${line}${b}`));
const approved = (/** @type {string} */ d) => approveAsUser(d, 'scope', 'approve scope');
/** The PLAN.md text without its `## Test exceptions` section. @param {string} t */
const withoutSection = (t) => t.replace(/\n## Test exceptions\n[^]*$/, '\n');

test('a: an unapproved change (add, edit, removal) at a refreeze is refused with the A276 message', () => {
  for (const edit of [(/** @type {string} */ t) => t + NEW, (/** @type {string} */ t) => t.replace('no clock', 'a clock'), withoutSection]) {
    const d = frozen(); amend(d);
    writeFileSync(plan(d), edit(readFileSync(plan(d), 'utf8')));
    const r = refreeze(d);
    refused(r, 'unapproved change', ''); assert.match(r.text, REFUSAL);
  }
});

test('b: a change approved by the user message is accepted, recorded with the approval, and consumed', () => {
  const d = frozen(); amend(d);
  appendFileSync(plan(d), NEW);
  approved(d);
  accepted(refreeze(d), 'approved change');
  assert.match(ledger(d), / event=test-exceptions [^\n]* detail=sha=[0-9a-f]{64} approval=\d{3}-scope\.yaml\n/);
  assert.match(readFileSync(path.join(d, RUN, 'approvals', approvals(d)[0]), 'utf8'), /consumed: "true"/);
  // the approved section is the new baseline: a later refreeze that leaves it alone needs no approval; a change again needs a new one
  amend(d, '002.md'); appendFileSync(plan(d), '\n## Risk\n\nperformance_critical: no\n');
  accepted(refreeze(d, '002.md'), 'a refreeze that leaves the approved section alone');
  amend(d, '003.md'); addLine(d, MEASURE);
  const r = refreeze(d, '003.md'); refused(r, 'second change without a new approval', ''); assert.match(r.text, REFUSAL);
});

test('e: removing the whole section is a change; with the user\'s approval it is accepted and the new baseline is empty', () => {
  const d = frozen(); amend(d);
  writeFileSync(plan(d), withoutSection(readFileSync(plan(d), 'utf8')));
  approved(d);
  accepted(refreeze(d), 'approved removal');
  assert.match(ledger(d), / event=test-exceptions [^\n]* detail=sha= approval=\d{3}-scope\.yaml\n/);
  amend(d, '002.md'); appendFileSync(plan(d), `\n## Test exceptions\n\n${NEW}`);
  const r = refreeze(d, '002.md'); refused(r, 'adding the section back', ''); assert.match(r.text, REFUSAL);
});

test('c: no agent role can request or record the approval; a hand-written file, a wrong kind and an approval of another content count for nothing', () => {
  const d = frozen(); amend(d);
  appendFileSync(plan(d), NEW);
  for (const role of ['implementer', 'reviewer', 'security_reviewer', 'qa', 'verifier', 'explorer']) {
    refused(A(d, ['request-approval', 'LC', 'scope'], { role }), `${role} requested`, '');
    say(d, 'I approve the scope');
    refused(A(d, ['approve', 'LC', 'scope'], { role }), `${role} approved`, '');
  }
  assert.deepEqual(readdirSync(path.join(d, RUN)).includes('approvals') ? approvals(d) : [], [], 'an agent role left an approval');
  // a file written by hand, with the right bound and answered_by user, is not in the ledger chain
  mkdirSync(path.join(d, RUN, 'approvals'), { recursive: true });
  writeFileSync(path.join(d, RUN, 'approvals/090-scope.yaml'), `kind: "scope"\nbound: "${tsha(plan(d))}"\nconsumed: "false"\nanswered_by: "user"\nsource: "prompt_capture"\n`);
  let r = refreeze(d); refused(r, 'hand-written approval', ''); assert.match(r.text, REFUSAL);
  // the user's approval of another kind does not cover it
  approveAsUser(d, 'budget', 'approve budget');
  r = refreeze(d); refused(r, 'budget approval', ''); assert.match(r.text, REFUSAL);
  // an approval given for the old content: the line changes after the approval
  approved(d);
  writeFileSync(plan(d), readFileSync(plan(d), 'utf8').replace('nothing fakes it', 'something else'));
  r = refreeze(d); refused(r, 'approval of the old content', ''); assert.match(r.text, REFUSAL);
});

test('d: the approval is bound to the exact new content and is used once; an approval from before the change does not cover it', () => {
  const d = frozen(); amend(d);
  // asked and approved before the change was written: bound to the old PLAN.md
  approved(d);
  appendFileSync(plan(d), NEW);
  let r = refreeze(d); refused(r, 'approval that predates the change', ''); assert.match(r.text, REFUSAL);
  // the approval is for exactly this content; once used it is gone
  approved(d);
  accepted(refreeze(d), 'approved');
  amend(d, '002.md'); addLine(d, MEASURE);
  r = refreeze(d, '002.md'); refused(r, 'consumed approval reused', ''); assert.match(r.text, REFUSAL);
  // an approval for another run id does not exist for this one: the run id is part of the approval path, a copy of a consumed file is not in the ledger
  const used = approvals(d)[0];
  writeFileSync(path.join(d, RUN, 'approvals/091-scope.yaml'), readFileSync(path.join(d, RUN, 'approvals', used), 'utf8').replace('consumed: "true"', 'consumed: "false"'));
  r = refreeze(d, '002.md'); refused(r, 'copied consumed approval', ''); assert.match(r.text, REFUSAL);
});
