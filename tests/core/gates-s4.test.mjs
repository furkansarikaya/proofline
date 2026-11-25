// @ts-check
// gates-test.sh scenarios sc_task_types .. sc_folded_defect (slice S4) as Node tests on the real control plane (tests/legacy-port-map.tsv): task types and the
// debug-proof result, scratch worktrees, the worktree lock folder, document-scope warnings, selective gate repetition after a fix round or an amend (Core
// invariants 1, 2, 5: a gate that must run again never carries over), scope kinds, summary and Human checks, visual rows, takeover without RED, defects.
import { removeAtExit, tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { A, AS, accepted, approveAsUser, expectMsg, gateStatus, git, must, passAll, refused, rec, repo, say, scaffold, solo, wclose, wev, wopen, writeReport } from '../lib/harness.mjs';
import { PARKED } from './event-lib.mjs';
import { gatesOf, implemented, kindClaim, passAllExtra, unfrozen, worker2 } from './gates-s4-lib.mjs';

const GL = 'test: lookup returns the stored value';
const IL = 'impl: lookup returns the stored value';
/** @param {string} dir @param {string} f */
const rd = (dir, f) => readFileSync(path.join(dir, f), 'utf8');
/** @param {string} dir @param {string} f @param {string} t */
const wr = (dir, f, t) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), t); };
/** RED then GREEN by the orchestrated worker. @param {string} dir */
const redGreen = (dir) => { worker2(dir, 'RED', 'fail', 'impl_test.txt', GL); worker2(dir, 'GREEN', 'pass', 'impl.txt', IL); };
/** @param {string} dir @param {string} what */
const handoffOk = (dir, what) => accepted(A(dir, ['handoff', 'LC', 'IMPLEMENTED']), what);
const NODEBUG = 'no debug-proof result';

test('sc_task_types: type bug asks for the debug-proof result and refuses TRIVIAL; a feature and a typeless task do not; content/docs exempt document paths, never code', () => {
  let d = scaffold({ taskFm: 'type: bug', cls: 'STANDARD' });
  redGreen(d);
  assert.equal(A(d, ['task-type', '.agents/runs/LC/TASK.md']).out.trim(), 'bug', 'task-type did not read type: bug');
  expectMsg('type: bug needs a debug-proof result', NODEBUG, A(d, ['handoff', 'LC', 'IMPLEMENTED']));
  expectMsg('a bug was classified TRIVIAL', 'TRIVIAL covers text and configuration only', A(d, ['classify', 'LC', 'TRIVIAL']));
  wr(d, '.agents/runs/LC/reports/001-debug.md', '# debug\n\nreproduction, root cause, regression test\n');
  handoffOk(d, 'a debug-proof result did not unblock a bug task');
  d = scaffold({ taskFm: 'type: feature', cls: 'STANDARD' });
  redGreen(d);
  handoffOk(d, 'a feature needed a debug-proof result');
  d = scaffold({ cls: 'STANDARD' });
  assert.equal(A(d, ['task-type', '.agents/runs/LC/TASK.md']).out.trim(), 'feature', 'a typeless task is not a feature');
  // content: a document path with its reason freezes; the same task type never exempts a path that holds code
  scaffold({ taskFm: 'type: content', scopeNamed: 'docs/guide.md', cls: 'STANDARD' });
  d = scaffold({ taskFm: 'type: docs', scopeNamed: 'src/app.js', cls: 'STANDARD', autonomy: 'supervised' });
  expectMsg('a docs task exempted a path that holds code', 'holds code and is never exempt', A(d, ['freeze', 'LC'], { bind: true }));
  d = scaffold({ taskFm: 'type: content', scopeNamed: 'docs/guide.md', cls: 'STANDARD', autonomy: 'supervised' });
  const pf = '.agents/runs/LC/PLAN.md';
  wr(d, pf, rd(d, pf).split('\n').filter((l) => !l.includes('tdd_exemption')).join('\n'));
  expectMsg('a content task froze a document path without the reason in the plan', 'exempts document paths from test-first by default', A(d, ['freeze', 'LC'], { bind: true }));
  scaffold({ taskFm: 'type: feature', scopeNamed: 'src/app.js', cls: 'STANDARD' });
});

test('sc_debug_result: the debug-proof trigger is the task type, label or a fix decision, never the words fix/duzelt/defect in prose', () => {
  // A200: the trigger is the task type or label, never the words "fix" or "duzelt" in prose.
  let d = scaffold({ cls: 'STANDARD', taskExtra: '\n## Suggested class\n\nSTANDARD — behavioural bug fix in one module with tests.' });
  redGreen(d);
  expectMsg('a bug named in Suggested class needs a debug-proof result', NODEBUG, A(d, ['handoff', 'LC', 'IMPLEMENTED']));
  wr(d, '.agents/runs/LC/reports/001-debug.md', '# debug\n\nreproduction, root cause, regression test\n');
  handoffOk(d, 'a debug-proof result did not unblock IMPLEMENTED');
  // a defect word in the Suggested class prose is not a defect task ("its own step drops nothing")
  d = scaffold({ cls: 'STANDARD', taskExtra: '\n## Suggested class\n\nSTANDARD — the first step is additive and its own step drops nothing.' });
  redGreen(d);
  handoffOk(d, 'a defect word in Suggested class prose blocked a task that is not a defect fix');
  // a label or type makes it a defect task: a Labels section, a Type line
  d = scaffold({ cls: 'STANDARD', taskExtra: '\n## Labels\n\n- bug\n- backend' });
  redGreen(d);
  expectMsg('a bug label needs a debug-proof result', NODEBUG, A(d, ['handoff', 'LC', 'IMPLEMENTED']));
  d = scaffold({ cls: 'STANDARD', taskExtra: '\n**Type:** defect' });
  redGreen(d);
  expectMsg('a defect type line needs a debug-proof result', NODEBUG, A(d, ['handoff', 'LC', 'IMPLEMENTED']));
  // the words fix, fixes, fixed, duzelt, defect or error in the prose, the Goal, a criterion or the user's quote never ask
  d = scaffold({ cls: 'STANDARD', taskExtra: '\n## Goal\n\nFix the page count: the last page is cut off, an error in the page count.\n\n## Context\n\n> Sayfa sayisini duzelt. Kitaplarimdan bazilari kayboldu, hata var.\n\nThe page count is wrong today and has a defect.\n\n## Acceptance criteria\n\n- AC-1: the page count is fixed.' });
  redGreen(d);
  handoffOk(d, 'A200: fix words in the prose asked an unlabelled task for a debug report');
  // a feature run with an ordinary assertion RED is not asked either (A122 guard)
  d = scaffold({ cls: 'STANDARD', taskExtra: '' });
  worker2(d, 'RED', 'fail', 'impl_test.txt', GL, 'lookup returns null instead of 5'); worker2(d, 'GREEN', 'pass', 'impl.txt', IL);
  handoffOk(d, 'a feature RED with actual-vs-expected text was blocked');
  // a declared pre-existing defect with decision: report stays a finding
  d = scaffold({ cls: 'STANDARD', taskExtra: '\n## Context\n\n### Pre-existing defects\n\n- `src/service.js:paginate`: totalPages uses Math.floor -- decision: report' });
  redGreen(d);
  handoffOk(d, 'a declared pre-existing defect (report) asked a feature task for a debug report');
  // decision: fix is a requested fix
  d = scaffold({ cls: 'STANDARD', autonomy: 'manual', taskExtra: '\n## Context\n\n### Pre-existing defects\n\n- `src/service.js:paginate`: totalPages rounds down -- decision: fix' });
  approveAsUser(d, 'scope', 'approve the scope'); must(d, ['freeze', 'LC'], { bind: true }); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  redGreen(d);
  expectMsg('a declared defect with decision: fix needs a debug-proof result', NODEBUG, A(d, ['handoff', 'LC', 'IMPLEMENTED']));
});

