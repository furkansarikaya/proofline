// @ts-check
// Behaviour of the legacy shell scenarios gates-test.sh sc_provenance, sc_waiver_rebind, sc_destructive_refreeze, sc_supervised_destructive (see
// tests/legacy-port-map.tsv): hand-written records count for nothing, a waiver approval binds the failing gate record, a refreeze of a destructive
// plan returns to PLANNED until the new hash is approved, a destructive plan needs its approvals in order.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { A, IMPLEMENTED, accepted, gateStatus, project, read, refused, say, verbs } from './legacy-lib.mjs';

const sha = (/** @type {string} */ f) => createHash('sha256').update(readFileSync(f)).digest('hex');
/** The value of a RUN.yaml key. @param {string} d @param {string} section @param {string} key */
function rv(d, section, key) {
  let inside = false;
  for (const l of read(d, '.agents/runs/LC/RUN.yaml').split('\n')) {
    if (l === `${section}:`) { inside = true; continue; }
    if (inside && /^[^ #]/.test(l)) inside = false;
    const m = inside ? new RegExp(`^  ${key}:[ \\t]*(.*)$`).exec(l) : null;
    if (m) return m[1].replace(/"/g, '');
  }
  return '';
}
/** The user's reply to a request, as the runtime records it: request, the message, approve. @param {string} d @param {string} kind @param {string} text */
function approveAsUser(d, kind, text) {
  accepted(A(d, ['request-approval', 'LC', kind]), `request ${kind}`);
  say(d, text);
  accepted(A(d, ['approve', 'LC', kind]), `approve ${kind}`);
}
/** `A freeze|refreeze` of the self-test library: the QA plan cites the sha256 of the current PLAN.md first. @param {string} d @param {...string} args */
const qa = (d, ...args) => verbs(d, `A ${args.join(' ')}`);
const DEST_DATA = '\n## Data\n\ndestructive: yes\n\n| step | phase | operation | object | destructive | reversible | rollback | lock |\n|---|---|---|---|---|---|---|---|\n| S1 | expand | switch_reads | books.legacy_notes | no | yes | redeploy the previous release | none |\n| S2 | deferred | drop_column | books.legacy_notes | yes | no | restore from the backup | table rewrite |\n';
/** @param {string} d @param {string} n @param {string} text */
function amendPlan(d, n, text) {
  mkdirSync(`${d}/.agents/runs/LC/amendments`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/LC/amendments/${n}.md`, `# amendment ${n}: destructive migration added to the plan\n`);
  writeFileSync(`${d}/.agents/runs/LC/PLAN.md`, `${text}\n`, { flag: 'a' });
}

test('provenance: hand-written gate records, waivers (SECURITY included) and approvals are ignored; validate names them', () => {
  const d = project(`scaffold orchestrated no CRITICAL; ${IMPLEMENTED}; for g in $(required); do case $g in SECRETS) A secret-scan LC >/dev/null ;; SECURITY|REVIEW_RULES) gfail "$g" impl.txt ;; *) gpass "$g" ;; esac; done`);
  const gd = `${d}/.agents/runs/LC/gates`; const wd = `${d}/.agents/runs/LC/waivers`;
  mkdirSync(wd, { recursive: true });
  const last = (/** @type {string} */ suffix) => readdirSync(gd).filter((n) => n.endsWith(suffix)).sort().pop() ?? '';
  const sr = last('SECURITY.yaml'); const rr = last('REVIEW_RULES.yaml');
  writeFileSync(`${wd}/001-SECURITY-1.yaml`, `finding: "SECURITY-1"\ngate_record: "${sr}"\ngate_record_sha256: "${sha(`${gd}/${sr}`)}"\n`);
  writeFileSync(`${wd}/002-REVIEW_RULES-1.yaml`, `finding: "REVIEW_RULES-1"\ngate_record: "${rr}"\ngate_record_sha256: "${sha(`${gd}/${rr}`)}"\n`);
  assert.equal(gateStatus(d, 'SECURITY'), 'fail', 'a hand-written SECURITY waiver counted');
  assert.equal(gateStatus(d, 'REVIEW_RULES'), 'fail', 'a hand-written waiver counted');
  const v = last('VERIFY.yaml');
  writeFileSync(`${gd}/090-SECURITY.yaml`, readFileSync(`${gd}/${v}`, 'utf8').replace(/^gate: .*/m, 'gate: "SECURITY"').replace(/^role: .*/m, 'role: "security_reviewer"').replace(/^seq: .*/m, 'seq: 90'));
  writeFileSync(`${gd}/090-SECURITY.manifest`, readFileSync(`${gd}/${v.replace(/\.yaml$/, '.manifest')}`));
  assert.equal(gateStatus(d, 'SECURITY'), 'fail', 'a hand-written PASS record counted');
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE over hand-written records', 'is fail for the current content');
  refused(A(d, ['validate', 'LC']), 'validate missed the hand-written records', 'gates/090-SECURITY.yaml');
  mkdirSync(`${d}/.agents/runs/LC/approvals`, { recursive: true });
  const fp = A(d, ['fingerprint', 'LC']).out.trim();
  writeFileSync(`${d}/.agents/runs/LC/approvals/050-commit.yaml`, `kind: "commit"\nbound: "${fp}"\nconsumed: "false"\n`);
  refused(A(d, ['approval-consume', 'LC', 'commit', fp]), 'a hand-written commit approval was consumed');
});

test('waiver approvals bind the failing gate record and finding; a later round never reuses them', () => {
  const d = project(`scaffold orchestrated no STANDARD; ${IMPLEMENTED}; rec VERIFY FAIL high 'VERIFY-1|blocking|impl.txt:1|first problem: cache never invalidated|traced'`);
  approveAsUser(d, 'waive:VERIFY-1', 'approve VERIFY-1');
  const appr = readdirSync(`${d}/.agents/runs/LC/approvals`).filter((n) => /-waive-VERIFY-1\.yaml$/.test(n) && !n.includes('request'));
  assert.match(read(d, `.agents/runs/LC/approvals/${appr[0]}`), /^bound: "[0-9]*-VERIFY\.yaml@[0-9a-f]*#VERIFY-1"$/m, 'the waiver approval is not bound to the gate record');
  accepted(verbs(d, "A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl.txt 'impl: fix attempt'; A handoff LC IMPLEMENTED >/dev/null; rec VERIFY FAIL high 'VERIFY-1|blocking|impl.txt:2|different problem: data loss on concurrent write|traced'"), 'round 2');
  refused(A(d, ['waive', 'LC', 'VERIFY-1', '--reason', 'the user approved waiving VERIFY-1 earlier on']), 'a round-1 approval waived round 2\'s VERIFY-1', "needs the user's approval");
});

for (const from of ['IMPLEMENTING', 'IMPLEMENTED']) {
  test(`a refreeze of a destructive plan from ${from} returns to PLANNED until the new hash is approved`, () => {
    const d = project(`scaffold orchestrated${from === 'IMPLEMENTED' ? `; ${IMPLEMENTED}` : ''}`);
    amendPlan(d, '001', DEST_DATA);
    assert.match(qa(d, 'refreeze', 'LC', '001.md').text, /back at PLANNED/, 'the refreeze does not say the run is back at PLANNED');
    assert.equal(rv(d, 'handoff', 'state'), 'PLANNED'); assert.equal(rv(d, 'pipeline', 'classification'), 'CRITICAL');
    refused(A(d, ['window-open', 'LC']), 'window-open without the destructive approval', 'destructive approval');
    refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED without the destructive approval', 'illegal handoff transition');
    refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING without the destructive approval', 'agent.sh request-approval LC destructive');
    const next = A(d, ['next', 'LC']).out;
    assert.match(next, /^next=agent\.sh request-approval LC destructive/m); assert.match(next, /^reason=destructive approval required before IMPLEMENT/m);
    approveAsUser(d, 'destructive', 'approve the destructive migration');
    accepted(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING with the approval for the new hash');
    accepted(verbs(d, 'wopen; wclose'), 'a window');
    // the approval was consumed and is bound to this hash: a second plan change asks again
    amendPlan(d, '002', 'amended again: second plan change');
    accepted(qa(d, 'refreeze', 'LC', '002.md'), 'second refreeze');
    assert.equal(rv(d, 'handoff', 'state'), 'PLANNED');
    refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'a consumed approval reused for another hash', 'agent.sh request-approval LC destructive');
    refused(A(d, ['window-open', 'LC']), 'window-open on a consumed approval', 'destructive approval');
  });
}

test('a fix-round reopen keeps the hash; a TASK.md-only refreeze stays; a refreeze to non-destructive needs no approval', () => {
  const d = project('scaffold orchestrated');
  amendPlan(d, '001', DEST_DATA);
  accepted(qa(d, 'refreeze', 'LC', '001.md'), 'refreeze');
  approveAsUser(d, 'destructive', 'approve the destructive migration');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING');
  accepted(verbs(d, "worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'; A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null; gfail REVIEW_RULES impl.txt"), 'a failing round');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'the fix-round reopen asked for a new destructive approval');
  assert.equal(rv(d, 'handoff', 'state'), 'IMPLEMENTING');
  accepted(verbs(d, 'wopen; wclose'), 'a window');
  // TASK.md only: the PLAN.md hash is unchanged, the approval still binds it
  const e = project('scaffold orchestrated');
  amendPlan(e, '001', DEST_DATA);
  accepted(qa(e, 'refreeze', 'LC', '001.md'), 'refreeze');
  approveAsUser(e, 'destructive', 'approve the destructive migration');
  accepted(A(e, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING');
  mkdirSync(`${e}/.agents/runs/LC/amendments`, { recursive: true });
  writeFileSync(`${e}/.agents/runs/LC/amendments/002.md`, '# amendment 002: clarify the task wording only\n');
  writeFileSync(`${e}/.agents/runs/LC/TASK.md`, '\n- AC-1 clarified: an empty key returns the documented default\n', { flag: 'a' });
  accepted(qa(e, 'refreeze', 'LC', '002.md'), 'TASK.md-only refreeze');
  assert.equal(rv(e, 'handoff', 'state'), 'IMPLEMENTING');
  accepted(verbs(e, 'wopen; wclose'), 'a window');
  // from destructive to non-destructive: no destructive approval needed
  writeFileSync(`${e}/.agents/runs/LC/amendments/003.md`, '# amendment 003: the migration is dropped from this change\n');
  const plan = read(e, '.agents/runs/LC/PLAN.md').split('\n').filter((l) => !/^\| S[0-9] \|/.test(l) && !/^\| step \|/.test(l) && !/^\|---/.test(l)).map((l) => (l === 'destructive: yes' ? 'destructive: no' : l)).join('\n');
  writeFileSync(`${e}/.agents/runs/LC/PLAN.md`, plan);
  accepted(qa(e, 'refreeze', 'LC', '003.md'), 'refreeze to non-destructive');
  assert.equal(rv(e, 'handoff', 'state'), 'IMPLEMENTING');
  accepted(verbs(e, 'wopen; wclose'), 'a window');
});

test('supervised freeze needs a plan approval bound to PLAN.md', () => {
  const d = project('scaffold standalone no COMPLEX manual');
  refused(qa(d, 'freeze', 'LC'), 'supervised freeze without plan approval', 'plan approval');
  assert.match(A(d, ['next', 'LC']).out, /^next=agent\.sh request-approval LC plan/m);
  approveAsUser(d, 'plan', 'approve the plan');
  writeFileSync(`${d}/.agents/runs/LC/PLAN.md`, 'edited after approval\n', { flag: 'a' });
  refused(qa(d, 'freeze', 'LC'), 'an approval for an older PLAN.md', 'plan approval');
  approveAsUser(d, 'plan', 'approve the plan please');
  accepted(qa(d, 'freeze', 'LC'), 'freeze');
});
