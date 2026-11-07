// @ts-check
// batch-plan and the pre-flight (A157, A200, A202, A225): the scenarios of the former batch-test.sh that prove the plan - order and cycle, priority, the
// excluded tasks, the approval bound to the summary hash, the plan-lint questions and the user's answers, the commands proposal, the shared-file wait, the
// refusals. Every asserted action is a call of the real control plane (the Node core) in a throwaway project; the exact texts are held by batch-golden.test.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  A, AB, batchApprove, behave, bnew, binstall, cfgBatch, drive, fakes, gOk, has, lines, mkdirSync, mkprio, mktask, nfiles, orderIds, put, read, readIf, rmSync, say, summaryOf, writeFileSync,
} from './batch-lib.mjs';

const BP = (/** @type {ReturnType<typeof fakes>} */ F, /** @type {string} */ dir, /** @type {string[]} */ args) => AB(F, dir, ['batch-plan', ...args]);
const bdir = (/** @type {string} */ dir) => `${dir}/.agents/local/batch`;
/** @param {{ status: number|null, text: string }} r @param {string} what @param {string|RegExp} [msg] */
function refused(r, what, msg) {
  assert.notEqual(r.status, 0, `${what}: the command succeeded\n${r.text}`);
  if (msg !== undefined) assert.ok(typeof msg === 'string' ? r.text.includes(msg) : msg.test(r.text), `${what}: rejected for another reason: ${r.text.trim().split('\n').pop()}`);
}
const body = (/** @type {string} */ ctx, /** @type {string} */ ac = 'AC-1: it works') => `## Goal\n\nIt works.\n\n## Context\n\n${ctx}\n\n## Acceptance criteria\n\n- ${ac}\n\n## Out of scope\n\n- Other.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n`;

test('depends_on order, "all", done/ dependencies, the unknown dependency, the cycle that writes nothing (sc_order_and_cycle)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX'); mktask(dir, 'T-3', 'COMPLEX', 'T-1'); mktask(dir, 'T-5', 'COMPLEX', 'T-9');
  mktask(dir, 'T-7', 'COMPLEX', '', 'todo'); mktask(dir, 'T-8', 'COMPLEX', '', 'backlog'); mktask(dir, 'T-9', 'COMPLEX', '', 'done');
  binstall(dir, { remote: false });
  const p = BP(F, dir, ['T-3', 'T-1', 'T-2']);
  assert.equal(p.status, 0, p.text);
  assert.equal(orderIds(dir), 'T-1 T-3 T-2', 'a dependency goes before its dependant, ties keep the listed order');
  const ord = lines(`${bdir(dir)}/order.tsv`).map((l) => l.split('\t'));
  assert.equal(ord.find((r) => r[0] === 'T-3')?.[1], 'COMPLEX');
  assert.match(ord.find((r) => r[0] === 'T-3')?.[2] ?? '', /T-1/);
  assert.ok(p.out.includes(`batch id: ${(await_sha(summaryOf(dir))).slice(0, 12)}`), 'the batch id is printed');
  assert.ok(p.out.includes('approve batch'), 'the question names "approve batch"');
  assert.equal(nfiles(`${dir}/.agents/local/approvals`, /request-batch/), 1, 'one batch approval request');
  // a dependency in done/ is satisfied; a todo/ task is in `all`; backlog/ and done/ are not; a dependency nobody has is excluded
  assert.equal(BP(F, dir, ['all']).status, 0);
  assert.equal(orderIds(dir), 'T-1 T-2 T-3 T-5 T-7');
  mktask(dir, 'T-6', 'COMPLEX', 'T-99');
  assert.equal(BP(F, dir, ['all']).status, 0);
  assert.ok(!orderIds(dir).includes('T-6'), 'a task with an unknown dependency is in the batch');
  assert.ok(summaryOf(dir).includes('T-6'), 'the excluded T-6 is named in the summary');
  // cycle: refuse the whole batch, print it, write nothing, request nothing
  rmSync(`${dir}/.agents/local/batch`, { recursive: true, force: true }); rmSync(`${dir}/.agents/local/approvals`, { recursive: true, force: true });
  mktask(dir, 'T-1', 'COMPLEX', 'T-2'); mktask(dir, 'T-2', 'COMPLEX', 'T-3'); mktask(dir, 'T-3', 'COMPLEX', 'T-1');
  const c = BP(F, dir, ['T-1', 'T-2', 'T-3', 'T-5']);
  refused(c, 'a dependency cycle');
  assert.match(c.text, /dependency cycle: (T-1 -> T-2 -> T-3 -> T-1|T-2 -> T-3 -> T-1 -> T-2|T-3 -> T-1 -> T-2 -> T-3)/);
  assert.ok(!has(`${bdir(dir)}/SUMMARY.md`) && !has(`${bdir(dir)}/order.tsv`), 'a refused batch wrote a summary or an order');
  assert.equal(nfiles(`${dir}/.agents/local/approvals`, /request-batch/), 0, 'a refused batch requested an approval');
});

