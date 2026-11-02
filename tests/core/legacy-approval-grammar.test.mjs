// @ts-check
// Behaviour of lifecycle-test.sh scenario_approval_fail_closed (A108, A134) and scenario_tree_forged, as absolute Node tests (tests/legacy-port-map.tsv).
// The word lists are the shell scenario's, recorded once; the grammar is asked in process (textHasApproval, what `approve` calls), and a few real
// `approve` runs prove the fail-closed effect: an ambiguous answer writes no approval file and leaves the request pending.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { textHasApproval } from '../../control-plane/agents/scripts/core/approvals.mjs';
import { A, IMPLEMENTED, accepted, project, refused, say, verbs } from './legacy-lib.mjs';

const bytes = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('latin1');
/** @param {string} dir */
function ctxOf(dir) {
  const script = `${dir}/.agents/scripts/agent.sh`;
  return new Context({ env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' }, cwd: dir, scriptPath: script, stdout: { write() {} }, stderr: { write() {} } }, script);
}

const AMBIGUOUS = ['hmm bir dakika', 'sonra bakarız', '', 'the weather is nice today', 'approve the plan?', 'do not approve the plan', 'approve the plan, but wait', 'plan için emin değilim, onaylıyorum', 'unapproved plan', 'okay then', 'plan tamamen yanlış', "I shouldn't approve the plan", 'I cannot approve the plan', 'yes, delete nothing', 'plan için onay vermiyorum', 'plan onay yok', 'plan olmaz, onay yok', 'plan: onaylamıyorum, evet', 'plan onay bekliyor', 'I will approve the plan after I review the tests', 'what does the plan do before I approve', 'yes the plan is wrong', 'evet, plan yanlış', 'approve the plan — just kidding', 'PLAN ONAYLIYORUM DEĞİL'];
const ALLOWED = ['approve the plan', 'Plan approved.', 'yes, plan', 'ok plan', 'okay, plan', 'LGTM plan', 'go ahead with the plan', 'plan onaylandı', 'plan onayliyorum', 'Plan: evet', 'plan tamam', 'plan olur'];
/** kind -> full sentences that approve it (English and Turkish, ASCII variants) */
const FULL = {
  plan: ['I approve the plan', '"I approve the plan"', 'Planı onaylıyorum', 'PLANI ONAYLIYORUM', 'planı onayladım', 'I approved the plan.', 'plani onayliyorum'],
  destructive: ['I approve the destructive step', 'Yıkıcı adımı onaylıyorum', 'yikici degisikligi onayliyorum', 'i approve the destructive change'],
  single_step: ['I approve the single step', 'tek adımı onaylıyorum', 'tek adimi onayladim'],
  scope: ['I approve the scope', 'Kapsamı onaylıyorum', 'kapsami onayliyorum'],
  budget: ['I approve the budget', 'I approve another round', 'Bütçeyi onaylıyorum', 'Bir round daha onaylıyorum', 'butceyi onayladim'],
  commit: ['I approve the commit', "Commit'i onaylıyorum", "commit'i onayladım"],
  push: ['I approve the push', "Push'u onaylıyorum", "push'u onayliyorum"],
};
const longq = `${'x'.repeat(20)} he wrote: "I approve the plan" in an earlier mail`;
/** kind -> wrong-kind, hedged, negated, mixed or question sentences that must NOT approve it */
const WRONG = {
  plan: ['I approve the commit', 'I approve the scope', "Commit'i onaylıyorum", 'Kapsamı onaylıyorum', 'I approve the plan but not the migration', 'I approve the plan and the commit', 'onaylıyorum ama sonra', 'Planı onaylıyorum ama göçü değil', 'maybe I approve the plan', 'I do not approve the plan', 'I dont approve the plan', 'Planı onaylamıyorum', 'Planı onaylıyorum?', 'approve?', 'I approve the plan, thanks', 'I approve the plans'],
  commit: ['I approve the plan', 'I approve the push', 'I approve the commit but wait', "Commit'i onaylamıyorum", "Push'u onaylıyorum"],
};

test('approval detection is fail-closed: ambiguous, negated, hedged and wrong-kind answers never approve (A108)', () => {
  const d = project('scaffold standalone no TRIVIAL supervised');
  const ctx = ctxOf(d);
  for (const t of AMBIGUOUS) assert.equal(textHasApproval(ctx, bytes(t), 'plan', 'LC'), false, `an ambiguous answer approved: '${t}'`);
  for (const t of ALLOWED) assert.equal(textHasApproval(ctx, bytes(t), 'plan', 'LC'), true, `an allowlisted answer was refused: '${t}'`);
  for (const [k, list] of Object.entries(FULL)) for (const t of list) assert.equal(textHasApproval(ctx, bytes(t), k, 'LC'), true, `a full sentence was refused for ${k}: '${t}'`);
  for (const [k, list] of Object.entries(WRONG)) for (const t of list) assert.equal(textHasApproval(ctx, bytes(t), k, 'LC'), false, `a wrong-kind or ambiguous sentence approved ${k}: '${t}'`);
  for (const t of ['', longq, 'I approve the plan I approve the plan']) assert.equal(textHasApproval(ctx, bytes(t), 'plan', 'LC'), false, `an empty or quoted answer approved: '${t.slice(0, 30)}'`);
});

test('approve refuses an ambiguous reply and leaves the request pending; the question lists the accepted answers; the grammar is locale independent', () => {
  const d = project('scaffold standalone no TRIVIAL supervised');
  const q = accepted(A(d, ['request-approval', 'LC', 'plan']), 'request').out;
  for (const w of ['approve', 'yes', 'okay', 'lgtm', 'go ahead', 'evet', 'onay', 'olur', 'tamam']) assert.ok(q.includes(w), `the question does not list the accepted answer '${w}'`);
  assert.ok(q.includes('"I approve the plan" | "Planı onaylıyorum"'), 'the question does not show the full sentences');
  const ad = `${d}/.agents/runs/LC/approvals`;
  for (const t of ['hmm bir dakika', 'approve the plan?', 'do not approve the plan', "I shouldn't approve the plan", 'PLAN ONAYLIYORUM DEĞİL', 'plan onay yok', 'yes the plan is wrong']) {
    say(d, t);
    refused(A(d, ['approve', 'LC', 'plan']), `an ambiguous answer approved: '${t}'`);
    refused(A(d, ['approve', 'LC', 'plan'], { env: { LC_ALL: 'en_US.UTF-8' } }), `an ambiguous answer approved under UTF-8: '${t}'`);
    assert.deepEqual(readdirSync(ad).filter((n) => /^\d{3}-plan\.yaml$/.test(n)), [], `an approval file exists after '${t}'`);
    assert.ok(readdirSync(ad).includes('001-request-plan.yaml'), 'the request is no longer pending');
  }
  say(d, 'PLAN ONAYLIYORUM');
  accepted(A(d, ['approve', 'LC', 'plan'], { env: { LC_ALL: 'en_US.UTF-8' } }), 'an allowlisted answer was refused under UTF-8');
});

test('tree recovery: a hand-written window of role user, not bound in the ledger by tree-accept, attests nothing', async () => {
  const { writeFileSync, readFileSync, readdirSync: ls } = await import('node:fs');
  const d = project(`scaffold orchestrated; ${IMPLEMENTED}`);
  const before = A(d, ['patch-fingerprint', 'LC']).out.trim();
  writeFileSync(`${d}/impl.txt`, 'forged\n', { flag: 'a' });
  const after = A(d, ['patch-fingerprint', 'LC']).out.trim();
  const w = `${d}/.agents/runs/LC/worker-evidence`;
  const n = ls(w).filter((f) => /^WINDOW-\d+\.yaml$/.test(f)).length + 1;
  writeFileSync(`${w}/WINDOW-${n}.yaml`, `task_id: "LC"\nseq: ${n}\nrole: "user"\ntopology: "orchestrated"\nbefore_sha256: "${before}"\nafter_sha256: "${after}"\nexit_status: "0"\n`);
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'a hand-written user window attested a change');
  void readFileSync; void verbs;
});
