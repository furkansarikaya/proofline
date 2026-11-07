// @ts-check
// The state of a batch (A157, A169, A180, A181, A200, A225): the lead is played by the test (fake run, fake deliver) and acts on what `batch-next` says. These are the
// scenarios of the former batch-test.sh that prove the digest, the order of the tasks, the parks, the restart, the morning table, the CI of the merge commit, the
// sleep inhibitor, the one-session owner and the recovery from the platform. The exact texts are held by batch-golden.test.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  A, AB, appendFileSync, batchApprove, behave, bnew, binstall, cfgBatch, drive, fakeDeliver, fakeRun, fakes, g, gOk, has, lines, mktask, nextline, orderIds, put, read, readIf, rmSync, sh, summaryOf, writeFileSync, wtp, mkdirSync, path,
} from './batch-lib.mjs';

const bdir = (/** @type {string} */ dir) => `${dir}/.agents/local/batch`;
const BP = (/** @type {ReturnType<typeof fakes>} */ F, /** @type {string} */ dir, /** @type {string[]} */ args) => AB(F, dir, ['batch-plan', ...args]);
const nx = (/** @type {ReturnType<typeof fakes>} */ F, /** @type {string} */ dir, /** @type {string[]} */ a = []) => AB(F, dir, ['batch-next', ...a]).out;
const sha = (/** @type {string} */ f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const first2 = (/** @type {string} */ s) => s.split(' ').slice(0, 2).join(' ');
const sleep = (/** @type {number} */ ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Wait until the check holds (at most 5 s). @param {() => boolean} fn */
function until(fn) { for (let i = 0; i < 50; i++) { if (fn()) return true; sleep(100); } return false; }
/** A stand-in for the session process: it belongs to no parent that could leave it as a zombie. */
function session() {
  const r = spawnSync('sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
  const pid = Number(r.stdout.trim());
  return { pid, kill() { try { process.kill(pid); } catch { /* gone */ } } };
}

test('two tasks finish one after the other: run, deliver, CI check, then the next; a dependant waits for the merge (sc_sequential)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX', 'T-1'); binstall(dir);
  BP(F, dir, ['all']); batchApprove(dir);
  assert.equal(nextline(F, dir), 'run T-1   (agent.sh worktree-add T-1, then /proofline run T-1 with .agents/local/worktrees/T-1 as the working folder)');
  fakeRun(F, dir, 'T-1');
  assert.equal(first2(nextline(F, dir)), 'deliver T-1', 'after the run of T-1 the next action is its delivery');
  assert.match(nx(F, dir), /^T-2 \| waiting \| depends on T-1 \(not merged yet\)/m, 'T-2 does not wait for the merge of T-1');
  fakeDeliver(F, dir, 'T-1');
  assert.equal(first2(nextline(F, dir)), 'ci T-1', 'after the merge the CI of the merge commit comes first');
  const ci = AB(F, dir, ['batch-ci', 'T-1']);
  assert.equal(ci.status, 0, ci.text);
  assert.equal(first2(nextline(F, dir)), 'run T-2');
  drive(F, dir);
  assert.equal(F.calls(), 'run T-1 deliver T-1 run T-2 deliver T-2', 'the tasks did not run one after the other');
  assert.equal(nx(F, dir, ['--tsv']).split('\n')[0], 'state\tfinished-clean');
  assert.equal(lines(`${bdir(dir)}/merged.tsv`).map((l) => l.split('\t')[0]).join(' '), 'T-1 T-2');
  assert.ok(!has(`${dir}/.agents/local/worktrees/T-1`) && !has(`${dir}/.agents/local/worktrees/T-2`), 'a merged task kept its worktree');
});

test('a parked task skips its dependant, an independent task goes on; every task has a worktree of its own and the main tree stays clean (sc_park_skip_continue)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX', 'T-1'); mktask(dir, 'T-3', 'COMPLEX'); mktask(dir, 'T-4', 'COMPLEX'); binstall(dir);
  BP(F, dir, ['all']); batchApprove(dir);
  behave(F, 'T-1', 'question'); behave(F, 'T-4', 'await');
  drive(F, dir);
  assert.equal(F.calls(), 'run T-1 run T-3 deliver T-3 run T-4 deliver T-4', 'a parked task and one waiting for merge must not block the independent T-3, and the dependent T-2 must not start');
  const tsv = nx(F, dir, ['--tsv']).replace(/\t/g, ' ');
  for (const w of ['T-1 parked question', 'T-2 skipped depends on T-1 (parked)', 'T-3 merged', 'T-4 parked awaiting merge']) assert.ok(tsv.split('\n').some((l) => l.startsWith(w)), `batch-next --tsv lacks '${w}': ${tsv}`);
  assert.ok(tsv.includes('Which cache'), 'the pending question is not in the digest');
  assert.equal(tsv.split('\n')[0], 'state finished-parked');
  // the main working tree: clean, the task files where they were, no run, no open run
  assert.equal(g(dir, ['status', '--porcelain']), '', 'the main working tree is dirty');
  assert.ok(has(`${dir}/.agents/tasks/T-1.md`) && has(`${dir}/.agents/tasks/T-4.md`) && !has(`${dir}/.agents/tasks/in-progress`), 'a task file moved in the main working tree');
  assert.ok(!has(`${dir}/.agents/runs`) || readdirSync(`${dir}/.agents/runs`).length === 0, 'the main working tree holds a run');
  assert.equal(A(dir, ['open-runs']).out.trim(), '');
  assert.equal(g(dir, ['branch', '--show-current']), 'main', 'the batch left main');
  // the parked and the waiting task keep their worktree and their run; the merged one is gone, the skipped one never had one
  assert.ok(has(`${dir}/.agents/local/worktrees/T-1/.agents/runs/T-1`) && has(`${dir}/.agents/local/worktrees/T-4/.agents/runs/T-4`), 'a parked or waiting task lost its worktree');
  assert.ok(!has(`${dir}/.agents/local/worktrees/T-3`) && !has(`${dir}/.agents/local/worktrees/T-2`), 'worktree of the merged T-3 left, or one made for the never-started T-2');
  assert.equal(A(wtp(dir, 'T-1'), ['open-runs']).out.trim(), 'T-1 -');
  assert.match(A(dir, ['questions', 'T-1']).out, /Which cache/, 'questions for a run in a worktree are not forwarded from the main tree');
  // the dependant waits for the merge: T-1 gets its answer and merges in the SAME worktree, then T-2 runs, not before
  put(`${dir}/.agents/local/worktrees/T-1/.agents/runs/T-1/questions/001.answer.md`, 'a\n');
  behave(F, 'T-1', 'merge'); writeFileSync(`${F.FAKE}/calls.log`, '');
  assert.match(nx(F, dir), /^NEXT: resume T-1/m, 'after the answer the parked T-1 is resumed');
  drive(F, dir);
  assert.equal(F.calls(), 'resume T-1 deliver T-1 run T-2 deliver T-2', 'second pass: T-1 resumes and merges, only then T-2 starts, T-3 is not run again');
  assert.ok(!has(`${dir}/.agents/local/worktrees/T-1`) && !has(`${dir}/.agents/local/worktrees/T-2`), 'worktrees of merged tasks left');
  assert.ok(has(`${dir}/.agents/local/worktrees/T-4`), 'the worktree of the task awaiting its merge was removed');
});