/** sha256 of a string (hex). @param {string} t */
function await_sha(t) { return createHash('sha256').update(Buffer.from(t, 'latin1')).digest('hex'); }

test('a batch without the approval does not start; the approval is bound to the summary hash and a re-plan has a fresh nonce (sc_no_approval_no_start)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX'); binstall(dir);
  assert.equal(AB(F, dir, ['batch-next']).out, 'no batch planned (agent.sh batch-plan <ID...|all>)\n');
  assert.equal(BP(F, dir, ['all']).status, 0);
  assert.match(AB(F, dir, ['batch-next']).out, /^NEXT: approve$/m);
  assert.equal(AB(F, dir, ['batch-next', '--tsv']).out.split('\n')[0], 'state\tunapproved');
  const sum = summaryOf(dir);
  assert.ok(sum.includes('Keep the computer awake') && sum.includes('caffeinate -i -w') && sum.includes('session open'));
  assert.ok(!/headless|driver|sandbox/i.test(sum), 'the summary names the removed driver');
  refused(AB(F, dir, ['batch-check']), 'batch-check before the user approved', 'no valid batch approval');
  say(dir, 'sounds good'); A(dir, ['approve-pending']);
  refused(AB(F, dir, ['batch-check']), 'batch-check after a reply that is not the approval', 'no valid batch approval');
  batchApprove(dir);
  assert.equal(nfiles(`${dir}/.agents/local/approvals`, /-batch\.yaml$/) - nfiles(`${dir}/.agents/local/approvals`, /request-batch/), 1, 'the reply "approve batch" recorded one batch approval');
  assert.match(AB(F, dir, ['batch-next']).out, /^NEXT: run T-1/m);
  // bound to the summary hash: a changed SUMMARY.md invalidates it
  const keep = readFileSync(`${bdir(dir)}/SUMMARY.md`);
  writeFileSync(`${bdir(dir)}/SUMMARY.md`, Buffer.concat([keep, Buffer.from('extra line\n')]));
  refused(AB(F, dir, ['batch-check']), 'batch-check with an edited summary', 'no valid batch approval');
  assert.match(AB(F, dir, ['batch-next']).out, /^NEXT: approve$/m);
  writeFileSync(`${bdir(dir)}/SUMMARY.md`, keep);
  const old = await_sha(keep.toString('latin1'));
  BP(F, dir, ['--replace', 'all']);
  assert.notEqual(await_sha(summaryOf(dir)), old, 'a new plan reused the old summary (no fresh nonce)');
  refused(AB(F, dir, ['batch-check']), 'batch-check after a re-plan', 'no valid batch approval');
  assert.equal(F.calls(), '', 'a task was started without the approval');
});

