// @ts-check
// Stage 6 (A215): the CI-fix rounds (A169) and the resume lines of an open pull request, in Node (cifix-test.sh sc_ci_fix_normal, sc_ci_fix_unreadable,
// sc_ci_fix_limit, sc_ci_fix_resume, sc_delivery_commit_fresh). The platform tool is a fake gh outside every temporary folder.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync as wf } from 'node:fs';
import { test } from 'node:test';
import { A, TASKS_IN_TASKS, accepted, approveDelivery, commitDelivery, existsSync, fakeGh, g, gOk, hooks, pushed, readFileSync, refused, run, verbs } from './run6-lib.mjs';
import { project } from './legacy-lib.mjs';

const RECIPE = `SC_BRANCH=1 scaffold orchestrated yes; ${TASKS_IN_TASKS}; to_code_done orchestrated; finish_done`;
const read = (/** @type {string} */ d, /** @type {string} */ f) => readFileSync(`${d}/${f}`, 'utf8');

/** @typedef {ReturnType<typeof fakeGh>} Gh */

/** A red check of the head: the failed run and its log (the platform tool answers both). @param {Gh} gh @param {string} [id] @param {string} [msg] */
function ciRed(gh, id = '123', msg = 'AssertionError: lookup returned the wrong value for an empty key') {
  wf(`${gh.state}/gh.runs`, JSON.stringify([{ databaseId: Number(id), status: 'completed', conclusion: 'failure', name: 'build' }]));
  wf(`${gh.state}/gh.log`, `build\tRun tests\t2026-01-01T00:00:00Z ${msg}\n`);
}
/** @param {Gh} gh */
function ciGreen(gh) { wf(`${gh.state}/gh.runs`, JSON.stringify([{ databaseId: 123, status: 'completed', conclusion: 'success', name: 'build' }])); wf(`${gh.state}/gh.log`, ''); }

const S = (/** @type {string} */ d, /** @type {Gh} */ gh, /** @type {string[]} */ ...a) => A(d, ['deliver-step', 'LC', ...a], { env: gh.env });
const recField = (/** @type {string} */ d, /** @type {string} */ n, /** @type {string} */ k) => new RegExp(`^${k}: "?([^"\\n]*)"?$`, 'm').exec(read(d, `.agents/runs/LC/ci-fix/${n}.yaml`))?.[1] ?? '';
const ledgerN = (/** @type {string} */ d, /** @type {string} */ ev) => (read(d, '.agents/runs/LC/LEDGER.log').match(new RegExp(` event=${ev} `, 'g')) ?? []).length;
const pushReal = (/** @type {string} */ d) => { const p = run(d, 'git', ['push', '-q', 'bare', 'proofline/LC-lookup']); assert.equal(p.status, 0, `the approved push was blocked: ${p.text}`); gOk(d, 'update-ref', 'refs/remotes/origin/proofline/LC-lookup', 'HEAD'); };

/** A delivery that reached the merge step (the pull request is open, number 7, the delivery approval used). @param {Gh} gh */
function toPrOpen(gh) {
  const d = project(RECIPE);
  hooks(d);
  gOk(d, 'init', '-q', '--bare', `${d}-bare.git`);
  gOk(d, 'remote', 'add', 'bare', `${d}-bare.git`);
  accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan');
  approveDelivery(d);
  accepted(S(d, gh, 'commit'), 'commit');
  commitDelivery(d);
  accepted(S(d, gh, 'push'), 'push');
  pushReal(d);
  accepted(S(d, gh, 'pr'), 'pr');
  gh.says('OPEN', g(d, 'rev-parse', 'HEAD'));
  accepted(S(d, gh, 'merge', '7'), 'merge');
  return d;
}

/** One whole CI-fix round, from the red check to the recorded push. @param {string} d @param {Gh} gh @param {number} n */
function ciRound(d, gh, n) {
  ciRed(gh, String(120 + n));
  gh.says('OPEN', g(d, 'rev-parse', 'HEAD'));
  accepted(S(d, gh, 'ci-fix', '7'), `ci-fix ${n}`);
  accepted(verbs(d, `worker FIX pass impl.txt "impl: CI fix ${n}"; A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null; finish_done '' '## Reopen History' "Reopened for CI fix ${n} after a red check of the pull request."`), `the fix round ${n}`);
  accepted(S(d, gh, 'ci-commit', '7'), `ci-commit ${n}`);
  gOk(d, 'add', '-A');
  const c = run(d, 'git', ['commit', '-qF', `.agents/local/deliver/LC/ci-fix-00${n}.msg`]);
  assert.equal(c.status, 0, `the CI-fix commit ${n} was blocked: ${c.text}`);
  accepted(S(d, gh, 'ci-push', '7'), `ci-push ${n}`);
  pushReal(d);
  gh.says('OPEN', g(d, 'rev-parse', 'HEAD'));
  accepted(S(d, gh, 'ci-merge', '7'), `ci-merge ${n}`);
}

