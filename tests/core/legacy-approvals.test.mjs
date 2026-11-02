// @ts-check
// Behaviour of the legacy shell scenarios gates-test.sh sc_approvals, sc_capture_integrity, sc_waiver (see tests/legacy-port-map.tsv), as absolute
// Node tests against the real control plane: request, capture freshness / phrase / hash, single use, commit binding, no-run push, captures and
// approval files that must be regular single-link files on a symlink-free path, waivers that need the user's sentence naming the finding.
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, accepted, gateStatus, project, read, refused, say, verbs } from './legacy-lib.mjs';

const UNFROZEN = 'scaffold standalone no COMPLEX manual';
const now = () => Math.floor(Date.now() / 1000);
const approvalsOf = (/** @type {string} */ d, /** @type {RegExp} */ re) => readdirSync(`${d}/.agents/runs/LC/approvals`).filter((n) => re.test(n));

test('approvals: request, capture freshness/phrase/hash, single use, commit binding, no-run push', () => {
  const d = project(UNFROZEN);
  refused(A(d, ['approve', 'LC', 'plan']), 'approve without a request', 'no approval request');
  assert.match(accepted(A(d, ['request-approval', 'LC', 'plan']), 'request').out, /^QUESTIONS:/m);
  refused(A(d, ['approve', 'LC', 'plan']), 'approve without a terminal or a capture', 'no user prompt capture');
  say(d, 'approve the plan', { time: now() - 100 });
  refused(A(d, ['approve', 'LC', 'plan']), 'a stale capture was accepted', 'stale capture');
  say(d, 'looks fine to me');
  refused(A(d, ['approve', 'LC', 'plan']), 'a capture without an approval phrase', 'no approval phrase');
  say(d, 'approve the plan');
  writeFileSync(`${d}/.agents/local/prompts/s1.json`, readFileSync(`${d}/.agents/local/prompts/s1.json`, 'utf8').replace(/"sha256":"[0-9a-f]*"/, '"sha256":"00"'));
  refused(A(d, ['approve', 'LC', 'plan']), 'a capture with a wrong sha256', 'sha256 does not match');
  // the capture is dated a few seconds ahead (the most the control plane tolerates) so the request made next is older than it
  const t = now() + 4;
  say(d, 'Approve the PLAN, onaylıyorum', { time: t });
  accepted(A(d, ['approve', 'LC', 'plan']), 'the approval');
  refused(A(d, ['approve', 'LC', 'plan']), 'one request approved twice', 'already approved');
  accepted(A(d, ['request-approval', 'LC', 'plan']), 'second request');
  refused(A(d, ['approve', 'LC', 'plan']), 'a prompt reused for a second approval', 'single-use');
  assert.match(read(d, '.agents/runs/LC/approvals/002-plan.yaml'), /^answered_by: "user"$/m);
  // commit approvals bind the content fingerprint and are consumed once
  accepted(verbs(d, 'A freeze LC >/dev/null'), 'freeze');
  assert.match(read(d, '.agents/runs/LC/approvals/002-plan.yaml'), /^consumed: "true"$/m, 'freeze did not consume the plan approval');
  accepted(A(d, ['request-approval', 'LC', 'commit']), 'commit request');
  say(d, 'commit it');
  accepted(A(d, ['approve', 'LC', 'commit']), 'commit approval');
  refused(A(d, ['approval-consume', 'LC', 'commit', '0123456789abcdef0123456789abcdef01234567']), 'approval-consume with another fingerprint');
  const fp = A(d, ['fingerprint', 'LC']).out.trim();
  accepted(A(d, ['approval-consume', 'LC', 'commit', fp]), 'consume');
  refused(A(d, ['approval-consume', 'LC', 'commit', fp]), 'a commit approval consumed twice');
  // outside a run: push approvals in .agents/local
  accepted(A(d, ['request-approval', '-', 'push']), 'push request');
  say(d, 'push it');
  accepted(A(d, ['approve', '-', 'push']), 'push approval');
  accepted(A(d, ['approval-consume', '-', 'push']), 'push consume');
  refused(A(d, ['request-approval', '-', 'plan']), 'a no-run plan approval');
});

