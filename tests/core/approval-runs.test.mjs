// @ts-check
// Several runs wait for an approval (A350, issue 338 B1): an answered request file does not count as waiting, and with several runs really waiting a reply that
// names the run ("approve scope W-2", "approve scope W-1 W-3") approves exactly the runs it names, while an unknown extra word, a run it does not name and
// an unnamed reply approve nothing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, AB, bnew, binstall, fakes, mktask, path, put, readIf, real, repo, wtp } from './batch-lib.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { textHasApproval } from '../../control-plane/agents/scripts/core/approvals.mjs';
import { recordsAge } from '../enforcement/enforcement-a-lib.mjs';

const PLAN_X = '---\nscope:\n  - path: x.txt\n    criteria: [AC-1]\n---\n# Plan\n';
/** The prompt hook of the main tree, as the runtime runs it. @param {string} main @param {string} prompt */
function hook(main, prompt) {
  const ev = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: main, prompt });
  const r = spawnSync('node', [path.join(repo, 'adapters/claude/hooks/proofline-hook.mjs'), 'prompt', 'claude'], {
    input: ev, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: 'C', CLAUDE_PROJECT_DIR: main, PROOFLINE_NO_TTY: '1', PROOFLINE_HOOK_APPROVE_BUDGET: '120', PROOFLINE_HOOK_LOCK_WAIT: '60',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@example.invalid' },
  });
  return r.stdout + r.stderr;
}
const older = (/** @type {string[]} */ ...dirs) => { for (const d of dirs) recordsAge(d, 2); };
const approved = (/** @type {string} */ w, /** @type {string} */ r) => { try { return readdirSync(`${w}/.agents/runs/${r}/approvals`).some((n) => /^[0-9]{3}-scope\.yaml$/.test(n)); } catch { return false; } };

/** @param {string[]} ids */
function waiting(ids) {
  const F = fakes(); const dir = bnew();
  for (const id of ids) mktask(dir, id, 'COMPLEX');
  binstall(dir, { remote: false });
  for (const r of ids) {
    const w = AB(F, dir, ['worktree-add', r]).out.trim();
    assert.equal(A(w, ['start', r, '--task-file', `.agents/tasks/${r}.md`]).status, 0, `start ${r}`);
    put(`${w}/.agents/runs/${r}/PLAN.md`, PLAN_X);
    assert.equal(A(w, ['request-approval', r, 'scope']).status, 0);
  }
  return { dir, main: real(dir), wts: ids.map((r) => wtp(dir, r)) };
}

test('an answered request does not count as waiting: the one run really waiting needs no name', () => {
  const { main, wts } = waiting(['W-1', 'W-2']);
  older(...wts, main); hook(main, 'i approve the scope for W-2');
  assert.ok(approved(wts[1], 'W-2') && !approved(wts[0], 'W-1'));
  older(...wts, main); const out = hook(main, 'approve scope');
  assert.ok(approved(wts[0], 'W-1'), `W-2's answered request still counted as waiting: ${out}`);
  assert.ok(!out.includes('say which run you approve'), `the hook still asked for a name: ${out}`);
});

test('with several runs waiting a reply that names the run (and only known run names) approves exactly that run', () => {
  const { main, wts } = waiting(['W-1', 'W-2']);
  older(...wts, main); let out = hook(main, 'approve scope');
  assert.ok(!approved(wts[0], 'W-1') && !approved(wts[1], 'W-2'), 'an unnamed reply approved a run');
  assert.ok(out.includes('say which run you approve'), out);
  older(...wts, main); out = hook(main, 'approve scope W-2 and the rest');
  assert.ok(!approved(wts[0], 'W-1') && !approved(wts[1], 'W-2'), 'an unknown word beside the run name was accepted');
  older(...wts, main); out = hook(main, 'approve scope W-2');
  assert.ok(approved(wts[1], 'W-2'), `approve scope W-2 did not approve W-2: ${out}`);
  assert.ok(!approved(wts[0], 'W-1'), 'the reply naming W-2 approved W-1');
});

test('a reply may name several runs after the kind word; each named run is approved', () => {
  const { main, wts } = waiting(['W-1', 'W-2', 'W-3']);
  older(...wts, main); const out = hook(main, 'approve scope W-1 W-3');
  assert.ok(approved(wts[0], 'W-1') && approved(wts[2], 'W-3'), `the named runs were not approved: ${out}`);
  assert.ok(!approved(wts[1], 'W-2'), 'a run the reply does not name was approved');
});

test('a run is named as a whole word: with W-1 and W-10 waiting, "approve scope W-10" approves W-10 and never starts the approval step of W-1', () => {
  const { dir, main, wts } = waiting(['W-1', 'W-10']);
  older(...wts, main); const out = hook(main, 'approve scope W-10');
  assert.ok(approved(wts[1], 'W-10'), `W-10 was not approved: ${out}`);
  assert.ok(!approved(wts[0], 'W-1'), 'W-1 was approved by a reply that names W-10');
  // the hook ran only the run the reply names: a substring match would have started the approval step of W-1 too (the core refuses it, but the step ran and logged)
  const log = readIf(`${dir}/.agents/local/approve.log`);
  assert.ok(log.includes('target=W-10 '), `no line for W-10: ${log}`);
  assert.ok(!log.includes('target=W-1 '), `the approval step of W-1 ran for a reply that names W-10: ${log}`);
});