test('an interruption: the same approved batch continues where it stopped and never runs a merged task again (sc_restart)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX'); mktask(dir, 'T-3', 'COMPLEX'); binstall(dir);
  BP(F, dir, ['all']); batchApprove(dir);
  const h1 = sha(`${bdir(dir)}/SUMMARY.md`);
  drive(F, dir, 4); // run T-1, deliver T-1, CI T-1, run T-2: the session ends here (closed, limit, sleep)
  assert.equal(F.calls(), 'run T-1 deliver T-1 run T-2');
  assert.equal(first2(nextline(F, dir)), 'deliver T-2', 'after the interruption the half-done T-2 is delivered, not run again');
  const again = BP(F, dir, ['T-1', 'T-2', 'T-3']);
  assert.equal(again.status, 0, again.text);
  assert.ok(again.text.includes('is approved and not finished: continuing it') && /^NEXT: deliver T-2/m.test(again.text), 'batch-plan of the same batch did not continue it');
  assert.equal(sha(`${bdir(dir)}/SUMMARY.md`), h1, 'continuing the batch wrote a new summary');
  assert.equal(readdirSync(`${dir}/.agents/local/approvals`).filter((n) => /request-batch/.test(n)).length, 1, 'continuing the batch asked a new approval');
  drive(F, dir);
  assert.equal(F.calls(), 'run T-1 deliver T-1 run T-2 deliver T-2 run T-3 deliver T-3');
  // finished: the same words plan a new batch (the old one goes to history)
  const re = BP(F, dir, ['T-1', 'T-2', 'T-3']);
  assert.equal(re.status, 0, re.text);
  assert.notEqual(sha(`${bdir(dir)}/SUMMARY.md`), h1);
  assert.ok(has(`${bdir(dir)}/history`) && !(has(`${bdir(dir)}/merged.tsv`) && statSync(`${bdir(dir)}/merged.tsv`).size > 0), 'a finished batch was not archived by the next plan');
});