test('priority orders the tasks that are free to run; an Allowed scope violation is a pre-flight question and a park answer parks (sc_priority_and_allowed)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'STANDARD'); mkprio(dir, 'T-2', 'low'); mkprio(dir, 'T-3', 'high'); mkprio(dir, 'T-4', 'high', 'T-2'); mkprio(dir, 'T-5', 'medium');
  binstall(dir, { remote: false });
  assert.equal(BP(F, dir, ['T-1', 'T-2', 'T-3', 'T-4', 'T-5']).status, 0);
  assert.equal(orderIds(dir), 'T-3 T-1 T-5 T-2 T-4', 'high first, ties in the listed order, a dependency before its dependant (T-4 is high but waits for T-2)');
  BP(F, dir, ['T-2', 'T-1']);
  assert.equal(orderIds(dir), 'T-1 T-2', 'a plain task goes before a low one');
  mktask(dir, 'T-1', 'STANDARD');
  BP(F, dir, ['T-1', 'T-2']);
  assert.equal(orderIds(dir), 'T-1 T-2', 'tasks without priority keep the listed order');
  put(`${dir}/.agents/tasks/S-1.md`, '# Task: S-1 — scoped\n\n## Goal\n\nIt works.\n\n## Context\n\nChanges `src/a.js` and `lib/x.js`.\n\n## Acceptance criteria\n\n- AC-1: the output lists three rows\n\n## Out of scope\n\n- Other.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n\n## Suggested class\n\nSTANDARD because it is small.\n\n## Allowed scope\n\n- `src/`\n\n## Forbidden scope\n\n- `lib/y.js`\n');
  mktask(dir, 'S-2', 'STANDARD');
  gOk(dir, ['add', '-A']); gOk(dir, ['commit', '-qm', 'tasks']);
  assert.equal(BP(F, dir, ['S-1', 'S-2']).status, 0);
  const sum = summaryOf(dir);
  assert.match(sum, /\[S-1, scope\].*lib\/x\.js/, 'no Allowed scope question naming lib/x.js');
  const q = sum.split('\n').filter((l) => l.includes('[S-1, scope]')).join('\n');
  assert.ok(!q.includes('src/a.js'), 'a path inside the Allowed scope was asked about');
  assert.ok(!q.includes('lib/y.js'), 'the Forbidden scope path was asked about instead of refused at freeze');
  batchApprove(dir);
  put(`${dir}/.agents/local/prompts/history/${Math.floor(Date.now() / 1000) + 10}-dddd1111.txt`, 'Q1 a\n');
  assert.equal(AB(F, dir, ['batch-answer']).status, 0);
  const n = AB(F, dir, ['batch-next']).out;
  assert.match(n, /^S-1 \| PARKED \| allowed scope/m, 'an Allowed scope answer "park" did not park the task');
  assert.match(n, /^NEXT: run S-2/m, 'the other task does not go on');
});

test('CRITICAL, class-unknown tasks and the dependants of excluded tasks stay out; the summary says why and what is not covered (sc_critical_excluded)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'CRITICAL'); mktask(dir, 'T-3', 'none'); mktask(dir, 'T-4', 'COMPLEX', 'T-2'); mktask(dir, 'T-5', 'COMPLEX', 'T-1'); mktask(dir, 'T-6', 'STANDARD', 'T-3');
  binstall(dir, { remote: false });
  assert.equal(BP(F, dir, ['all']).status, 0);
  assert.equal(orderIds(dir), 'T-1 T-5');
  const sum = summaryOf(dir);
  assert.match(sum, /not in this batch/i);
  assert.match(sum.split('\n').filter((l) => l.includes('T-2')).join('\n'), /critical/i);
  assert.match(sum.split('\n').filter((l) => l.includes('T-3')).join('\n'), /class unknown/i);
  assert.ok(sum.split('\n').filter((l) => l.includes('T-4')).join('\n').includes('T-2'));
  assert.ok(sum.split('\n').filter((l) => l.includes('T-6')).join('\n').includes('T-3'));
  for (const w of ['waiver', 'scope', 'mutation', '40']) assert.match(sum, new RegExp(w, 'i'), `the summary does not mention '${w}'`);
});

test('the same approved batch is continued, only for tasks it knows; --replace is the way out (sc_plan_all_subset)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX'); mktask(dir, 'CR', 'CRITICAL'); binstall(dir);
  BP(F, dir, ['all']); batchApprove(dir);
  const same = BP(F, dir, ['all']);
  assert.equal(same.status, 0, same.text);
  assert.ok(same.text.includes('continuing it'), same.text);
  mktask(dir, 'T-9', 'COMPLEX');
  refused(BP(F, dir, ['all']), 'all with a task added after the approval', 'does not contain: T-9');
  refused(BP(F, dir, ['T-1', 'T-9']), 'an explicit ID the batch does not know', 'does not contain: T-9');
  assert.equal(BP(F, dir, ['--replace', 'all']).status, 0);
  assert.ok(orderIds(dir).includes('T-9'), '--replace did not include T-9');
});