test('ci-fix: a red CI opens a fix round without a question, the fix goes to the same pull request, other refs and other pushes are refused, the ledger ties push to fix', () => {
  const gh = fakeGh();
  const d = toPrOpen(gh);
  // forbidden: a CI fix when nothing is red, for another pull request, or for a pull request at another head
  ciGreen(gh);
  refused(S(d, gh, 'ci-fix', '7'), 'ci-fix while the CI is green', 'shows no failed check');
  assert.ok(!existsSync(`${d}/.agents/runs/LC/ci-fix`) && ledgerN(d, 'ci-fix-open') === 0, 'a refused ci-fix left a record');
  ciRed(gh);
  refused(S(d, gh, 'ci-fix', '8'), 'ci-fix for another pull request number', "pull request 8 is not this delivery's");
  const h = g(d, 'rev-parse', 'HEAD');
  gh.says('OPEN', `${g(d, 'rev-parse', 'HEAD^')} proofline/LC-lookup main acme`);
  refused(S(d, gh, 'ci-fix', '7'), 'ci-fix on a pull request at another head', "not this delivery's open");
  gh.says('OPEN', `${h} proofline/LC-lookup main forker`);
  refused(S(d, gh, 'ci-fix', '7'), "ci-fix on a fork's pull request", "not this delivery's open");
  gh.says('OPEN', h);
  // open: no question, the run is reopened inside the frozen scope, the error is in the record
  const open = accepted(S(d, gh, 'ci-fix', '7'), 'ci-fix').out;
  assert.match(open, /CI-fix attempt 1 of 2 opened for pull request 7/);
  assert.match(read(d, '.agents/runs/LC/RUN.yaml'), /^ {2}state: "?AMENDING"?$/m);
  assert.equal(A(d, ['questions', 'LC']).out, 'no pending questions: LC\n', 'a CI fix asked the user');
  assert.match(read(d, '.agents/runs/LC/ci-fix/001.log'), /AssertionError/);
  assert.equal(recField(d, '001', 'ci_run'), '123');
  assert.equal(recField(d, '001', 'state'), 'open');
  const reopen = readdirSync(`${d}/.agents/runs/LC/gates`).find((n) => n.endsWith('-REOPEN.yaml')) ?? '';
  assert.match(read(d, `.agents/runs/LC/gates/${reopen}`), /^authorized_by: user delivery approval /m, 'the reopen does not name the delivery approval');
  // resume / repeat: the same attempt, not a second one; no new delivery summary during the round; nothing to commit yet
  assert.match(accepted(S(d, gh, 'ci-fix', '7'), 'repeat').out, /attempt 1 of 2 is in progress/);
  assert.equal(ledgerN(d, 'ci-fix-open'), 1, 'a repeated ci-fix opened another attempt');
  refused(A(d, ['deliver-plan', 'LC']), 'deliver-plan during a CI-fix round', 'CI-fix round');
  refused(S(d, gh, 'ci-commit', '7'), 'ci-commit before the fix is done', 'fix round is not finished');
  accepted(verbs(d, "worker FIX pass impl.txt 'impl: CI fix 1'; A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null"), 'the fix');
  refused(S(d, gh, 'ci-commit', '7'), 'ci-commit before the report and DONE', 'fix round is not finished');
  accepted(verbs(d, "finish_done '' '## Reopen History' 'Reopened for CI fix 1 after a red check of the pull request.'"), 'finish_done');
  assert.match(accepted(S(d, gh, 'ci-commit', '7'), 'ci-commit').out, /git commit -F \.agents\/local\/deliver\/LC\/ci-fix-001\.msg/);
  const appr = () => readdirSync(`${d}/.agents/runs/LC/approvals`).filter((n) => !n.includes('request'));
  const lastOf = (/** @type {string} */ k) => appr().filter((n) => n.endsWith(`-${k}.yaml`)).sort().pop() ?? '';
  assert.match(read(d, `.agents/runs/LC/approvals/${lastOf('commit')}`), /^source: "delivery_ci_fix"/m);
  refused(S(d, gh, 'ci-push', '7'), 'ci-push before the commit', 'not committed yet');
  // forbidden: a commit that holds more than the gated content, and a second commit
  wf(`${d}/late.txt`, 'late\n'); gOk(d, 'add', '-A');
  assert.notEqual(run(d, 'git', ['commit', '-qF', '.agents/local/deliver/LC/ci-fix-001.msg']).status, 0, 'a CI-fix commit with an extra file');
  gOk(d, 'rm', '-q', '--cached', 'late.txt'); run(d, 'rm', ['late.txt']);
  gOk(d, 'add', '-A');
  const cm = run(d, 'git', ['commit', '-qF', '.agents/local/deliver/LC/ci-fix-001.msg']);
  assert.equal(cm.status, 0, `the CI-fix commit was blocked: ${cm.text}`);
  assert.notEqual(run(d, 'git', ['commit', '-q', '--allow-empty', '-m', 'chore: more']).status, 0, 'a second commit under the same approval');
  assert.match(accepted(S(d, gh, 'ci-push', '7'), 'ci-push').out, /git push origin proofline\/LC-lookup/);
  const pa = `.agents/runs/LC/approvals/${lastOf('push')}`;
  assert.match(read(d, pa), /^source: "delivery_ci_fix"/m);
  assert.match(read(d, pa), /^ref: "refs\/heads\/proofline\/LC-lookup"/m);
  assert.match(read(d, pa), /^consumed: "false"/m);
  // forbidden: the approval does not carry a push to another branch; it stays unused
  const other = run(d, 'git', ['push', 'bare', 'proofline/LC-lookup:refs/heads/other']);
  assert.ok(other.status !== 0 && /not for a push to refs\/heads\/other/.test(other.text), `a push to another branch was not refused: ${other.text}`);
  assert.equal(g(d, 'ls-remote', 'bare', 'refs/heads/other'), '', 'the other branch exists on the remote');
  assert.match(read(d, pa), /^consumed: "false"/m, 'the refused push consumed the approval');
  const before = g(d, 'rev-parse', 'HEAD'); const old = g(d, 'rev-parse', 'HEAD^');
  pushReal(d);
  assert.equal(g(d, 'ls-remote', 'bare', 'refs/heads/proofline/LC-lookup').split('\t')[0], before, 'the fix is not on the pull request branch');
  assert.match(read(d, pa), /^consumed: "true"/m, 'the push did not consume its approval');
  assert.notEqual(A(d, ['approval-consume', 'LC', 'push', '', 'refs/heads/proofline/LC-lookup']).status, 0, 'a second use of the push approval');
  gh.says('OPEN', before);
  assert.match(accepted(S(d, gh, 'ci-merge', '7'), 'ci-merge').out, /^run: proofline merge 7$/m);
  assert.equal(recField(d, '001', 'state'), 'pushed');
  assert.equal(recField(d, '001', 'pushed_head'), before);
  assert.equal(recField(d, '001', 'failing_head'), old);
  assert.ok(read(d, '.agents/runs/LC/LEDGER.log').split('\n').some((l) => l.includes(' event=ci-fix-push ') && l.includes(`attempt=1 pr=7 ci_run=123 from=${old} to=${before}`)), 'the ledger does not tie the push to the fix');
  assert.equal(ledgerN(d, 'ci-fix-grant'), 2);
  assert.equal(ledgerN(d, 'ci-fix-open'), 1);
  accepted(A(d, ['verify-seal', 'LC']), 'the ledger seal');
  // merged: cleanup works over the delivery commit and the CI-fix commit
  gh.says('MERGED', before);
  accepted(S(d, gh, 'cleanup', '7'), 'cleanup after the CI fix');
  assert.ok(!existsSync(`${d}/.agents/runs/LC`) && !existsSync(`${d}/.agents/local/deliver/LC`), 'the run survived the delivery');
});