test('A327: the run-owned evidence worktree verify-<ID>.<focus> (detached, clean or dirty: A357) is removed by CODE_DONE itself; every other scratch worktree stays a blocker and the refusal does not sweep', () => {
  const d = scaffold({ cls: 'STANDARD' });
  redGreen(d); must(d, ['handoff', 'LC', 'IMPLEMENTED']); passAll(d);
  let n = 0;   // a direct child of the temp folder (the role texts name $TMPDIR/verify-<ID>.<focus>), unique by process and counter, removed at exit; no mkdtemp
  const fresh = (/** @type {string} */ prefix) => { const w = path.join(process.env.TMPDIR ?? tmpdir(), `${prefix}${process.pid}-${++n}`); removeAtExit(w); return w; };
  const other = fresh('qa-ev-');                        // a name the role texts do not give: a blocker
  const foreign = fresh('verify-OTHER.');               // another run's name: a blocker
  const sibling = fresh('verify-LC-2.');                // the concurrent run LC-2 (S3): a dot, not a dash, ends the id, so run LC never takes it
  const old = fresh('verify-LC-');                      // the old dash form is not a run-owned name any more
  const dirty = fresh('verify-LC.');                    // this run's name with an untracked file (the trials of a review role, A357): removed too
  const onBranch = fresh('verify-LC.');                 // this run's name but on a branch: a blocker
  for (const w of [other, foreign, sibling, old, dirty]) git(d, ['worktree', 'add', '-q', '--detach', w, 'HEAD']);
  const lockedMine = fresh('verify-LC.locked-'); git(d, ['worktree', 'add', '-q', '--detach', lockedMine, 'HEAD']); git(d, ['worktree', 'lock', lockedMine]);   // this run's name but locked: git refuses, a blocker
  git(d, ['worktree', 'add', '-q', '-b', 'scratch-branch', onBranch, 'HEAD']);
  writeFileSync(path.join(dirty, 'note.txt'), 'x');
  const mine = fresh('verify-LC.tests-'); git(d, ['worktree', 'add', '-q', '--detach', mine, 'HEAD']);
  const mineBase = fresh('verify-LC.qa-base-'); git(d, ['worktree', 'add', '-q', '--detach', mineBase, 'HEAD']);
  // a link swapped in for a registered run-owned worktree (it points at another registered, clean, detached worktree): nothing is removed through it
  const swap = fresh('verify-LC.swap-'); git(d, ['worktree', 'add', '-q', '--detach', swap, 'HEAD']);
  const aside = `${swap}-aside`; renameSync(swap, aside); symlinkSync(other, swap);
  const r = A(d, ['handoff', 'LC', 'CODE_DONE']);
  assert.ok(existsSync(other) && existsSync(aside), 'the target of the link and the moved worktree are untouched');
  assert.ok(r.text.includes(path.basename(swap)), 'the swapped link is named as a blocker');
  unlinkSync(swap); renameSync(aside, swap);
  expectMsg('the foreign and locked worktrees still block', 'scratch git worktrees', r);
  assert.ok(!existsSync(mine) && !existsSync(mineBase) && !existsSync(dirty), 'the detached run-owned worktrees were removed, the dirty one too');
  assert.match(r.text, /removed the run's own evidence worktree/);
  assert.match(r.text, /not a question for the user/);
  assert.match(r.text, /Any other path was not made by this run's roles[^\n]*ask the user before removing it/, 'the refusal sends every other path to the user');
  assert.doesNotMatch(r.text, /made by the review roles of this run/, 'the refusal no longer says that all listed worktrees are the roles\'');
  for (const w of [other, foreign, sibling, old, lockedMine, onBranch]) { assert.ok(existsSync(w), `${w} must not be removed`); assert.ok(r.text.includes(path.basename(w)), `${w} is named as a blocker`); }
  git(d, ['worktree', 'unlock', lockedMine]);
  for (const w of [other, foreign, sibling, old, lockedMine, onBranch, swap]) git(d, ["worktree", "remove", "--force", w]);
  accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE after the blockers were removed');
});

test('A327: the dirty evidence worktree of ANOTHER open run does not block this run\'s CODE_DONE and is left alone; the lookalikes, a run without an open run and a terminal run still block', () => {
  const d = scaffold({ cls: 'STANDARD' });
  redGreen(d); must(d, ['handoff', 'LC', 'IMPLEMENTED']); passAll(d);
  let n = 0;
  const fresh = (/** @type {string} */ prefix) => { const w = path.join(process.env.TMPDIR ?? tmpdir(), `${prefix}${process.pid}-${++n}`); removeAtExit(w); return w; };
  const runOf = (/** @type {string} */ id, /** @type {string} */ state) => wr(d, `.agents/runs/${id}/RUN.yaml`, `execution:\n  state: ${state}\n`);
  runOf('OA', 'IMPLEMENTING'); runOf('OT', 'DONE'); runOf('OF', 'FAILED');
  // the evidence worktree of the open run OA, dirty (a mutation in progress): not a blocker, not removed
  const open = fresh('verify-OA.qa-'); git(d, ['worktree', 'add', '-q', '--detach', open, 'HEAD']); writeFileSync(path.join(open, 'mutant.txt'), 'x');
  const blockers = [
    fresh('verify-OZ.qa-'),        // a run that has no run folder
    fresh('verify-OT.qa-'),        // a run that is DONE
    fresh('verify-OF.qa-'),        // a run that is FAILED
    fresh('qa-ev-'),               // another name
  ];
  for (const w of blockers) git(d, ['worktree', 'add', '-q', '--detach', w, 'HEAD']);
  const onBranch = fresh('verify-OA.br-'); git(d, ['worktree', 'add', '-q', '-b', 'oa-branch', onBranch, 'HEAD']);   // the open run's name but on a branch
  const sym = fresh('verify-OA.sym-'); git(d, ['worktree', 'add', '-q', '--detach', sym, 'HEAD']);
  const aside = `${sym}-aside`; renameSync(sym, aside); symlinkSync(open, sym);   // a link where the registered folder was
  const nestRoot = fresh('nest-'); mkdirSync(nestRoot); const nested = path.join(nestRoot, 'verify-OA.qa'); git(d, ['worktree', 'add', '-q', '--detach', nested, 'HEAD']);   // not a direct child
  const r = A(d, ['handoff', 'LC', 'CODE_DONE']);
  expectMsg('the lookalikes and the runs without an open run still block', 'scratch git worktrees', r);
  // git lists the path in its own spelling (forward slashes, long names on Windows): the unique file name (pid and counter) is what is compared
  for (const w of [...blockers, onBranch, sym, nested]) assert.ok(r.text.includes(w === nested ? path.basename(nestRoot) : path.basename(w)), `${w} is named as a blocker`);
  assert.ok(!r.text.includes(path.basename(open)), 'the dirty evidence worktree of the open run OA is not named');
  assert.ok(existsSync(path.join(open, 'mutant.txt')), 'and it is untouched');
  unlinkSync(sym); renameSync(aside, sym);
  for (const w of [...blockers, onBranch, sym, nested]) git(d, ['worktree', 'remove', '--force', w]);
  accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE with only the open run\'s evidence worktree left');
  assert.ok(existsSync(path.join(open, 'mutant.txt')), 'the open run\'s worktree is still there after CODE_DONE');
  git(d, ['worktree', 'remove', '--force', open]);
});

test('sc_scratch_worktrees: a registered scratch worktree blocks CODE_DONE; the worktree of another run is not scratch (A169)', () => {
  const d = scaffold({ cls: 'STANDARD' });
  redGreen(d); must(d, ['handoff', 'LC', 'IMPLEMENTED']); passAll(d);
  const rw = must(d, ['worktree-add', 'RW-1']).out;   // the worktree of another run (here under $TMPDIR, like the whole fixture) is the project's own, never scratch
  const wt = tempDir('scratch-wt-'); rmSync(wt, { recursive: true });
  git(d, ['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
  const r = A(d, ['handoff', 'LC', 'CODE_DONE']);
  expectMsg('a scratch worktree still registered blocks CODE_DONE', 'scratch git worktrees', r);
  for (const l of rw.split('\n').filter((x) => x !== '')) assert.ok(!r.text.split('\n').includes(l) && !r.text.includes(l), `the run worktree ${l} was named as scratch`);
  git(d, ['worktree', 'remove', '--force', wt]);
  accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE refused after the scratch worktree was removed (the run worktree RW-1 must not count)');
});

// Windows (W10): the read-only part of A196 is a property of POSIX directory modes (`chmod 555` stops a create in the folder); a directory's read-only attribute on Windows stops nothing, so the
// premise "the folder is not writable" cannot be made there and the assertion would pass or fail for no reason of ours. The part that waits for a live older lock keeps running on every platform.
const modeBits = process.platform !== 'win32';
test('sc_worktree_lock_folder: a run-worktree command needs only locks/ writable, cannot write approvals or prompts, and waits for an older version\'s live lock (A196, A199)', { timeout: 90000 }, async () => {
  const d = scaffold({ cls: 'STANDARD' });
  const rw = must(d, ['worktree-add', 'RW-1']).out;
  let rwp = (/(\/[^ \n]*worktrees\/RW-1)/.exec(rw) ?? [])[1] ?? '';
  if (!rwp || !existsSync(rwp)) rwp = path.join(d, '.agents/local/worktrees/RW-1');
  assert.ok(existsSync(rwp), `A196 the run worktree was not found in: ${rw}`);
  mkdirSync(path.join(rwp, '.agents/runs'), { recursive: true });
  spawnSync('cp', ['-R', path.join(d, '.agents/runs/LC'), path.join(rwp, '.agents/runs/LC')]);
  for (const f of ['.agents/local/locks', '.agents/local/approvals', '.agents/local/prompts']) mkdirSync(path.join(d, f), { recursive: true });
  mkdirSync(path.join(rwp, '.agents/local/locks'), { recursive: true });
  const ro = [path.join(d, '.agents/local'), path.join(d, '.agents/local/approvals'), path.join(d, '.agents/local/prompts'), path.join(rwp, '.agents/local')];
  const lock = (/** @type {number} */ m) => { if (modeBits) for (const p of ro) chmodSync(p, m); };
  lock(0o555);
  /** @type {import('../lib/harness.mjs').Result} */ let r;
  try { r = A(rwp, ['ledger-note', 'LC', 'A196 note']); } finally { lock(0o755); }
  assert.equal(r.status, 0, `A196 the worktree command failed with the rest of .agents/local read-only: ${r.text}`);
  if (modeBits && process.getuid?.() !== 0) {
    assert.ok(!r.text.includes('cannot take the lock'), `A196 the worktree command could not take the shared lock with the rest of .agents/local read-only: ${r.text}`);
    lock(0o555);
    try {
      for (const f of ['.agents/local/approvals/forged', '.agents/local/prompts/forged']) assert.throws(() => writeFileSync(path.join(d, f), ''), `A196 ${f} was writable although only locks/ is granted`);
      assert.throws(() => mkdirSync(path.join(d, '.agents/local/windows-forged')), 'A196 .agents/local was writable although only locks/ is granted');
    } finally { lock(0o755); }
  }
  assert.ok(!existsSync(path.join(d, '.agents/local/locks/shared.lock')), 'A196 the shared lock was left behind');
  // an older version's lock in the main tree, held by a live process, is waited for (read-only) and never removed: the command must not finish before the holder is gone
  const holder = spawn(process.execPath, PARKED, { stdio: ['pipe', 'ignore', 'ignore'] });
  try {
    mkdirSync(path.join(d, '.agents/local/.lock'));
    writeFileSync(path.join(d, '.agents/local/.lock/pid'), `${holder.pid}\n`);
    const env = (/** @type {string} */ seconds) => ({ PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', PROOFLINE_NO_TTY: '1', PROOFLINE_LOCK_TIMEOUT: seconds, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    const noted = () => [path.join(d, '.agents/runs/LC/LEDGER.log'), path.join(rwp, '.agents/runs/LC/LEDGER.log')].some((f) => existsSync(f) && readFileSync(f, 'utf8').includes('A196 after the old lock'));
    // the holder is alive: the command waits for it (its own lock timeout, one second here) and gives up on that timeout; it does not take the lock over and writes nothing
    const waiting = spawnSync('sh', ['.agents/scripts/agent.sh', 'ledger-note', 'LC', 'A196 after the old lock'], { cwd: rwp, env: env('1'), encoding: 'utf8' });
    assert.notEqual(waiting.status, 0, 'A196 a worktree command did not wait for the live holder of the old main-tree lock (it finished while the holder was alive)');
    assert.match(`${waiting.stdout}${waiting.stderr}`, /lock timeout after 1s/, 'A196 the command did not stop on its lock timeout');
    assert.ok(!noted(), 'A196 the command wrote its ledger note while the old main-tree lock was still held');
    // the holder is released while the command waits: the command takes its own folder lock first (tree.lock, the event that it is on its way to the old lock) and then waits
    // for the live holder; the holder ends (the exit event of the process) and the very same command, with a long lock timeout, goes on and writes its note
    const locksDir = path.join(rwp, '.agents/local/locks');
    const onWay = new Promise((res) => {
      const w = watch(locksDir, () => { if (existsSync(path.join(locksDir, 'tree.lock'))) { w.close(); res(undefined); } });
    });
    const cmd = spawn('sh', ['.agents/scripts/agent.sh', 'ledger-note', 'LC', 'A196 after the old lock'], { cwd: rwp, env: env('300'), stdio: ['ignore', 'pipe', 'pipe'], detached: true });   // a lock timeout far above the test timeout: only the release of the holder can end the wait in time
    try {
    let text = '';
    cmd.stdout.on('data', (x) => { text += x; }); cmd.stderr.on('data', (x) => { text += x; });
    const finished = new Promise((res) => { cmd.on('close', (code) => res(code)); });
    await onWay;
    assert.equal(cmd.exitCode, null, 'A196 the command ended although the old lock was still held');
    const gone = new Promise((res) => { holder.on('exit', () => res(undefined)); });
    holder.kill();
    await gone;
    assert.equal(await finished, 0, `A196 the command did not go on after the old lock was released: ${text}`);
    assert.ok(noted(), 'A196 the command did not write its ledger note after the old lock was released');
    assert.doesNotMatch(text, /lock timeout/, 'A196 the wait ended by the lock timeout, not by the release of the holder');
    } finally { try { process.kill(-(/** @type {number} */ (cmd.pid)), 'SIGKILL'); } catch { /* gone */ } }
  } finally { holder.kill(); rmSync(path.join(d, '.agents/local/.lock'), { recursive: true, force: true }); }
});

test('sc_doc_scope_warning: freeze warns once about a document path without tdd_exemption and stays quiet with it (A197)', () => {
  /** @param {string} dir @param {string[]} extra */
  const addDoc = (dir, extra) => {
    const pf = '.agents/runs/LC/PLAN.md';
    wr(dir, pf, rd(dir, pf).split('\n').flatMap((l) => (l === 'scope:' ? [l, '  - path: docs/design/DESIGN.md', '    new: true', '    criteria: [AC-1]', ...extra] : [l])).join('\n'));
  };
  let d = unfrozen('STANDARD');
  addDoc(d, []);
  let r = A(d, ['freeze', 'LC'], { bind: true });
  assert.equal(r.status, 0, `A197 a document path without tdd_exemption stopped the freeze: ${r.text}`);
  assert.ok(r.text.includes('warning: PLAN.md scope has document path(s) without tdd_exemption: docs/design/DESIGN.md'), `A197 no warning for the document path: ${r.text}`);
  assert.ok(r.text.includes('design-sync'), `A197 the warning does not suggest the proof: ${r.text}`);
  assert.equal(r.text.split('\n').filter((l) => l.includes('without tdd_exemption')).length, 1, `A197 the warning is not one line: ${r.text}`);
  d = unfrozen('STANDARD');
  addDoc(d, ['    tdd_exemption: "design document, checked by design-sync instead of a failing test"']);
  r = A(d, ['freeze', 'LC'], { bind: true });
  assert.equal(r.status, 0, `A197 the freeze failed with the exemption: ${r.text}`);
  assert.ok(!r.text.includes('without tdd_exemption'), `A197 a warning although the path has an exemption: ${r.text}`);
});

const NOTES = 'REVIEW_TESTS-1|blocking|impl_test.txt:1|the test asserts nothing about the empty key|traced: empty key -> nil';

describe('sc_selective_rerun: after a fix round a test-only fix keeps REVIEW_PLAN/RULES/SECURITY; security tests and product code rerun them; SECRETS, REVIEW_TESTS, VERIFY always run (A200)', { concurrency: 3 }, () => {
  for (const variant of ['tests_only', 'security_test', 'product_code']) test(`sc_selective_rerun: ${variant}`, () => {
    const d = scaffold({ cls: 'CRITICAL' });
    redGreen(d); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
    assert.ok(gatesOf(d).length >= 6, `A200 the run is not full tier: ${gatesOf(d).join(' ')}`);
    passAll(d);
    rec(d, 'REVIEW_TESTS', 'FAIL', [NOTES]);
    must(d, ['handoff', 'LC', 'IMPLEMENTING']);
    if (variant === 'tests_only') worker2(d, 'FIX', 'pass', 'impl_test.txt', 'test: lookup of a missing key is nil');
    else if (variant === 'security_test') worker2(d, 'FIX', 'pass', 'impl_test.txt', 'test: an expired token is rejected');
    else worker2(d, 'FIX', 'pass', 'impl.txt', 'impl: lookup of a missing key is nil');
    must(d, ['handoff', 'LC', 'IMPLEMENTED']);
    for (const g of ['REVIEW_PLAN', 'REVIEW_RULES', 'SECURITY']) {
      const st = gateStatus(d, g);
      const key = `${variant}:${g}`;
      if (variant === 'tests_only') assert.equal(st, 'pass', `A200 ${variant}: ${g} is ${st}, a test-only fix must keep it`);
      else if (key === 'security_test:SECURITY' || variant === 'product_code') assert.notEqual(st, 'pass', `A200 ${variant}: ${g} still pass although its inputs changed`);
      else assert.equal(st, 'pass', `A200 ${variant}: ${g} is ${st}`);
    }
    for (const g of ['SECRETS', 'REVIEW_TESTS', 'VERIFY']) assert.notEqual(gateStatus(d, g), 'pass', `A200 ${variant}: ${g} carried over; it always runs`);
  });
});

describe('sc_amend_carry: an amend carries REVIEW_PLAN/RULES/SECURITY only for an unrelated test change; plan, product code and security tests rerun them (A200)', { concurrency: 4 }, () => {
  for (const variant of ['tests_only', 'security_test', 'product_code', 'plan_change']) test(`sc_amend_carry: ${variant}`, () => {
    const d = scaffold({ cls: 'CRITICAL' });
    redGreen(d); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
    assert.ok(gatesOf(d).length >= 6, `A200 amend: the run is not full tier: ${gatesOf(d).join(' ')}`);
    passAll(d);
    accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), `A200 amend ${variant}: no CODE_DONE`);
    const fs = variant === 'product_code' ? 'impl.txt' : 'impl_test.txt';
    const pc = variant === 'plan_change' ? 'plan_change: yes' : '';
    const input = `reason: the user asked for one more test after CODE_DONE (${variant})\nfix_scope: ${fs}\nfix_instruction: change ${fs} only as the user asked, nothing else\nauthorized_by: the user\n${pc}\n`;
    accepted(A(d, ['amend', 'LC'], { input }), `A200 amend ${variant}: amend refused`);
    if (variant === 'plan_change') {
      wr(d, '.agents/runs/LC/amendments/001.md', '# amendment 001: the architecture note changes\n');
      appendFileSync(path.join(d, '.agents/runs/LC/PLAN.md'), '\nAmended: the lookup note changed.\n');
      accepted(A(d, ['refreeze', 'LC', '001.md'], { bind: true }), 'A200 amend plan_change: refreeze refused');
      worker2(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup again returns the stored value'); worker2(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup again returns the stored value');
    } else if (variant === 'tests_only') worker2(d, 'FIX', 'pass', 'impl_test.txt', 'test: lookup of a missing key is nil');
    else if (variant === 'security_test') worker2(d, 'FIX', 'pass', 'impl_test.txt', 'test: an expired token is rejected');
    else worker2(d, 'FIX', 'pass', 'impl.txt', 'impl: lookup of a missing key is nil');
    accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), `A200 amend ${variant}: no IMPLEMENTED`);
    for (const g of ['REVIEW_PLAN', 'REVIEW_RULES', 'SECURITY']) {
      const st = gateStatus(d, g);
      const key = `${variant}:${g}`;
      if (variant === 'tests_only') assert.equal(st, 'pass', `A200 amend ${variant}: ${g} is ${st}, a test-only amendment must keep it`);
      else if (key === 'security_test:SECURITY' || variant === 'product_code' || variant === 'plan_change') assert.notEqual(st, 'pass', `A200 amend ${variant}: ${g} still pass although its inputs changed`);
      else assert.equal(st, 'pass', `A200 amend ${variant}: ${g} is ${st}`);
    }
    for (const g of ['SECRETS', 'REVIEW_TESTS', 'VERIFY']) assert.notEqual(gateStatus(d, g), 'pass', `A200 amend ${variant}: ${g} carried over; it always runs`);
  });
});

test('sc_test_path_kind: manifests, lockfiles, env, build and contract files under test directories are product input (A200)', () => {
  const d = scaffold({});
  /** @param {string} p */
  const tp = (p) => A(d, ['test-path', p]).out.replace(/\n+$/, '').split('\n').map((l) => l.split('\t')[0]).join('\n');
  for (const p of ['tests/Package.swift', 'tests/setup.py', 'tests/Package.json', 'tests/.env.local', 'tests/Dockerfile', 'tests/go.mod', 'tests/package.json', 'test/.env', 'api/spec/openapi.yaml', 'test/setup/requirements.txt', 'tests/docker-compose.yml']) {
    assert.equal(tp(p), 'product', `A200 ${p} counted as a test`);
  }
  for (const p of ['tests/foo_test.go', 'test/unit/a.test.ts', 'src/__tests__/b.js', 'tests/test_x.py']) assert.equal(tp(p), 'test', `A200 ${p} is not counted as a test`);
});

test('sc_scope_kind_column: the scope kind column is a claim: a mislabelled code file stays code in the bound and the digest, an unknown kind is code, no column is derived (A202)', () => {
  const plan = (/** @type {string} */ d) => path.join(d, '.agents/runs/LC/PLAN.md');
  let d = unfrozen('STANDARD', { scopeNamed: 'notes.md' });
  wr(d, 'notes.md', '');
  kindClaim(plan(d), 'impl.txt', 'content'); kindClaim(plan(d), 'notes.md', 'doc'); kindClaim(plan(d), 'impl_test.txt', 'code');
  const rows = A(d, ['scope-kinds', 'LC']).out.split('\n');
  assert.ok(rows.includes('impl.txt\tcontent\tcode\tcode\tno'), `A202 a code file labelled content is not code: ${rows.join('|')}`);
  assert.ok(rows.includes('notes.md\tdoc\tcontent\tcontent\tyes'), `A202 a true doc label was not accepted: ${rows.join('|')}`);
  assert.ok(rows.includes('impl_test.txt\tcode\ttest\tcode\tno'), `A202 a stricter claim (code for a test) was not honoured: ${rows.join('|')}`);
  const dg = A(d, ['digest', 'LC']).out;
  assert.ok(dg.split('\n').some((l) => l.startsWith('SCOPE: code=2 test=0 content=1 (kind claimed wrongly, counted as code: impl.txt impl_test.txt)')), `A202 digest scope line: ${dg.split('\n').filter((l) => l.includes('SCOPE')).join('|')}`);
  let inStd = false;
  wr(d, '.agents/config.yaml', rd(d, '.agents/config.yaml').split('\n').map((l) => {
    if (/^ {2}STANDARD:/.test(l)) inStd = true;
    if (inStd && l.includes('max_scope_paths:')) { inStd = false; return l.replace(/[0-9]+/, '1'); }
    return l;
  }).join('\n'));
  expectMsg('a code file labelled content lowered the scope bound', 'code paths (content and document paths are not counted)', A(d, ['freeze', 'LC'], { bind: true }));
  // a plan without the column is derived; an unknown word is treated as code
  d = unfrozen('STANDARD', { scopeNamed: 'notes.md' }); wr(d, 'notes.md', ''); kindClaim(plan(d), 'notes.md', 'banana');
  let k = A(d, ['scope-kinds', 'LC']).out.split('\n');
  assert.ok(k.includes('notes.md\tbanana\tcontent\tcode\tyes'), `A202 an unknown kind was not treated as code: ${k.join('|')}`);
  d = unfrozen('STANDARD', { scopeNamed: 'notes.md' }); wr(d, 'notes.md', '');
  k = A(d, ['scope-kinds', 'LC']).out.split('\n');
  assert.ok(k.includes('notes.md\t-\tcontent\tcontent\tyes'), `A202 a plan without the column is not derived: ${k.join('|')}`);
});

describe('sc_scope_kind_gate_rerun: a plan whose kind column says a path is code never lets a gate carry over for it (A202)', { concurrency: 2 }, () => {
  for (const variant of ['honest', 'mislabelled']) test(`sc_scope_kind_gate_rerun: ${variant}`, () => {
    const d = scaffold(variant === 'honest' ? { cls: 'CRITICAL' } : { cls: 'CRITICAL', kindClaim: 'impl_test.txt=code' });
    redGreen(d); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
    passAll(d);
    rec(d, 'REVIEW_TESTS', 'FAIL', [NOTES]);
    must(d, ['handoff', 'LC', 'IMPLEMENTING']);
    worker2(d, 'FIX', 'pass', 'impl_test.txt', 'test: lookup of a missing key is nil');
    must(d, ['handoff', 'LC', 'IMPLEMENTED']);
    const st = gateStatus(d, 'REVIEW_PLAN');
    if (variant === 'honest') assert.equal(st, 'pass', `A202 honest test-only fix: REVIEW_PLAN is ${st}`);
    else assert.notEqual(st, 'pass', "A202 the plan's own kind column says the path is code, yet REVIEW_PLAN carried over");
  });
});

test('sc_rollback_note: a COMPLEX or CRITICAL plan without a rollback note in ## Risk is warned, never TRIVIAL or STANDARD, and the note is accepted inside Risk (A202)', () => {
  let d = unfrozen('COMPLEX');
  let out = A(d, ['freeze', 'LC'], { bind: true }).text;
  assert.ok(out.includes('no rollback note'), `A202 no warning for a COMPLEX plan without rollback: ${out}`);
  d = unfrozen('COMPLEX', { planExtra: '## Risk\n\nrollback: ship behind the lookup flag; if production breaks, switch the flag off first\n  then revert the commit\nconcurrency: no\n\n## Dependencies\n\nnone' });
  out = A(d, ['freeze', 'LC'], { bind: true }).text;
  assert.ok(!out.includes("Risk' holds only"), `A202 the rollback note was refused inside Risk: ${out}`);
  assert.ok(!out.includes('no rollback note'), `A202 warned although the rollback note is there: ${out}`);
  d = unfrozen('STANDARD'); out = A(d, ['freeze', 'LC'], { bind: true }).text;
  assert.ok(!out.includes('rollback'), `A202 STANDARD was asked for a rollback note: ${out}`);
  d = unfrozen('TRIVIAL'); out = A(d, ['freeze', 'LC'], { bind: true }).text;
  assert.ok(!out.includes('rollback'), `A202 TRIVIAL was asked for a rollback note: ${out}`);
});

test('sc_summary_human_checks: the Human checks list is copied by script into the report summary once, equal to the QA report list; the summary is English like the file and not evidence (A202)', () => {
  const d = scaffold({ topology: 'standalone' });
  const human = '## Human checks\n\n- The error text reads naturally in Turkish\n- The empty state looks balanced on a phone';
  solo(d, 'RED', 'fail', 'impl_test.txt', GL); solo(d, 'GREEN', 'pass', 'impl.txt', IL);
  must(d, ['handoff', 'LC', 'IMPLEMENTED']); passAllExtra(d, human); must(d, ['handoff', 'LC', 'CODE_DONE']);
  const hc = () => A(d, ['human-checks', 'LC']).out.replace(/\n+$/, '');
  assert.equal(hc().split('\n').length, 2, `A202 human-checks: ${hc()}`);
  must(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']);
  const rp = '.agents/runs/LC/COMPLETION_REPORT.md';
  /** the model's summary lines, then the usual body @param {string[]} lines */
  const mk = (...lines) => {
    writeReport(d);
    const body = rd(d, rp).split('\n');
    body.pop();
    writeFileSync(path.join(d, rp), `${['# Completion Report: LC', '', '<!-- proofline:summary:begin -->', ...lines, '<!-- proofline:summary:end -->', ...body.slice(1)].join('\n')}\n`);
  };
  const V = 'Verify: `sh test.sh`';
  mk('Changed: arama artik bos anahtar icin varsayilani donduruyor', V);
  mk('Changed: ok', 'The empty state looks balanced on a phone', V);
  expectMsg('a retyped Human checks item was published', 'repeats a QA_REPORT.md', A(d, ['publish-completion-report', 'LC', 'markdown']));
  mk('Changed: one', 'Changed: two', 'Changed: three', V);
  expectMsg('a six-line summary was published', 'at most five', A(d, ['publish-completion-report', 'LC', 'markdown']));
  mk('Changed: the lookup returns the default for an empty key');
  expectMsg('a summary without a Verify command was published', "needs exactly one line 'Verify:", A(d, ['publish-completion-report', 'LC', 'markdown']));
  // the report is a file: a Turkish Changed line is refused (every file of a run is English), the English line is published; the chat message carries the user's language
  mk('Changed: arama artik bos anahtar icin varsayilani donduruyor, çünkü şunu istediniz', V);
  expectMsg('a Turkish summary line was published into the task file', "language: run artifacts are English", A(d, ['publish-completion-report', 'LC', 'markdown']));
  expectMsg('the refusal does not name the Changed line', "The summary block's Changed: line must be English; only the chat message follows the user's language", A(d, ['publish-completion-report', 'LC', 'markdown']));
  assert.ok(!existsSync(path.join(d, '.agents/tasks/in-progress')) || !readdirSync(path.join(d, '.agents/tasks/in-progress')).some((f) => rd(d, `.agents/tasks/in-progress/${f}`).includes('varsayilani')), 'the Turkish line reached the task file');
  mk('Changed: the lookup returns the default for an empty key', V);
  accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'A202 an English summary was refused');
  const look = () => rd(d, rp).split('\n').filter((l) => l.startsWith('Look at: '));
  assert.equal(look().length, 2, `A202 the Look at lines are not there exactly once each: ${rd(d, rp).split('\n').slice(0, 12).join('\n')}`);
  assert.equal(look().map((l) => l.slice('Look at: '.length)).join('\n'), hc(), 'A202 the summary list differs from the QA_REPORT.md list');
  assert.equal(rd(d, rp).split('balanced on a phone').length - 1, 1, 'A202 the list is written twice in the report');
  assert.ok(rd(d, rp).split('\n')[2] === '<!-- proofline:summary:begin -->' && /^<!-- proofline:facts:begin -->/m.test(rd(d, rp)), 'A202 summary not at the top or Facts block missing');
  accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'A202 republish refused');
  assert.equal(look().length, 2, 'A202 a republish doubled the list');
  accepted(A(d, ['handoff', 'LC', 'DONE']), 'A202 DONE refused for a report with an English summary');
  A(d, ['status-block', 'LC', 'code-done']);
  assert.equal(hc().split('\n').length, 2);
});