test('night mode runs markdown tasks only; another adapter is refused with the next step and nothing is written (sc_adapter_refused)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX');
  writeFileSync(`${dir}/.agents/config.yaml`, read(`${dir}/.agents/config.yaml`).replace(/^ {2}adapter: markdown/m, '  adapter: github'));
  binstall(dir, { remote: false });
  const r = BP(F, dir, ['all']);
  refused(r, 'batch-plan with tasks.adapter github', 'tasks.adapter is github');
  assert.match(r.text, /Next step: set tasks\.adapter to markdown in \.agents\/config\.yaml, import each task with '\/proofline task <issue reference>' .*, then run '\/proofline batch <ID\.\.\.>' again\n?$/);
  assert.equal(lines(`${bdir(dir)}/SUMMARY.md`).length, 0);
  assert.equal(nfiles(`${dir}/.agents/local/approvals`, /request-batch/), 0, 'a refused plan requested an approval');
});

test('a project without a pull_request workflow can plan a batch: a WARNING, not a blocker; with a workflow no warning (sc_ci_required)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); binstall(dir, { remote: false });
  gOk(dir, ['rm', '-rq', '.github']); gOk(dir, ['commit', '-qm', 'no ci']);
  gOk(dir, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const r = BP(F, dir, ['T-1']);
  assert.equal(r.status, 0, r.text);
  const sum = summaryOf(dir);
  assert.match(sum, /^## WARNING/m);
  assert.ok(!sum.includes('BLOCKER'));
  for (const t of ['no CI check runs on pull requests here.', 'verifies the commit locally', '/proofline task Add a GitHub Actions workflow']) assert.ok(sum.includes(t), `the warning lacks '${t}'`);
  assert.ok(has(`${bdir(dir)}/order.tsv`));
  batchApprove(dir);
  assert.equal(AB(F, dir, ['batch-check']).status, 0, 'the approved batch without CI is not valid');
  mkdirSync(`${dir}/.github/workflows`, { recursive: true });
  writeFileSync(`${dir}/.github/workflows/ci.yml`, 'on: [push, pull_request]\njobs: {}\n');
  assert.equal(BP(F, dir, ['--replace', 'T-1']).status, 0);
  assert.ok(!/^## WARNING/m.test(summaryOf(dir)), 'WARNING in a summary with CI');
});

test('the removed driver says what to do instead; the old flag and batch-start/batch-stop are refused (sc_driver_removed)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); binstall(dir, { remote: false });
  refused(BP(F, dir, ['T-1', '--codex-danger-full-access']), 'the old Codex sandbox flag', 'is gone');
  refused(AB(F, dir, ['batch-start']), 'agent.sh batch-start');
  refused(AB(F, dir, ['batch-stop']), 'agent.sh batch-stop');
  assert.ok(!has(`${bdir(dir)}/SUMMARY.md`), 'a refused plan wrote a summary');
  refused(BP(F, dir, ['run']), 'a reserved word', 'reserved word');
  refused(BP(F, dir, ['NOPE']), 'an unknown task', 'not found');
  refused(BP(F, dir, ['bad!id']), 'an invalid id', 'invalid task ID');
  refused(BP(F, dir, []), 'no task ids and no approved batch', 'usage: agent.sh batch-plan');
});

test('batch planning never reads a finished task\'s completion report: its ID comes from the file name (sc_done_reports_unread)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-3', 'COMPLEX', 'T-9'); mktask(dir, 'T-9', 'COMPLEX', '', 'done');
  writeFileSync(`${dir}/.agents/tasks/done/T-9.md`, `${read(`${dir}/.agents/tasks/done/T-9.md`)}\n## Completion Report\n\nREPORT-SENTINEL-203\n`);
  binstall(dir, { remote: false });
  chmodSync(`${dir}/.agents/tasks/done/T-9.md`, 0o000);
  try {
    if (process.getuid?.() === 0) return; // root can read any file: the proof is skipped
    const r = BP(F, dir, ['T-3']);
    assert.equal(r.status, 0, `batch-plan opened a finished task or refused a dependency on it: ${r.text}`);
    assert.equal(orderIds(dir), 'T-3');
    assert.ok(!r.text.includes('REPORT-SENTINEL-203') && !readIf(`${bdir(dir)}/SUMMARY.md`).includes('REPORT-SENTINEL-203'));
  } finally { chmodSync(`${dir}/.agents/tasks/done/T-9.md`, 0o600); }
});