test('the morning report comes from the records only; an answered question un-parks; batch-next writes nothing but the owner claim (sc_status_from_records)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX'); mktask(dir, 'T-3', 'COMPLEX', 'T-2'); mktask(dir, 'T-4', 'COMPLEX'); binstall(dir);
  BP(F, dir, ['all']); batchApprove(dir);
  behave(F, 'T-2', 'question');
  assert.equal(AB(F, dir, ['batch-park', 'T-4', 'reason-xyz-from-the-lead']).status, 0);
  drive(F, dir);
  assert.equal(F.calls(), 'run T-1 deliver T-1 run T-2', "the lead's own park of T-4 did not keep it out");
  const status = () => AB(F, dir, ['batch-status']).out;
  const row = (/** @type {string} */ out, /** @type {string} */ id) => out.split('\n').find((l) => l.startsWith(`${id} |`)) ?? '';
  let st = status();
  assert.ok(/merged/.test(row(st, 'T-1')) && row(st, 'T-1').includes('101'), `T-1 row: ${row(st, 'T-1')}`);
  assert.ok(row(st, 'T-2').includes('PARKED') && row(st, 'T-2').includes('Which cache'));
  assert.ok(row(st, 'T-3').includes('skipped'));
  assert.match(st, /no friction report/i); assert.ok(!/driver/i.test(st));
  assert.equal(AB(F, dir, ['batch-status']).status, 0);
  // change the records: the table changes
  writeFileSync(`${bdir(dir)}/merged.tsv`, read(`${bdir(dir)}/merged.tsv`).split('\n').map((l) => (l.startsWith('T-1\t') ? l.split('\t').map((x, i) => (i === 1 ? '777' : x)).join('\t') : l)).join('\n'));
  st = status();
  assert.ok(row(st, 'T-1').includes('777') && !row(st, 'T-1').includes('101'), `merged.tsv edit not reflected: ${row(st, 'T-1')}`);
  assert.ok(row(st, 'T-4').includes('PARKED') && row(st, 'T-4').includes('reason-xyz-from-the-lead'), 'state.tsv park not reflected');
  AB(F, dir, ['batch-park', 'T-4', '--clear']);
  assert.ok(row(status(), 'T-4').includes('pending'), 'a cleared park is still shown');
  put(`${dir}/.agents/local/worktrees/T-2/.agents/runs/T-2/questions/001.answer.md`, '1\n'); // the user answered: the pending question is gone
  st = status();
  assert.ok(!row(st, 'T-2').includes('Which cache'), 'an answered question is still shown as pending');
  assert.ok(row(st, 'T-2').includes('pending'), 'an answered task is not pending again');
  // batch-next reads and never writes
  const snap = () => readdirSync(bdir(dir)).filter((n) => n !== 'owner' && n !== 'history').sort().map((n) => `${n}:${sha(`${bdir(dir)}/${n}`)}`).join(' ');
  const before = snap();
  nx(F, dir); nx(F, dir, ['--tsv']);
  assert.equal(snap(), before, 'batch-next wrote something besides the owner claim');
  // batch-park refuses what it cannot park; a reviewer cannot park or answer
  assert.notEqual(AB(F, dir, ['batch-park', 'T-9', 'x']).status, 0);
  assert.notEqual(AB(F, dir, ['batch-park', 'T-4']).status, 0);
  assert.match(AB(F, dir, ['batch-park', 'T-4', 'x'], { role: 'reviewer' }).text, /command denied for reviewer/);
});