test('sc_visual_row_match: a visual-evidence row is recognized by its reviews/visual-proof/ path, not by the word report.json (A200)', () => {
  const d = scaffold({ cls: 'CRITICAL' });
  redGreen(d); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  passAll(d);
  rec(d, 'VERIFY', 'FAIL', ["VERIFY-1|blocking|impl.txt:1|the build's report.json is stale and the visual evidence is not mentioned|traced: build output"]);
  assert.ok(!A(d, ['next', 'LC']).out.includes('qa --focus visual'), `A200 a row that only says report.json sent the lead to the QA visual focus: ${A(d, ['next', 'LC']).out}`);
  rec(d, 'VERIFY', 'FAIL', ['VERIFY-2|blocking|impl.txt:1|reviews/visual-proof/report.json is missing|traced: no such file']);
  assert.ok(A(d, ['next', 'LC']).out.includes('qa --focus visual'), `A200 a row naming reviews/visual-proof/ did not send the lead to the QA visual focus: ${A(d, ['next', 'LC']).out}`);
});

test('sc_a200_misc: the normalizer list, the expected-format errors of refreeze, the rationale approval needs a written line (A200)', () => {
  const d = scaffold({});
  /** @param {string} x */
  const n = (x) => A(d, ['repro-normalize'], { input: `${x}\n` }).out.replace(/\n+$/, '');
  assert.equal(n('12:34:56 [build] Complete!'), '[build] Complete!', 'A200 the [build] Complete! line is not normalized');
  assert.equal(n('[build] Complete! in 1.5s'), '[build] Complete!', 'A200 the Complete! line with a duration');
  assert.equal(n('done 2026-10-28T10:11:12.5Z ok'), 'done <TIMESTAMP> ok', `A200 timestamp: ${n('done 2026-10-28T10:11:12.5Z ok')}`);
  assert.equal(n('Done in 3.2s'), n('Done in 41ms'), "A200 durations after 'in' differ");
  assert.equal(n('42 passed (12ms)'), n('42 passed (3 s)'), 'A200 parenthesized duration');
  assert.notEqual(n('42 passed'), n('43 passed'), 'A200 a real count difference was normalized away');
  assert.notEqual(n('Done in 3s'), n('Built in 3s'), 'A200 different words were normalized together');
  assert.equal(n('pid 4242 on 2026-10-28'), 'pid 4242 on 2026-10-28', 'A200 a pid or a bare date was normalized');
  assert.notEqual(n('2026-10-28T10:11:12Z 42 passed'), n('2026-10-28T10:11:12Z 43 passed'), 'A200 a count next to a timestamp was normalized away');
  assert.notEqual(n('10:11:12 [build] Complete! 3 errors'), n('10:11:12 [build] Complete! 4 errors'), 'A200 a count next to the Complete! line was normalized away');
  assert.notEqual(n('2026-10-28T10:11:12Z failed: a.js'), n('2026-10-28T10:11:12Z failed: b.js'), 'A200 a name next to a timestamp was normalized away');
  assert.notEqual(n('Done in 3s: 5 files'), n('Done in 3s: 6 files'), 'A200 a count after a duration was normalized away');
  assert.notEqual(n('3 tests failed'), n('3 tests passed'), 'A200 pass and fail were normalized together');
  expectMsg('A200 refreeze without an amendment shows the format', 'Example: write amendments/001.md', A(d, ['freeze', 'LC'], { bind: true }));
  expectMsg('A200 refreeze with a missing file shows the format', 'agent.sh refreeze LC 001.md', A(d, ['refreeze', 'LC', 'nope.md'], { bind: true }));
  // item 6: a rationale approval needs a written line, and the kind is accepted
  expectMsg('A200 rationale approval without a DESIGN.md line', "no non-empty '- mono-labels: <reason>' line", A(d, ['request-approval', 'LC', 'rationale:mono-labels']));
  wr(d, 'docs/design/DESIGN.md', '# D\n\n## Pattern justifications\n- mono-labels: file names are the product here\n');
  assert.ok(A(d, ['request-approval', 'LC', 'rationale:mono-labels']).out.includes('rationale line of DESIGN.md: mono-labels: file names are the product here'), 'A200 the request does not show the line');
  assert.equal(A(d, ['design-rationales', 'LC']).out.replace(/\n+$/, '').split('\n').map((l) => l.split('\t').slice(0, 2).join('\t')).join('\n'), 'mono-labels\tunapproved', 'A200 an unapproved rationale is listed as approved');
  assert.equal(A(d, ['design-rationales', 'LC', '--json']).out.replace(/\n+$/, ''), '{"approved": {}}', `A200 the approved object is not empty: ${A(d, ['design-rationales', 'LC', '--json']).out}`);
});