test('ci-fix: an unreadable log still opens the round from the check name and status and says so (A186)', () => {
  const gh = fakeGh();
  const d = toPrOpen(gh);
  wf(`${gh.state}/gh.runs`, JSON.stringify([{ databaseId: 124, status: 'completed', conclusion: 'failure', name: 'build' }]));
  wf(`${gh.state}/gh.log`, '');
  gh.says('OPEN', g(d, 'rev-parse', 'HEAD'));
  const out = accepted(S(d, gh, 'ci-fix', '7'), 'ci-fix with an unreadable log').out;
  assert.match(out, /^NOTE: the log of the failed check could not be read on this platform; this round starts from the check name \(build\) and status \(failure\) only/m);
  assert.match(read(d, '.agents/runs/LC/ci-fix/001.log'), /starts from the check name and status only/);
  assert.equal(recField(d, '001', 'ci_run'), '124');
  assert.equal(recField(d, '001', 'state'), 'open');
});

test('ci-fix: two attempts, then the third red CI stops with one question (a batch parks the task on it)', () => {
  const gh = fakeGh();
  const d = toPrOpen(gh);
  ciRound(d, gh, 1);
  ciRound(d, gh, 2);
  assert.equal(recField(d, '001', 'state'), 'pushed');
  assert.equal(recField(d, '002', 'state'), 'pushed');
  ciRed(gh, '130', 'Error: still failing');
  gh.says('OPEN', g(d, 'rev-parse', 'HEAD'));
  const stop = S(d, gh, 'ci-fix', '7');
  assert.notEqual(stop.status, 0, 'a third red CI opened a third attempt');
  for (const re of [/CI fix limit reached for pull request 7/, /attempt 1: CI run 121/, /attempt 2: CI run 122/, /STOP: the CI is red after 2 CI-fix attempts/, /still failing/]) assert.match(stop.text, re);
  assert.equal(ledgerN(d, 'ci-fix-open'), 2);
  assert.equal(ledgerN(d, 'ci-fix-stop'), 1);
  const q = A(d, ['questions', 'LC']).out;
  assert.match(q, /still red after 2 CI-fix attempts/);
  assert.match(read(d, '.agents/runs/LC/RUN.yaml'), /^ {2}awaiting_input: "?true"?$/m);
  // the stop is final: no third attempt, no second question, no more grants
  assert.notEqual(S(d, gh, 'ci-fix', '7').status, 0);
  assert.equal((A(d, ['questions', 'LC']).out.match(/=== QUESTION/g) ?? []).length, 1, 'a repeated stop asked again');
  assert.equal(ledgerN(d, 'ci-fix-open'), 2);
  refused(S(d, gh, 'ci-commit', '7'), 'ci-commit after the last attempt', 'not open for a commit');
  assert.notEqual(q.split('\n').find((l, i, a) => a[i - 1]?.startsWith('=== QUESTION')) ?? '', '', 'the batch reads no first question line');
});