test('the CI that gates the next task is the one of the merge commit: red, running, no run yet, green (sc_merge_commit_ci)', () => {
  const F = fakes(); const dir = bnew();
  const MSHA = '0123456789abcdef0123456789abcdef01234567';
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX'); cfgBatch(dir, 40, ['  ci_appear_minutes: 1']); binstall(dir);
  BP(F, dir, ['all']); batchApprove(dir);
  drive(F, dir, 2); // run T-1, deliver T-1
  gOk(dir, ['remote', 'set-url', 'origin', 'https://github.com/acme/app.git']); // a GitHub project: the CI of a merge commit is read through gh
  const ci = () => AB(F, dir, ['batch-ci', 'T-1']);
  const setRun = (/** @type {string} */ t) => { rmSync(`${F.FAKE}/ci/${MSHA}.none`, { force: true }); writeFileSync(`${F.FAKE}/ci/${MSHA}`, t); };
  setRun('[{"status":"completed","conclusion":"failure"}]\n');
  let r = ci();
  assert.equal(r.status, 1, r.text); assert.ok(r.out.includes('RED (run of 0123456)'));
  assert.equal(first2(nextline(F, dir)), 'ci T-1', 'a red CI must keep the batch at the CI check');
  setRun('[{"status":"in_progress","conclusion":""},{"status":"completed","conclusion":"failure"}]\n');
  assert.equal(ci().status, 1, 'red + running');
  setRun('[{"status":"in_progress","conclusion":""}]\n');
  r = ci(); assert.equal(r.status, 2, r.text);
  rmSync(`${F.FAKE}/ci/${MSHA}`, { force: true }); writeFileSync(`${F.FAKE}/ci/${MSHA}.none`, '');
  r = ci(); assert.equal(r.status, 4, r.text); assert.ok(r.out.includes('no run for 0123456 yet'));
  assert.equal(first2(nextline(F, dir)), 'ci T-1', 'no CI run yet must keep the batch at the CI check');
  rmSync(`${F.FAKE}/ci/${MSHA}.none`, { force: true }); setRun('[{"status":"completed","conclusion":"success"}]\n');
  r = ci(); assert.equal(r.status, 0, r.text); assert.ok(r.out.includes('green'));
  assert.equal(first2(nextline(F, dir)), 'run T-2', 'after a green CI the next task is T-2');
});