test('sc_takeover_without_red: a change edited without RED is bound by put-back, RED, restore, GREEN; GREEN with no change since RED is refused and names the put-back path (A198)', () => {
  let d = scaffold({ cls: 'STANDARD' });
  const baseImpl = rd(d, 'impl.txt').replace(/\n+$/, '');
  let w = wopen(d); appendFileSync(path.join(d, 'impl.txt'), 'lookup returns the stored value\n'); wclose(d, w);   // the earlier implementer: an edit, no evidence
  const changed = rd(d, 'impl.txt');
  w = wopen(d);                                                                       // the implementer that takes over
  writeFileSync(path.join(d, 'impl.txt'), `${baseImpl}\n`);                         // step 1: put the change back for one run
  accepted(wev(d, 'RED', 'fail'), 'A198 RED was refused with the change put back');
  writeFileSync(path.join(d, 'impl.txt'), changed);                                 // step 2: restore the change
  accepted(wev(d, 'GREEN', 'pass'), 'A198 GREEN was refused after the change was restored');
  wclose(d, w);
  const ev = readdirSync(path.join(d, '.agents/runs/LC/worker-evidence'));
  assert.ok(ev.some((f) => /^RED-.*\.yaml$/.test(f)) && ev.some((f) => /^GREEN-.*\.yaml$/.test(f)), 'A198 RED and GREEN were not both recorded');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'A198 the handoff was refused although RED and GREEN are recorded');
  // RED recorded with the change in place leaves no change between RED and GREEN: GREEN is refused, and the refusal names the way out
  d = scaffold({ cls: 'STANDARD' });
  w = wopen(d); appendFileSync(path.join(d, 'impl.txt'), 'lookup returns the stored value\n'); wclose(d, w);
  w = wopen(d); wev(d, 'RED', 'fail');
  const r = A(d, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: 'command: go test ./...\ntarget: impl.txt,impl_test.txt\n\n' });
  refused(r, 'A198 GREEN was accepted with no change since RED', 'put it back to the base content');
});