test('ci-fix: resume finds the CI step of an open pull request and every step of an open CI-fix round from the records', () => {
  const gh = fakeGh();
  const d = toPrOpen(gh);
  const next = () => accepted(A(d, ['next', 'LC']), 'next').out;
  assert.match(next(), /^next=gh pr checks 7 --watch --fail-fast$/m);
  assert.match(next(), /agent\.sh deliver-step LC ci-fix 7/);
  assert.match(next(), /cleanup 7/);
  ciRed(gh);
  gh.says('OPEN', g(d, 'rev-parse', 'HEAD'));
  accepted(S(d, gh, 'ci-fix', '7'), 'ci-fix');
  assert.match(next(), /^next=dispatch\.sh LC implementer$/m);
  accepted(verbs(d, "worker FIX pass impl.txt 'impl: CI fix 1'; A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null; finish_done '' '## Reopen History' 'Reopened for CI fix 1.'"), 'the fix');
  assert.match(next(), /^next=agent\.sh deliver-step LC ci-commit 7$/m);
  accepted(S(d, gh, 'ci-commit', '7'), 'ci-commit');
  gOk(d, 'add', '-A');
  assert.equal(run(d, 'git', ['commit', '-qF', '.agents/local/deliver/LC/ci-fix-001.msg']).status, 0);
  assert.match(next(), /^next=agent\.sh deliver-step LC ci-push 7$/m);
  accepted(S(d, gh, 'ci-push', '7'), 'ci-push');
  pushReal(d);
  gh.says('OPEN', g(d, 'rev-parse', 'HEAD'));
  assert.match(next(), /^next=agent\.sh deliver-step LC ci-merge 7$/m);
  accepted(S(d, gh, 'ci-merge', '7'), 'ci-merge');
  assert.match(next(), /gh pr checks 7 --watch/);
  accepted(A(d, ['digest', 'LC']), 'digest of a run over its delivery commit');
});