test('captures and approvals must be regular single-link files on a symlink-free path', () => {
  const d = project(UNFROZEN);
  accepted(A(d, ['request-approval', 'LC', 'plan']), 'request');
  say(d, 'approve the plan');
  const prompts = `${d}/.agents/local/prompts`;
  const cap = `${prompts}/s1.json`;
  const away = `${d}/.agents/local/away`;
  mkdirSync(away, { recursive: true });
  renameSync(cap, `${away}/real.json`); symlinkSync(`${away}/real.json`, cap);
  refused(A(d, ['approve', 'LC', 'plan']), 'a symlinked capture was accepted', 'single-link');
  rmSync(cap); renameSync(`${away}/real.json`, cap); linkSync(cap, `${away}/hard.json`);
  refused(A(d, ['approve', 'LC', 'plan']), 'a hard-linked capture was accepted', 'single-link');
  rmSync(`${away}/hard.json`);
  renameSync(prompts, `${away}/prompts`); symlinkSync(`${away}/prompts`, prompts);
  refused(A(d, ['approve', 'LC', 'plan']), 'a capture under a symlinked prompts directory was accepted', 'single-link');
  rmSync(prompts); renameSync(`${away}/prompts`, prompts);
  accepted(A(d, ['approve', 'LC', 'plan']), 'the intact capture');
  accepted(verbs(d, 'A freeze LC >/dev/null'), 'freeze');
  // approval files: a symlinked or hard-linked approval is never consumed
  accepted(A(d, ['request-approval', 'LC', 'commit']), 'commit request');
  say(d, 'commit it');
  accepted(A(d, ['approve', 'LC', 'commit']), 'commit approval');
  const file = `${d}/.agents/runs/LC/approvals/${approvalsOf(d, /-commit\.yaml$/).filter((n) => !n.includes('request'))[0]}`;
  const fp = A(d, ['fingerprint', 'LC']).out.trim();
  renameSync(file, `${away}/appr.yaml`); symlinkSync(`${away}/appr.yaml`, file);
  refused(A(d, ['approval-consume', 'LC', 'commit', fp]), 'a symlinked approval file was consumed');
  rmSync(file); writeFileSync(file, readFileSync(`${away}/appr.yaml`)); linkSync(file, `${away}/appr-hard.yaml`);
  refused(A(d, ['approval-consume', 'LC', 'commit', fp]), 'a hard-linked approval file was consumed');
  rmSync(`${away}/appr-hard.yaml`);
  accepted(A(d, ['approval-consume', 'LC', 'commit', fp]), 'the intact approval');
});

test('waivers: approval naming the finding, lead only', () => {
  const d = project(`scaffold orchestrated; worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'; A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null; gfail REVIEW_SMALL impl.txt; gpass QA; gpass VERIFY`);
  const reason = 'accepted risk: the default is documented upstream';
  refused(A(d, ['waive', 'LC', 'REVIEW_SMALL-1', '--reason', reason]), 'a waiver without approval', 'needs the user');
  refused(A(d, ['waive', 'LC', 'REVIEW_SMALL-1']), 'a waiver without a reason', 'reason');
  accepted(A(d, ['request-approval', 'LC', 'waive:REVIEW_SMALL-1']), 'request');
  say(d, 'approved, go ahead');
  refused(A(d, ['approve', 'LC', 'waive:REVIEW_SMALL-1']), 'an approval text not naming the finding', 'no approval phrase');
  // A134: the full sentence names the finding; a bare 'the waiver', another id or another kind's object is ambiguous
  for (const t of ['I approve the waiver', 'I approve the waiver of REVIEW_SMALL-2', 'I approve the plan', 'I approve the waiver of REVIEW_SMALL-1 but not the rest']) {
    say(d, t);
    refused(A(d, ['approve', 'LC', 'waive:REVIEW_SMALL-1']), `a waiver sentence approved: '${t}'`);
  }
  say(d, 'REVIEW_SMALL-1 feragatini onaylıyorum');
  accepted(A(d, ['approve', 'LC', 'waive:REVIEW_SMALL-1']), 'the Turkish waiver sentence');
  for (const n of approvalsOf(d, /^\d{3}-waive-REVIEW_SMALL-1\.yaml$/)) rmSync(`${d}/.agents/runs/LC/approvals/${n}`);
  accepted(A(d, ['request-approval', 'LC', 'waive:REVIEW_SMALL-1']), 'second request');
  say(d, 'I approve the waiver of REVIEW_SMALL-1.');
  accepted(A(d, ['approve', 'LC', 'waive:REVIEW_SMALL-1']), 'the English waiver sentence');
  refused(A(d, ['waive', 'LC', 'REVIEW_SMALL-1', '--reason', reason], { role: 'reviewer' }), 'a reviewer waived');
  accepted(A(d, ['waive', 'LC', 'REVIEW_SMALL-1', '--reason', reason]), 'the lead\'s waiver');
  assert.equal(gateStatus(d, 'REVIEW_SMALL'), 'waived', 'a fully waived FAIL is not waived');
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), /event=waive /);
  accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE over a waived finding');
});