test('sc_tests_findings: REVIEW_TESTS needs findings.json with a killed-by-assertion claim for every criterion of PLAN ## Tests', () => {
  const d = scaffold({ planExtra: '\n## Tests\n\n- AC-1: `impl_test.txt` "lookup returns the stored value"' });
  implemented(d);
  mkdirSync(path.join(d, '.agents/skills'), { recursive: true });
  spawnSync('cp', ['-R', path.join(repo, 'skills/test-trust'), path.join(d, '.agents/skills/test-trust')]);
  appendFileSync(path.join(d, '.git/info/exclude'), '.agents/skills/\n');
  const t = '.agents/runs/LC/reviews/test-trust/tests';
  wr(d, `${t}/REPORT.md`, 'tests review of the whole current tree\n');
  expectMsg('a tests review without findings.json', 'needs reviews/test-trust/tests/findings.json', AS(d, 'reviewer', ['submit', 'LC', '--focus', 'tests', '--confidence', 'high', '--agent', 'tf1']));
  wr(d, `${t}/findings.json`, `${['{"mode":"diff","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","evidence_pruned":true,"gate":{"result":"PASS","failing":[]},',
    '"scope":{"slug":"diff","paths":["."],"commit":"abc1234","diff":{"base":"abc1234","thresholds":{"repeat":5,"mutation_budget":20,"slow_ratio":3},"changed_units":["impl.txt:lookup"],"tests":["lookup returns the stored value"],"mutants_run":1,"not_examined":[]}},',
    '"findings":[]}'].join('\n')}\n`);
  expectMsg('a tests review without a claim for the criterion', 'no claim mutant for it', AS(d, 'reviewer', ['submit', 'LC', '--focus', 'tests', '--confidence', 'high', '--agent', 'tf2']));
  wr(d, `${t}/findings.json`, `${['{"mode":"diff","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","evidence_pruned":true,"gate":{"result":"PASS","failing":[]},',
    '"scope":{"slug":"diff","paths":["."],"commit":"abc1234","diff":{"base":"abc1234","thresholds":{"repeat":5,"mutation_budget":20,"slow_ratio":3},"changed_units":["impl.txt:lookup"],"tests":["lookup returns the stored value"],"mutants_run":1,"not_examined":[],',
    '"claims":[{"ac":"AC-1","test":"lookup returns the stored value","mutant":"lookup returns undefined for a stored key without throwing","outcome":"killed","failure":"assertion","killed_by":["lookup returns the stored value"]}]}},',
    '"findings":[]}'].join('\n')}\n`);
  // a proven claim passes the findings check; the small tier of this fixture does not require the gate itself
  expectMsg('a proven claim passes the findings check', 'not a required gate', AS(d, 'reviewer', ['submit', 'LC', '--focus', 'tests', '--confidence', 'high', '--agent', 'tf3']));
});