test('the pre-flight asks split, exempt, dependency, criteria and class; the answers are the user\'s captured words (sc_preflight)', () => {
  const F = fakes(); const dir = bnew();
  let paths = ''; for (let i = 1; i <= 18; i++) paths += ` \`src/m${i}.js\``;
  put(`${dir}/.agents/tasks/P-1.md`, `# Task: P-1 — wide task\n\n${body(`Changes${paths} and the pages \`docs/g1.md\`, \`docs/g2.md\`. This adds a new dependency on a library.`, 'AC-1: the output is better')}\n## Suggested class\n\nCOMPLEX because it touches many modules\n`);
  mktask(dir, 'P-2', 'STANDARD'); mktask(dir, 'P-3', 'COMPLEX');
  gOk(dir, ['add', '-A']); binstall(dir, { remote: false });
  assert.equal(BP(F, dir, ['P-1', 'P-2', 'P-3']).status, 0);
  const sum = summaryOf(dir);
  assert.match(sum, /^## Pre-flight questions/m);
  for (const k of ['split', 'exempt', 'dep', 'ac']) assert.ok(sum.includes(`[P-1, ${k}]`), `no ${k} question for P-1`);
  assert.ok(!sum.includes('[P-2'), 'a plain task raised a question');
  assert.ok(sum.includes('code paths (2 content or document paths are not counted)'));
  assert.match(sum, /\[P-3, class\].*Its reason/);
  assert.match(sum, /^## Verification commands/m);
  assert.ok(sum.includes('no proven proposal exists'));
  assert.ok(lines(`${bdir(dir)}/lint.tsv`).map((l) => l.split('\t').slice(0, 3).join(' ')).includes('Q1 P-1 split'));
  batchApprove(dir);
  refused(AB(F, dir, ['batch-answer']), 'batch-answer without a user message', 'no captured user message since the summary');
  const hist = `${dir}/.agents/local/prompts/history`;
  const now = Math.floor(Date.now() / 1000) + 10;
  put(`${hist}/${now}-aaaa1111.txt`, 'thanks, looks fine\n');
  refused(AB(F, dir, ['batch-answer']), 'a remark is no answer', 'no captured user message since the summary');
  put(`${hist}/${now + 1}-bbbb2222.txt`, 'Q1: do not split, Q2 a, Q3 b\nQ4 a.\n');
  assert.equal(AB(F, dir, ['batch-answer']).status, 0);
  const ans = AB(F, dir, ['batch-answers', 'P-1']).out;
  assert.match(ans, /Q1 P-1 split: option b \(up to 27\)/);
  assert.match(ans, /Q3 P-1 dep: option b/); assert.match(ans, /Q4 P-1 ac: option a/);
  const nx = AB(F, dir, ['batch-next']).out;
  assert.match(nx, /^P-1 \| PARKED \| new dependency/m, 'a dependency answer "park" did not park the task');
  const st = AB(F, dir, ['batch-status']).out;
  assert.match(st, /^P-1 \| PARKED \| .*new dependency/m, 'batch-status does not show P-1 as PARKED with its reason');
  assert.match(st, /^P-2 \| pending \| /m, 'the running-to-be task is not told apart from the parked one');
  assert.ok(!/^P-1 \| parked/m.test(nx), 'batch-next writes a parked task like an ordinary state');
  assert.match(nx, /^NEXT: run P-2/m);
  const count = () => (AB(F, dir, ['batch-answers', 'P-1']).out.match(/Q1 /g) ?? []).length;
  // a leading "no" that also says to split is ambiguous: Q1 stays unanswered, never read as option b (proceed without splitting)
  let before = count();
  put(`${hist}/${now + 1}-bbbb9999.txt`, 'Q1 no problem, split it\nQ2 a\n');
  assert.equal(AB(F, dir, ['batch-answer']).status, 0);
  assert.equal(count(), before, '"Q1 no problem, split it" was read as an answer to Q1');
  // "bölmek" / "bölmeli" say to split: never option b (do not split); only the bare imperative "bölme" does
  before = count();
  put(`${hist}/${now + 1}-bbbb9998.txt`, 'Q1 bölmeli\nQ2 a\n');
  assert.equal(AB(F, dir, ['batch-answer']).status, 0);
  assert.equal(count(), before, '"Q1 bölmeli" was read as an answer to Q1');
  put(`${hist}/${now + 1}-bbbb9997.txt`, 'Q1 bölmek lazım\nQ2 a\n');
  assert.equal(AB(F, dir, ['batch-answer']).status, 0);
  assert.equal(count(), before, '"Q1 bölmek lazım" was read as an answer to Q1');
  // the same message is used once; a later "all recommended" fills what is open and a later message corrects an answer
  put(`${hist}/${now + 2}-cccc3333.txt`, 'all recommended\n');
  assert.equal(AB(F, dir, ['batch-answer']).status, 0);
  assert.ok(count() >= 2, 'all recommended did not answer');
  assert.match(AB(F, dir, ['batch-answers', 'P-1']).out.split('\n').filter((l) => l.startsWith('Q1 ')).pop() ?? '', /option a/);
});

test('the empty-commands proposal is covered by the user\'s own words only; a batch approval covers a proposal its summary names (sc_commands_check)', () => {
  const F = fakes(); const dir = bnew();
  binstall(dir, { remote: false });
  const pf = `${dir}/.agents/local/commands/PROPOSAL.tsv`;
  put(pf, 'test\tnpm test\n');
  const ck = () => AB(F, dir, ['commands-check']);
  refused(ck(), 'commands-check without any approval', 'does not approve the commands');
  assert.match(AB(F, dir, ['request-approval', '-', 'commands']).out, /commands\.test: npm test/);
  put(`${dir}/.agents/local/prompts/s1.json`, `{"session":"s1","time":1000,"sha256":"${await_sha('approve commands')}","text":"approve commands"}\n`);
  A(dir, ['approve-pending']);
  refused(ck(), 'a reply older than the request', 'does not approve the commands');
  say(dir, 'looks good'); A(dir, ['approve-pending']);
  refused(ck(), 'a reply that is no approval', 'does not approve the commands');
  say(dir, 'approve commands'); A(dir, ['approve-pending']);
  assert.match(ck().out, /approved by the user/);
  // a proposal changed after the approval has no approval bound to it
  const keep = read(pf);
  put(pf, 'test\tnpm test\nlint\trm -rf x\n');
  refused(ck(), 'a forged proposal', 'does not approve the commands');
  put(pf, keep);
  assert.match(ck().out, /approved by the user/);
  A(dir, ['approval-consume', '-', 'commands']);
  refused(ck(), 'a replayed proposal after the apply', 'does not approve the commands');
  // a batch approval covers the proposal only when its summary names the proposal
  say(dir, 'looks good');
  mktask(dir, 'C-1', 'COMPLEX'); gOk(dir, ['add', '-A']); gOk(dir, ['commit', '-qm', 'c1']);
  BP(F, dir, ['C-1']);
  const h = createHash('sha256').update(readFileSync(pf)).digest('hex').slice(0, 12);
  assert.ok(lines(`${bdir(dir)}/SUMMARY.md`).includes(`commands proposal: ${h}`), 'the summary does not name the proven proposal');
  refused(ck(), 'commands-check before the batch is approved', 'does not approve the commands');
  batchApprove(dir);
  assert.match(ck().out, /covered by the batch approval/);
  // the digest orders the write before any task
  assert.match(AB(F, dir, ['batch-next']).out, /^NEXT: commands /m, 'batch-next does not put the covered commands proposal first');
  const moved = `${pf}.moved`;
  writeFileSync(moved, readFileSync(pf)); writeFileSync(pf, ''); // the proposal was applied: nothing to write
  assert.ok(!/^NEXT: commands/m.test(AB(F, dir, ['batch-next']).out), 'batch-next still asks for the commands after the proposal was applied');
  put(pf, 'test\tnpm test\nlint\trm -rf x\n');
  refused(ck(), 'a changed proposal', 'does not approve the commands');
});

test('a task that names a code path an earlier task names waits for that task\'s merge; document paths do not count (sc_same_files_wait)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX'); mktask(dir, 'T-3', 'COMPLEX'); binstall(dir);
  const add = (/** @type {string} */ id, /** @type {string} */ t) => writeFileSync(`${dir}/.agents/tasks/${id}.md`, `${read(`${dir}/.agents/tasks/${id}.md`)}${t}`);
  add('T-1', '\n## Scope\n\n- `src/shared.js`\n- `docs/notes.md`\n'); add('T-2', '\n## Scope\n\n- `src/shared.js`\n'); add('T-3', '\n## Scope\n\n- `src/other.js`\n- `docs/notes.md`\n');
  assert.equal(BP(F, dir, ['all']).status, 0); batchApprove(dir);
  assert.ok(readIf(`${bdir(dir)}/paths.tsv`).length > 0, 'no paths.tsv was written at plan time');
  const tsv = AB(F, dir, ['batch-next', '--tsv']).out.replace(/\t/g, ' ');
  assert.match(tsv, /^T-2 waiting shares src\/shared\.js with T-1 \(not merged yet\)/m);
  assert.match(tsv, /^T-3 open/m, 'a shared DOCUMENT path must not make T-3 wait');
  behave(F, 'T-1', 'question'); drive(F, dir);
  assert.match(AB(F, dir, ['batch-next', '--tsv']).out.replace(/\t/g, ' '), /^T-2 skipped shares src\/shared\.js with T-1 \(parked\)/m);
});