test('the sleep inhibitor belongs to the session: caffeinate -i -w <pid> once and gone with the session; systemd-inhibit; none said plainly (sc_awake)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); binstall(dir, { remote: false });
  BP(F, dir, ['all']); batchApprove(dir);
  const awake = (/** @type {number} */ pid, /** @type {Record<string, string>} */ env) => AB(F, dir, ['batch-awake'], { env: { PROOFLINE_SESSION_PID: String(pid), ...env } });
  const caff = `${F.FAKE}/caffeinate.argv`;
  let s = session();
  const pid = /** @type {number} */ (s.pid);
  const a = awake(pid, { PROOFLINE_UNAME: 'Darwin' });
  assert.equal(a.status, 0, a.text);
  assert.ok(a.text.includes(`caffeinate -i -w ${pid}`) && a.text.includes('Keep the computer awake'), a.text);
  assert.ok(until(() => has(caff) && statSync(caff).size > 0), 'caffeinate was not started');
  assert.equal(read(caff).trim(), `-i -w ${pid}`);
  awake(pid, { PROOFLINE_UNAME: 'Darwin' });
  assert.equal(lines(caff).length, 1, 'a second batch-awake started a second inhibitor');
  assert.match(AB(F, dir, ['batch-status']).out, new RegExp(`^sleep inhibitor: caffeinate -i -w ${pid}`, 'm'));
  const cpid = Number(read(`${F.FAKE}/caffeinate.pid`).trim());
  process.kill(cpid, 0);
  s.kill();
  assert.ok(until(() => { try { process.kill(cpid, 0); return false; } catch { return true; } }), 'caffeinate outlived the session it is tied to');
  assert.match(AB(F, dir, ['batch-status']).out, /^awake: the sleep inhibitor ended/m);
  s = session();
  const l = awake(/** @type {number} */ (s.pid), { PROOFLINE_UNAME: 'Linux' });
  assert.equal(l.status, 0, l.text);
  assert.ok(until(() => has(`${F.FAKE}/inhibit.argv`) && statSync(`${F.FAKE}/inhibit.argv`).size > 0), 'systemd-inhibit was not started');
  assert.ok(read(`${F.FAKE}/inhibit.argv`).includes('--what=idle:sleep'));
  s.kill();
  rmSync(caff, { force: true }); rmSync(`${F.FAKE}/inhibit.argv`, { force: true });
  s = session();
  const n = awake(/** @type {number} */ (s.pid), { PROOFLINE_UNAME: 'Linux', PROOFLINE_BATCH_INHIBIT: 'none' });
  s.kill();
  assert.equal(n.status, 0, n.text);
  assert.match(n.out, /sleep inhibitor: none available.*the machine may sleep/);
  assert.ok(!has(caff) && !has(`${F.FAKE}/inhibit.argv`), 'an inhibitor was started although none is available');
  // the seams act only with PROOFLINE_TEST=1: a session pid typed by a caller is ignored without it
  s = session();
  const plain = A(dir, ['batch-awake'], { env: { PROOFLINE_SESSION_PID: String(s.pid), PROOFLINE_UNAME: 'Darwin', PATH: F.env.PATH } });
  s.kill();
  assert.ok(!plain.text.includes(`-w ${s.pid}`), `the session pid seam acted without PROOFLINE_TEST: ${plain.text}`);
});

test('one session works a batch: a live owner makes the others wait with its pid, a dead one is taken over, only the lead claims (sc_owner_guard)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX'); binstall(dir);
  BP(F, dir, ['all']); batchApprove(dir);
  const s1 = session(); const s2 = session(); const s3 = session();
  const as = (/** @type {{ pid: number, kill(): void }} */ s, /** @type {string[]} */ args = ['batch-next'], /** @type {string | undefined} */ role = undefined) => AB(F, dir, args, { role, env: { PROOFLINE_SESSION_PID: String(s.pid) } });
  try {
    assert.match(as(s1).out, /^NEXT: run T-1/m, 'the first session did not get the batch');
    const o = as(s2).out;
    assert.ok(o.includes(`NEXT: wait (owned by pid ${s1.pid})`), `a second live session was not told to wait: ${o}`);
    assert.match(as(s1).out, /^NEXT: run T-1/m, 'the owner itself is told to wait');
    s1.kill(); assert.ok(until(() => { try { process.kill(/** @type {number} */ (s1.pid), 0); return false; } catch { return true; } }));
    assert.match(as(s2).out, /^NEXT: run T-1/m, 'a dead owner was not taken over');
    assert.equal(read(`${bdir(dir)}/owner`).split('\t')[0], String(s2.pid));
    // a specialist role neither claims nor takes over: the command allow-list denies it
    const own = read(`${bdir(dir)}/owner`);
    assert.match(as(s3, ['batch-next'], 'reviewer').text, /command denied for reviewer/);
    assert.equal(read(`${bdir(dir)}/owner`), own, 'a non-lead caller claimed the batch');
    s2.kill(); assert.ok(until(() => { try { process.kill(/** @type {number} */ (s2.pid), 0); return false; } catch { return true; } }));
    assert.match(as(s3).out, /^NEXT: run T-1/m);
    assert.equal(read(`${bdir(dir)}/owner`).split('\t')[0], String(s3.pid));
  } finally { for (const s of [s1, s2, s3]) s.kill(); }
});