test('sc_defect_scope: a pre-existing defect marked decision: fix needs the user\'s scope approval at the first freeze; decision: report is only a finding', () => {
  let d = unfrozen('STANDARD');
  appendFileSync(path.join(d, '.agents/runs/LC/TASK.md'), '\n## Pre-existing defects\n\n- src/service.js:paginate: totalPages rounds down -- decision: fix\n');
  expectMsg("a pre-existing defect fix without the user's scope approval", 'scope approval for this PLAN.md', A(d, ['freeze', 'LC'], { bind: true }));
  assert.ok(A(d, ['next', 'LC']).out.split('\n').some((l) => l.startsWith('next=agent.sh request-approval LC scope')), `next does not ask for the scope approval: ${A(d, ['next', 'LC']).out}`);
  approveAsUser(d, 'scope', 'approve the scope');
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze refused with the scope approval');
  // a decision: report entry never needs one
  d = unfrozen('STANDARD');
  appendFileSync(path.join(d, '.agents/runs/LC/TASK.md'), '\n## Pre-existing defects\n\n- src/service.js:paginate: totalPages rounds down -- decision: report\n');
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'a reported defect needed a scope approval');
});

test('sc_intent_provenance: an answer to a scope decision recorded as the user\'s must be in a captured user prompt; a blanket answer only reports', () => {
  const d = unfrozen('STANDARD');
  const run = '.agents/runs/LC';
  wr(d, '.agents/local/prompts/history/1-aaaaaaaa.txt', 'Use your recommended option for every open question.\n');
  const intent = [ '# Intent: LC', '', '## Decision tree', '', '| id | branch | question | depends_on | status | decision | decided_by | source |', '|---|---|---|---|---|---|---|---|',
    '| D-12 | scope | Fix the paging defect in this change? | - | resolved | Fixed in this change | user | a) |', '', '## Rounds', '', '| round | asked | answer | answered_by |', '|---|---|---|---|',
    '| 1 | D-12 | a) fix the page count in this change (round up); AC-6 is in scope. | user |'];
  wr(d, `${run}/design/INTENT.md`, `${intent.join('\n')}\n`);
  expectMsg("an answer recorded as the user's that the user never said", 'in no captured user prompt', A(d, ['freeze', 'LC'], { bind: true }));
  wr(d, `${run}/design/INTENT.md`, rd(d, `${run}/design/INTENT.md`).split('\n').map((l) => (l.startsWith('| 1 | D-12 | ') ? '| 1 | D-12 | Use your recommended option for every open question. | user |' : l)).join('\n'));
  // A105: the verbatim blanket answer is the user's, but it never decides to fix a defect
  expectMsg('a blanket answer deciding a scope fix', 'blanket answer never decides a fix', A(d, ['freeze', 'LC'], { bind: true }));
  wr(d, `${run}/design/INTENT.md`, rd(d, `${run}/design/INTENT.md`).replace('| resolved | Fixed in this change |', '| resolved | Reported, left unchanged |'));
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'a blanket answer deciding report was refused');
});