test('queued tasks are renamed to <ID>-<slug>.md only after the user\'s approval; the batch finds <ID>-<slug>.md; the task type is asked (sc_task_names)', () => {
  const F = fakes(); const dir = bnew();
  for (const d of ['todo', 'in-progress', 'backlog']) mkdirSync(`${dir}/.agents/tasks/${d}`, { recursive: true });
  binstall(dir, { remote: false });
  const mk = (/** @type {string} */ sub, /** @type {string} */ id, /** @type {string} */ title, /** @type {string} */ name) => put(`${dir}/.agents/tasks/${sub}/${name}.md`, `# Task: ${id} — ${title}\n\n## Goal\n\nIt works.\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Suggested class\n\nSTANDARD\n`);
  mk('todo', 'T-1', 'Türkçe başlık ışığı', 'T-1'); mk('backlog', 'T-2', 'Slug only', 'slug-only'); mk('todo', 'T-3', 'Already named', 'T-3-already-named');
  mk('todo', 'T-4', 'Started task', 'T-4'); mkdirSync(`${dir}/.agents/runs/T-4`, { recursive: true }); mk('in-progress', 'T-5', 'In progress', 'T-5');
  mk('todo', 'T-6', 'Reported task', 'T-6'); writeFileSync(`${dir}/.agents/tasks/todo/T-6.md`, `${read(`${dir}/.agents/tasks/todo/T-6.md`)}<!-- COMPLETION-REPORT:BEGIN:T-6 -->\n`);
  mk('todo', 'T-7', 'Echo', 'T-7-t-7');
  gOk(dir, ['add', '-A']); gOk(dir, ['commit', '-qm', 'tasks']);
  const plan = AB(F, dir, ['task-rename-plan']);
  assert.equal(plan.status, 0, plan.text);
  for (const want of ['T-1.md\t.agents/tasks/todo/T-1-turkce-baslik-isigi.md', 'slug-only.md\t.agents/tasks/backlog/T-2-slug-only.md', 'T-7-t-7.md\t.agents/tasks/todo/T-7-echo.md']) assert.ok(plan.out.includes(want), `rename proposal lacks: ${want}`);
  const prop = read(`${dir}/.agents/local/rename/PROPOSAL.tsv`);
  for (const no of ['T-3', 'T-4', 'T-5', 'T-6']) assert.ok(!prop.includes(no), `${no} was proposed for a rename`);
  refused(AB(F, dir, ['task-rename-apply']), 'rename applied without the user\'s approval', "needs the user's approval");
  say(dir, 'approve rename'); A(dir, ['approve-pending']);
  mkdirSync(`${dir}/.agents/runs/T-7`, { recursive: true });
  refused(AB(F, dir, ['task-rename-apply']), 'a task that started after the proposal was renamed', 'no longer a queued task file');
  assert.ok(has(`${dir}/.agents/tasks/todo/T-1.md`), 'a refused rename moved a file');
  rmSync(`${dir}/.agents/runs/T-7`, { recursive: true, force: true });
  assert.equal(AB(F, dir, ['task-rename-apply']).status, 0);
  for (const f of ['todo/T-1-turkce-baslik-isigi', 'backlog/T-2-slug-only', 'todo/T-7-echo']) assert.ok(has(`${dir}/.agents/tasks/${f}.md`), `the approved rename did not happen: ${f}`);
  for (const k of ['todo/T-3-already-named', 'todo/T-4', 'in-progress/T-5', 'todo/T-6']) assert.ok(has(`${dir}/.agents/tasks/${k}.md`), `${k} was renamed`);
  refused(AB(F, dir, ['task-rename-apply']), 'the approval is single-use', 'no rename proposal');
  // the batch finds a task by ID whatever its file name is
  mk('todo', 'T-8', 'Plain', 'T-8-plain'); gOk(dir, ['add', '-A']); gOk(dir, ['commit', '-qm', 'more']);
  const p2 = BP(F, dir, ['T-1', 'T-8']);
  assert.equal(p2.status, 0, `batch-plan does not find <ID>-<slug>.md files: ${p2.text}`);
  // the task type is an input of the pre-flight: a bug without its reproduction steps is asked about, a typeless task is a feature
  put(`${dir}/.agents/tasks/todo/B-1-crash.md`, '# Task: B-1 — Crash\n\n---\ntype: bug\n---\n\n## Goal\n\nIt works.\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Suggested class\n\nSTANDARD\n');
  gOk(dir, ['add', '-A']); gOk(dir, ['commit', '-qm', 'bug']);
  assert.equal(BP(F, dir, ['T-8', 'B-1']).status, 0);
  const sum = summaryOf(dir);
  assert.match(sum, /\[B-1, type\].*Reproduction steps/, 'a bug without reproduction steps raised no type question');
  assert.ok(!sum.includes('[T-8'), 'a typeless task raised a question');
});