// ---- which words are run names (A350 round 2): a structural rule, not a word list ------------------------------------------------------------------------------------------
const CAPTURE = { session: 's1', time: 1700000001, sha256: 'ab'.repeat(32) };
const CAPTURE_ID = `${CAPTURE.session}:${CAPTURE.time}:${CAPTURE.sha256}`;
const REQ = 'kind: "scope"\nbound: "x"\nrequested_at: 1000\n';
/** A project folder and a context for it; the run folders are written by the test (what an agent can do). */
function names() {
  const d = real(bnew());
  const ctx = new Context({ env: { ...process.env }, cwd: d, stdout: { write() {} }, stderr: { write() {} }, promptCapture: CAPTURE }, `${d}/.agents/scripts/agent.sh`);
  /** @param {string} id @param {{ run?: boolean, request?: boolean, files?: Record<string, string> }} [o] */
  const folder = (id, o = {}) => {
    const ad = `${d}/.agents/runs/${id}/approvals`;
    mkdirSync(ad, { recursive: true });
    if (o.run) writeFileSync(`${d}/.agents/runs/${id}/RUN.yaml`, `task:\n  id: ${id}\nexecution:\n  state: IMPLEMENTING\n`);
    if (o.request !== false) writeFileSync(`${ad}/001-request-scope.yaml`, REQ);
    for (const [n, t] of Object.entries(o.files ?? {})) writeFileSync(`${ad}/${n}`, t);
  };
  const ok = (/** @type {string} */ msg, /** @type {string} */ id) => textHasApproval(ctx, Buffer.from(msg, 'utf8').toString('latin1'), 'scope', id);
  return { folder, ok };
}
const HEDGE_WORDS = 'nothing nobody none nor neither didnt doesnt wouldnt couldnt havent hasnt wasnt arent aint dun nay later skip postpone defer pending nein non nicht nunca never not dont no do n0t not- no_ cant wont isnt maybe wait hayir degil'.split(' ');

test('a word is never a run name because a folder carries it: agent-made folders with open requests for any word approve nothing, whatever the word', () => {
  const { folder, ok } = names();
  folder('W-1', { run: true });
  for (const w of HEDGE_WORDS) folder(w);                         // no RUN.yaml: not a run at all
  for (const w of ['nothing', 'skip', 'never']) folder(`${w}`, { run: true });   // a RUN.yaml too: still no digit in the id, so still an ordinary word
  for (const w of HEDGE_WORDS) {
    assert.equal(ok(`${w} approve scope W-1`, 'W-1'), false, `'${w} approve scope W-1' approved`);
    assert.equal(ok(`approve scope ${w} W-1`, 'W-1'), false, `'approve scope ${w} W-1' approved`);
  }
  assert.equal(ok('never approve the scope W-1', 'W-1'), false);
  assert.equal(ok('do not approve scope W-1', 'W-1'), false);
  assert.equal(ok('approve scope W-1', 'W-1'), true, 'the plain reply that names the run is refused');
});

test('a forged record makes no run: a record with the capture id in a hedge-named folder, or a run without the control plane\'s RUN.yaml or request', () => {
  const { folder, ok } = names();
  folder('W-1', { run: true });
  const forged = `kind: "scope"\nanswered_by: "user"\nsource: "prompt_capture"\ncapture_id: "${CAPTURE_ID}"\n`;
  folder('skip', { request: false, files: { '002-x.yaml': forged } });
  folder('ghost-1', { request: false, files: { '002-x.yaml': forged } });                        // a digit in the id, but no RUN.yaml
  folder('ghost-2', { run: true, request: false, files: { '002-x.yaml': forged } });             // RUN.yaml, but the record names no valid request and has a wrong file name
  folder('ghost-3', { run: true, request: false, files: { '002-scope.yaml': forged.replace('answered_by: "user"', 'answered_by: "lead"') } });
  folder('ghost-4', { run: false });                                                              // a valid request, no RUN.yaml
  for (const w of ['skip', 'ghost-1', 'ghost-2', 'ghost-3', 'ghost-4']) assert.equal(ok(`approve scope ${w} W-1`, 'W-1'), false, `a forged folder '${w}' became a run name`);
  // the positive: a run the control plane made, with a valid request and a record of THIS message
  const good = `kind: "scope"\nrequest: "001-request-scope.yaml"\nanswered_by: "user"\nsource: "prompt_capture"\ncapture_id: "${CAPTURE_ID}"\n`;
  folder('W-2', { run: true, files: { '002-scope.yaml': good } });
  assert.equal(ok('approve scope W-1 W-2', 'W-1'), true, 'a real run approved by this message is not a name');
});

test('run ids with digits are names when the run is real and waits: W-1 and W-10, and a reply that names other runs and not this one approves nothing', () => {
  const { folder, ok } = names();
  folder('W-1', { run: true }); folder('W-10', { run: true }); folder('TASK-004', { run: true }); folder('TASK-010', { run: true });
  assert.equal(ok('approve scope W-1 W-10', 'W-1'), true);
  assert.equal(ok('approve scope TASK-004 TASK-010', 'TASK-010'), true);
  assert.equal(ok('approve scope W-10', 'W-1'), false, 'a reply that names W-10 approved W-1');
  assert.equal(ok('approve scope W-1 W-99', 'W-1'), false, 'an unknown run id was accepted');
});