test('sc_intent_provenance: the history files carry no line end, so an answer that spans two captured messages is no user answer (A247)', () => {
  const d = unfrozen('STANDARD');
  const run = '.agents/runs/LC';
  const answer = 'a) fix the page count in this change (round up); AC-6 is in scope.';
  const intent = (/** @type {string} */ a) => `${['# Intent: LC', '', '## Decision tree', '', '| id | branch | question | depends_on | status | decision | decided_by | source |', '|---|---|---|---|---|---|---|---|',
    '| D-12 | scope | Fix the paging defect in this change? | - | resolved | Reported, left unchanged | user | a) |', '', '## Rounds', '', '| round | asked | answer | answered_by |', '|---|---|---|---|',
    `| 1 | D-12 | ${a} | user |`].join('\n')}\n`;
  wr(d, `${run}/design/INTENT.md`, intent(answer));
  // two consecutive messages, as the prompt hook writes them: no line end in either file
  wr(d, '.agents/local/prompts/history/1-aaaaaaaa.txt', 'a) fix the page count in this ');   // a message may end on a blank
  wr(d, '.agents/local/prompts/history/2-bbbbbbbb.txt', 'change (round up); AC-6 is in scope.');
  expectMsg('an answer spanning two messages', 'in no captured user prompt', A(d, ['freeze', 'LC'], { bind: true }));
  // the same words in ONE message are the user's (white space still folds inside a message)
  rmSync(path.join(d, '.agents/local/prompts/history/2-bbbbbbbb.txt'));
  wr(d, '.agents/local/prompts/history/1-aaaaaaaa.txt', 'a) fix the page count in this\nchange (round up); AC-6 is in scope.');
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'an answer inside one message was refused');
});