test('the pre-flight asks about recorded findings no run covered and that are not listed; the expected list is one accept decision (sc_known_issues_preflight)', () => {
  const F = fakes(); const dir = bnew();
  mkdirSync(`${dir}/.agents/tasks/todo`, { recursive: true }); mkdirSync(`${dir}/docs`, { recursive: true });
  binstall(dir, { remote: false });
  put(`${dir}/.agents/tasks/todo/T-1.md`, '# Task: T-1 — Plain\n\n## Goal\n\nIt works.\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Suggested class\n\nSTANDARD\n');
  put(`${dir}/docs/old.md`, 'old\n'); gOk(dir, ['add', '-A']); gOk(dir, ['commit', '-qm', 'files']);
  // an earlier run of this machine that recorded a blocking finding in a file its frozen scope did not cover; and one that did cover it
  for (const r of ['R-1', 'R-2']) mkdirSync(`${dir}/.agents/runs/${r}/gates`, { recursive: true });
  put(`${dir}/.agents/runs/R-1/RUN.yaml`, 'freeze:\n  scope_paths: "src/a.txt"\n'); put(`${dir}/.agents/runs/R-2/RUN.yaml`, 'freeze:\n  scope_paths: "docs/old.md"\n');
  for (const r of ['R-1', 'R-2']) put(`${dir}/.agents/runs/${r}/gates/001-QA.yaml`, `task_id: "${r}"\ngate: "QA"\nresult: "fail"\nfocus: "-"\nfinding: QA-1|blocking|docs/old.md:3|the old page drops a section|traced\n`);
  const r = BP(F, dir, ['T-1']);
  assert.equal(r.status, 0, r.text);
  const sum = summaryOf(dir);
  assert.match(sum, /\[R-1, known\].*QA-1.*docs\/old\.md:3/, 'the finding of a run that did not cover the place raised no question');
  assert.ok(!sum.includes('[R-2, known]'), 'a run whose scope covered the place raised a question');
  assert.ok(sum.includes('approve known issue'));
  assert.match(sum, /^## Expected known issues and rationales/m);
  assert.ok(lines(`${bdir(dir)}/SUMMARY.md`).includes('- accept K QA docs/old.md:3: the old page drops a section'), 'the expected finding is not listed as an accept line');
  assert.ok(sum.includes('[batch, accept]'));
  const acc = lines(`${bdir(dir)}/lint.tsv`).map((l) => l.split('\t')).filter((f) => f[2] === 'accept');
  assert.equal(acc.length, 1); assert.equal(acc[0][5], 'a', 'the accept question recommends a (no)');
  assert.ok(sum.includes('SECRETS and SECURITY'));
});

test('batch.ci_* keys of the removed driver are ignored, the live ones still checked (sc_config_ignored_keys)', () => {
  const F = fakes(); const dir = bnew();
  binstall(dir, { remote: false });
  cfgBatch(dir, 40, ['  task_timeout: soon', '  runtimes: nothing']);
  assert.equal(AB(F, dir, ['config-check']).status, 0);
  cfgBatch(dir, 40, ['  ci_appear_minutes: 0']);
  refused(AB(F, dir, ['config-check']), 'batch.ci_appear_minutes: 0', 'ci_appear_minutes must be at least 1');
  cfgBatch(dir, 40, ['  frobnicate: 1']);
  refused(AB(F, dir, ['config-check']), 'an unknown batch key', 'unknown batch key');
});