test('a pull request file without a merged.tsv record asks the platform: merged -> cleanup step, open -> parked, unreadable -> parked and says so (sc_pr_recovery)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX', 'T-1'); binstall(dir);
  BP(F, dir, ['all']); batchApprove(dir);
  behave(F, 'T-1', 'await');
  drive(F, dir);
  const tsv = () => nx(F, dir, ['--tsv']).replace(/\t/g, ' ');
  assert.match(tsv(), /^T-1 parked awaiting merge pull request 77: its state cannot be read/m, 'a PR whose state cannot be read must say so');
  gOk(dir, ['remote', 'set-url', 'origin', 'https://github.com/acme/app.git']);
  writeFileSync(`${F.FAKE}/prview`, 'OPEN false aaa b main o\n');
  assert.match(tsv(), /^T-1 parked awaiting merge pull request 77 is open/m, 'an open PR keeps the task parked');
  writeFileSync(`${F.FAKE}/prview`, 'MERGED false aaa b main o\n');
  assert.match(nx(F, dir), /^NEXT: deliver T-1 cleanup 77/m, 'a merged PR without a record must lead to the cleanup step');
  assert.ok(!has(`${bdir(dir)}/merged.tsv`) || statSync(`${bdir(dir)}/merged.tsv`).size === 0, 'batch-next recorded a merge itself');
});

test('a task whose branch waits for the user\'s merge on a local origin: git says when it was merged, then the batch moves on (sc_manual_merge_batch)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX'); binstall(dir);
  BP(F, dir, ['all']); batchApprove(dir);
  fakeRun(F, dir, 'T-1');
  const wt = wtp(dir, 'T-1');
  // the delivered commit as the pr step of a manual platform leaves it: a branch on origin and deliver/<ID>/MERGE_HEAD
  gOk(wt, ['checkout', '-q', '-b', 'proofline/T-1-x']); writeFileSync(`${wt}/delivered.txt`, 'delivered\n');
  gOk(wt, ['add', 'delivered.txt']); gOk(wt, ['commit', '-qm', 'feat: delivered']);
  gOk(wt, ['push', '-q', 'origin', 'proofline/T-1-x']);
  const head = g(wt, ['rev-parse', 'HEAD']);
  put(`${wt}/.agents/local/deliver/T-1/MERGE_HEAD`, `${head}\tmain\tproofline/T-1-x\n`);
  // the proof reads origin and the delivered head from the summary the user approved: a summary that pins the origin and an approval bound to its hash
  put(`${wt}/.agents/local/deliver/T-1/SUMMARY.md`, `merge_by: user\nhead: ${head}\nbase: main\nbranch: proofline/T-1-x\norigin_url: ${g(wt, ['remote', 'get-url', 'origin'])}\norigin_effective: ${g(wt, ['ls-remote', '--get-url', 'origin'])}\n`);
  put(`${wt}/.agents/runs/T-1/approvals/001-push.yaml`, `kind: push\ndelivery: ${sha(`${wt}/.agents/local/deliver/T-1/SUMMARY.md`)}\nconsumed: true\n`);
  let out = nx(F, dir);
  assert.ok(out.includes('awaiting merge'), `batch-next does not say the task awaits the user's merge: ${out}`);
  assert.ok(out.includes('YOUR merge into origin') && /^NEXT: run T-2/m.test(out), 'an unmerged task blocked the batch or lacks the instruction');
  assert.ok(!has(`${bdir(dir)}/merged.tsv`) || statSync(`${bdir(dir)}/merged.tsv`).size === 0, 'batch-next recorded a merge nobody made');
  // the user merges on origin (a fast-forward of main): git proves it, batch-next offers the proof step
  gOk(wt, ['push', '-q', 'origin', 'proofline/T-1-x:main']);
  assert.match(nx(F, dir), /^NEXT: deliver T-1 merged/m);
  // the proof records the merge (before the cleanup); the batch then moves on to T-2
  const dm = AB(F, dir, ['deliver-merged', 'T-1']);
  assert.ok(dm.text.includes('merge recorded for T-1: the delivered commit is on origin/main'), dm.text);
  assert.ok(read(`${bdir(dir)}/merged.tsv`).includes('T-1\t-\t'), 'no merge record for T-1');
  out = nx(F, dir);
  if (/^NEXT: ci T-1/m.test(out)) { assert.equal(AB(F, dir, ['batch-ci', 'T-1']).status, 0); out = nx(F, dir); }
  assert.ok(/^NEXT: run T-2/m.test(out) && !/T-1.*awaiting merge/.test(out), `the batch did not move on to T-2: ${out}`);
});