test('sc_folded_defect: a COMPLEX task declares a folded defect fix; only the user\'s own scope approval unlocks the freeze; a reported or STANDARD defect task needs none (A105)', () => {
  let d = unfrozen('COMPLEX');
  const task = '.agents/runs/LC/TASK.md';
  wr(d, task, `${['# Task: LC — Tag books', '', '## Goal', '', '> I would like to tag the books in my reading list and filter by a tag.', '',
    '## Context', '', '- Decisions delegated to the recommended options: the paginate defect is fixed with a ceiling.', '', '## Acceptance criteria', '', '- AC-1: x', '', '## Suggested class', '', 'COMPLEX — persistence and contract change'].join('\n')}\n`);
  expectMsg('a COMPLEX task folding a defect fix without declaring it', 'mentions a defect or a fix the request does not ask for', A(d, ['freeze', 'LC'], { bind: true }));
  assert.ok(A(d, ['next', 'LC']).out.split('\n').some((l) => l.startsWith('next=fix TASK.md ## Pre-existing defects')), `next does not ask for the declaration: ${A(d, ['next', 'LC']).out}`);
  appendFileSync(path.join(d, task), '\n### Pre-existing defects\n\n- src/service.js:paginate: totalPages rounds down\n');
  expectMsg('a declared defect without a decision', 'entry without decision', A(d, ['freeze', 'LC'], { bind: true }));
  wr(d, task, rd(d, task).split('\n').map((l) => l.replace(/rounds down$/, 'rounds down -- decision: fix')).join('\n'));
  approveAsUser(d, 'plan', 'approve the plan');
  expectMsg("a declared defect fix without the user's scope approval", 'scope approval for this PLAN.md', A(d, ['freeze', 'LC'], { bind: true }));
  // a specialist question answered with the blanket reply does not unlock the freeze
  const BL = 'Use your recommended option for every open question.';
  wr(d, '.agents/q.md', 'QUESTIONS:\n1. Fix the paging defect in this change?\n   options: fix | report\n   recommended: report\n   why: not requested\n');
  must(d, ['ask', 'LC', '--file', path.join(d, '.agents/q.md')]);
  say(d, BL);
  must(d, ['answer', 'LC', '1'], { input: `${BL}\n` });
  // the Node core (A207, A210): typed text is the lead's answer, whatever was captured; only the prompt hook records an answer as the user's
  assert.ok(/^answered_by: lead/m.test(rd(d, '.agents/runs/LC/questions/001.answer.md')), "a typed blanket answer was recorded as the user's");
  expectMsg('a blanket answer as a scope approval', 'scope approval for this PLAN.md', A(d, ['freeze', 'LC'], { bind: true }));
  must(d, ['request-approval', 'LC', 'scope']);
  say(d, BL);
  expectMsg('a blanket prompt as a scope approval', 'no approval phrase', A(d, ['approve', 'LC', 'scope']));
  approveAsUser(d, 'scope', 'approve the scope');
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze refused with the scope approval');
  // declared as report: no approval needed; a STANDARD defect task is unaffected
  d = unfrozen('COMPLEX');
  wr(d, task, `${['# Task: LC — Tag books', '', '## Goal', '', '> I would like to tag books.', '', '## Context', '', '- The paginate defect is reported, not fixed.', '',
    '## Pre-existing defects', '', '- src/service.js:paginate: totalPages rounds down -- decision: report', '', '## Acceptance criteria', '', '- AC-1: x'].join('\n')}\n`);
  approveAsUser(d, 'plan', 'approve the plan');
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'a reported defect was refused');
  d = unfrozen('STANDARD');
  wr(d, task, `${['# Task: LC — Every book reachable', '', '## Goal', '', 'Every book is reachable through paging.', '', '## Context', '', '- The fix rounds the page count up.', '', '## Acceptance criteria', '', '- AC-1: x'].join('\n')}\n`);
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'a STANDARD defect task was refused');
});