test('ci-fix (batch): the batch delivery cover carries two CI-fix rounds to the same PR branch with no user reply; the third red CI leaves the question a batch parks on', () => {
  const gh = fakeGh();
  const d = project("SC_BRANCH=1 scaffold orchestrated; for s in \"$tl_agents\"/scripts/*.sh; do case \"$(basename \"$s\")\" in *-test.sh|test-lib.sh|agent.sh|exec-policy.sh|secret-scan.sh) continue ;; esac; cp \"$s\" .agents/scripts/; done; mkdir -p .agents/tasks; printf '# Task: LC \u2014 title of LC\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Suggested class\n\nCOMPLEX\n' > .agents/tasks/LC.md; "
    + "A batch-plan all >/dev/null; capture 'approve batch'; A approve-pending >/dev/null; to_code_done orchestrated; finish_done");
  hooks(d);
  gOk(d, 'init', '-q', '--bare', `${d}-bare.git`);
  gOk(d, 'remote', 'add', 'bare', `${d}-bare.git`);
  accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan');
  accepted(A(d, ['batch-cover', 'LC', 'delivery']), 'batch-cover delivery');
  const pushApproval = readdirSync(`${d}/.agents/runs/LC/approvals`).filter((n) => n.endsWith('-push.yaml') && !n.includes('request')).sort().pop() ?? '';
  assert.match(read(d, `.agents/runs/LC/approvals/${pushApproval}`), /^source: "batch"/m);
  assert.match(read(d, `.agents/runs/LC/approvals/${pushApproval}`), /^ref: "refs\/heads\/proofline\/LC-lookup"/m);
  run(d, 'rm', ['-f', ...readdirSync(`${d}/.agents/local/prompts`).map((n) => `${d}/.agents/local/prompts/${n}`)]); // no user reply exists from here on
  accepted(S(d, gh, 'commit'), 'commit');
  commitDelivery(d);
  accepted(S(d, gh, 'push'), 'push');
  pushReal(d);
  accepted(S(d, gh, 'pr'), 'pr');
  gh.says('OPEN', g(d, 'rev-parse', 'HEAD'));
  accepted(S(d, gh, 'merge', '7'), 'merge');
  ciRound(d, gh, 1);
  assert.ok(readdirSync(`${d}/.agents/runs/LC/approvals`).some((n) => n.endsWith('-push.yaml') && /source: "delivery_ci_fix"/.test(read(d, `.agents/runs/LC/approvals/${n}`))), 'no CI-fix push approval under the batch delivery cover');
  const other = run(d, 'git', ['push', 'bare', 'proofline/LC-lookup:refs/heads/other']);
  assert.notEqual(other.status, 0, 'a push to another branch under the batch cover');
  ciRound(d, gh, 2);
  ciRed(gh, '130', 'Error: still failing');
  gh.says('OPEN', g(d, 'rev-parse', 'HEAD'));
  refused(S(d, gh, 'ci-fix', '7'), 'a third attempt in a batch', 'STOP: the CI is red after 2 CI-fix attempts');
  assert.deepEqual(readdirSync(`${d}/.agents/local/prompts`), [], 'a prompt capture appeared: the round asked the user');
  const q = A(d, ['questions', 'LC']).out;
  assert.match(q, /still red after 2 CI-fix attempts/);
  assert.notEqual(q.split('\n').find((l, i, a) => a[i - 1]?.startsWith('=== QUESTION')) ?? '', '', 'the batch reads no first question line');
});

test('freshness: the run\'s own delivery commit does not stale the plan; another commit on top does', () => {
  const gh = fakeGh();
  const d = toPrOpen(gh);
  accepted(A(d, ['freshness', 'LC']), 'the plan went stale after the run\'s own delivery commit');
  accepted(A(d, ['verify-handoff', 'LC']), 'verify-handoff over the delivery commit');
  gOk(d, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'chore: someone else');
  refused(A(d, ['freshness', 'LC']), 'a commit that is not the delivery\'s own', 'stale plan');
});

void [mkdirSync, pushed];