test('a hand-pushed delivery (the summary says the user merges, the branch is on origin, no MERGE_HEAD) waits for the merge and does not block the batch (sc_hand_pushed_batch)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX'); binstall(dir);
  BP(F, dir, ['all']); batchApprove(dir);
  fakeRun(F, dir, 'T-1'); const wt = wtp(dir, 'T-1');
  gOk(wt, ['checkout', '-q', '-b', 'proofline/T-1-x']); writeFileSync(`${wt}/d.txt`, 'd\n'); gOk(wt, ['add', 'd.txt']); gOk(wt, ['commit', '-qm', 'feat: d']);
  gOk(wt, ['push', '-q', 'origin', 'proofline/T-1-x']);
  put(`${wt}/.agents/local/deliver/T-1/SUMMARY.md`, `merge_by: user\nhead: ${g(wt, ['rev-parse', 'HEAD'])}\nbase: main\nbranch: proofline/T-1-x\n`);
  const out = nx(F, dir);
  assert.ok(out.includes('awaiting merge') && /^NEXT: run T-2/m.test(out), `a hand-pushed delivery is not awaiting merge: ${out}`);
});

test('a run in a batch whose approvals wait: cover is the next action for a plan and for the delivery steps; an unknown request parks the task', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); binstall(dir, { remote: false });
  BP(F, dir, ['all']); batchApprove(dir);
  fakeRun(F, dir, 'T-1');
  const wt = wtp(dir, 'T-1');
  const req = (/** @type {string} */ kind) => put(`${wt}/.agents/runs/T-1/approvals/001-request-${kind}.yaml`, `kind: "${kind}"\nbound: "x"\n`);
  req('plan');
  assert.match(nx(F, dir), /^NEXT: cover T-1 plan/m);
  rmSync(`${wt}/.agents/runs/T-1/approvals`, { recursive: true, force: true }); req('commit');
  assert.match(nx(F, dir), /^NEXT: cover T-1 delivery/m);
  rmSync(`${wt}/.agents/runs/T-1/approvals`, { recursive: true, force: true }); req('scope');
  assert.match(nx(F, dir), /^T-1 \| PARKED \| approval request \| scope/m);
  put(`${wt}/.agents/runs/T-1/approvals/002-scope.yaml`, 'kind: "scope"\n');
  assert.ok(!/PARKED \| approval request/.test(nx(F, dir)), 'an answered request still parks the task');
});
void appendFileSync; void mkdirSync; void path; void sh; void orderIds; void summaryOf; void readIf;
