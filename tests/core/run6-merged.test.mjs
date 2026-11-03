// @ts-check
// Stage 6 (A215): a local origin, the manual merge proven from git (deliver-merged), the run's worktree that goes away with the merged run, and the proof that no
// file, flag, lock or environment value says "merged" (deliver-test.sh scenarios local_origin, manual_merge_*, wt_*, hand_pushed, relative_*).
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, rmSync, writeFileSync as wf } from 'node:fs';
import { test } from 'node:test';
import { A, DONE, TASKS_IN_TASKS, accepted, approveDelivery, existsSync, fakeGh, fakeTool, g, gOk, hooks, readFileSync, refused, run, verbs } from './run6-lib.mjs';
import { project, scripts } from './legacy-lib.mjs';

const RECIPE = `SC_BRANCH=1 scaffold orchestrated; ${TASKS_IN_TASKS}; to_code_done orchestrated; finish_done`;
const read = (/** @type {string} */ d, /** @type {string} */ f) => readFileSync(`${d}/${f}`, 'utf8');
const cli = (/** @type {string} */ d, /** @type {string[]} */ args) => run(d, 'node', [`${scripts}/proofline-core.mjs`, 'cli', 'platform-info', ...args]);

/** A bare repository that holds main of the project. @param {string} d @param {string} name */
function bareOrigin(d, name = 'lo.git') {
  const lo = `${d}-${name}`;
  rmSync(lo, { recursive: true, force: true });
  gOk(d, 'init', '-q', '--bare', lo);
  gOk(d, 'remote', 'set-url', 'origin', lo);
  gOk(d, '-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'main');
  return lo;
}

/** The delivery up to the pr step on a local origin (the hand-off to the user). @param {string} d @param {string} lo */
function loChain(d, lo) {
  const plan = accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan on a local origin');
  approveDelivery(d);
  accepted(A(d, ['deliver-step', 'LC', 'commit']), 'commit');
  A(d, ['task-source-done', 'LC']);
  gOk(d, 'add', '-A');
  assert.equal(run(d, 'git', ['commit', '-qF', '.agents/local/deliver/LC/COMMIT_MSG']).status, 0, 'the approved commit was blocked');
  accepted(A(d, ['deliver-step', 'LC', 'push']), 'push');
  gOk(d, 'push', '-q', 'origin', 'proofline/LC-lookup');
  void lo; void plan;
  return accepted(A(d, ['deliver-step', 'LC', 'pr']), 'pr');
}

test('a local path, a relative path or a file:// origin is platform other (commit push pr, hand-off git push origin <branch>:main); look-alikes are refused', () => {
  const d = project(RECIPE);
  hooks(d);
  const lo = `${d}-lo.git`; const rel = `${d}-rel.git`;
  gOk(d, 'init', '-q', '--bare', lo); gOk(d, 'init', '-q', '--bare', rel);
  const relName = `../${rel.slice(rel.lastIndexOf('/') + 1)}`;
  for (const u of [lo, relName, `file://${lo}`]) {
    gOk(d, 'remote', 'set-url', 'origin', u);
    assert.equal(cli(d, ['field', 'local', '-C', d]).out, 'yes\n');
    assert.equal(cli(d, ['field', 'platform', '-C', d]).out, 'other\n');
    const plan = accepted(A(d, ['deliver-plan', 'LC']), `deliver-plan on ${u}`).out;
    const sum = read(d, '.agents/local/deliver/LC/SUMMARY.md');
    assert.match(sum, /^steps: commit push pr$/m);
    assert.match(sum, /^merge_by: user$/m);
    const want = u.startsWith('../') ? run(d, 'sh', ['-c', `cd "${rel}" && pwd -P`]).out.trim() : 'origin';
    assert.ok(plan.includes(`git push ${want} proofline/LC-lookup:main`), `${u}: no 'git push ${want}' hand-off`);
  }
  for (const u of ['github.com.evil.example', 'https://github.com.evil.example', 'host.example']) {
    gOk(d, 'remote', 'set-url', 'origin', u);
    refused(A(d, ['deliver-plan', 'LC']), `deliver-plan on the look-alike origin ${u}`, 'delivery blocked');
  }
  gOk(d, 'remote', 'set-url', 'origin', lo);
  const glab = fakeTool('glab');
  refused(A(d, ['deliver-plan', 'LC'], { env: { PROOFLINE_PLATFORM: 'gitlab', PATH: `${glab}:${process.env.PATH}` } }), 'a configured CLI platform on a local origin', 'delivery blocked');
});

test('deliver-merged: not merged (or other content) records nothing and keeps the run; a squash merge is proven by identical content; a fast-forward by ancestry', () => {
  const d = project(RECIPE);
  hooks(d);
  const lo = bareOrigin(d);
  const pr = loChain(d, lo).out;
  assert.ok(existsSync(`${d}/.agents/local/deliver/LC/MERGE_HEAD`) && /deliver-merged LC/.test(pr), 'the pr step left no hand-off');
  mkdirSync(`${d}/.agents/local/batch`, { recursive: true });
  refused(A(d, ['deliver-merged', 'LC']), 'deliver-merged before the merge', 'not merged');
  assert.notEqual(A(d, ['deliver-merged', 'LC', '--check']).status, 0);
  assert.ok(!existsSync(`${d}/.agents/local/batch/merged.tsv`) && existsSync(`${d}/.agents/runs/LC`), 'a refused deliver-merged recorded or removed something');
  const c0 = `${d}-c0`;
  gOk(d, 'clone', '-q', lo, c0);
  gOk(c0, 'checkout', '-q', 'main');
  wf(`${c0}/other.txt`, 'other\n'); gOk(c0, 'add', 'other.txt'); gOk(c0, 'commit', '-qm', 'other'); gOk(c0, 'push', '-q', 'origin', 'main');
  refused(A(d, ['deliver-merged', 'LC']), 'origin moved on without the delivery', 'not merged');
  gOk(c0, 'fetch', '-q', 'origin'); gOk(c0, 'merge', '--squash', '-q', 'origin/proofline/LC-lookup'); gOk(c0, 'commit', '-qm', 'squash of LC'); gOk(c0, 'push', '-q', 'origin', 'main');
  assert.match(accepted(A(d, ['deliver-merged', 'LC', '--check']), 'check').out, /^merged: every delivered path has the same content/);
  const out = accepted(A(d, ['deliver-merged', 'LC']), 'deliver-merged on a squash').out;
  assert.match(out, /^merge recorded for LC: every delivered path has the same content/m);
  assert.match(read(d, '.agents/local/batch/merged.tsv'), /^LC\t-\t/m);
  assert.ok(!existsSync(`${d}/.agents/runs/LC`) && !existsSync(`${d}/.agents/local/deliver/LC`), 'squash: the run survived');
});

test('deliver-merged: a fast-forward merge is proven (ancestor of origin/main), recorded, the run is cleaned up', () => {
  const d = project(RECIPE);
  hooks(d);
  const lo = bareOrigin(d);
  loChain(d, lo);
  mkdirSync(`${d}/.agents/local/batch`, { recursive: true });
  gOk(d, `--git-dir=${lo}`, 'update-ref', 'refs/heads/main', g(d, 'rev-parse', 'proofline/LC-lookup'));
  const out = accepted(A(d, ['deliver-merged', 'LC']), 'deliver-merged').out;
  assert.match(out, /^merge recorded for LC: the delivered commit is on origin\/main/m);
  assert.match(out, /not on a clean main/);
  assert.match(read(d, '.agents/local/batch/merged.tsv'), /^LC\t-\t/m);
  assert.ok(!existsSync(`${d}/.agents/runs/LC`));
});

/** The finished run LC moves with its uncommitted work into its own worktree (night mode). @param {string} d @returns {string} the worktree */
function intoWorktree(d) {
  const r = verbs(d, `base=$DIR-aux; rm -rf "$base"; mkdir -p "$base"
git diff HEAD > "$base/mv.patch"; mkdir -p "$base/mv"
for f in $(git ls-files --others --exclude-standard | grep -v '^\\.agents/'); do mkdir -p "$base/mv/$(dirname "$f")"; cp "$f" "$base/mv/$f"; done
cp -R .agents/runs/LC "$base/mv-run"
git checkout -q -- .; git clean -fdq -e .agents; git checkout -q main; git branch -qD proofline/LC-lookup
rm -rf .agents/runs/LC; : > .agents/local/ACTIVE_RUN
wt=$(A worktree-add LC) || exit 1
git -C "$wt" checkout -q -b proofline/LC-lookup; [ ! -s "$base/mv.patch" ] || git -C "$wt" apply "$base/mv.patch" || exit 1
cp -R "$base/mv/." "$wt/"; mkdir -p "$wt/.agents/runs"; cp -R "$base/mv-run" "$wt/.agents/runs/LC"; echo LC > "$wt/.agents/local/ACTIVE_RUN"
mkdir -p .agents/local/batch
echo "WT=$wt"`);
  accepted(r, 'into the worktree');
  return /WT=(.*)$/m.exec(r.out)?.[1] ?? '';
}
const wtGone = (/** @type {string} */ d, /** @type {string} */ wt) => !existsSync(wt) && g(d, 'worktree', 'list').split('\n').length === 1;

/** A finished run in its own worktree. @param {string} d */
function wtDoneRun(d) {
  hooks(d);
  // the fixture's two-operation stub of the markdown adapter is a project script and would win over the built-in one: it is removed and committed, so the worktree has none either
  gOk(d, 'rm', '-q', '-f', '.agents/task-integrations/markdown.sh');
  gOk(d, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'drop the adapter stub', '--', '.agents/task-integrations/markdown.sh');
  const wt = intoWorktree(d);
  rmSync(`${wt}/.agents/task-integrations/markdown.sh`, { force: true }); // worktree-add copies the project's adapter folder
  return wt;
}

/** The delivery inside the worktree up to the hand-off to the user (local) or to the open pull request (gh). @param {string} d @param {string} wt @param {'local' | 'gh'} kind */
function wtDeliver(d, wt, kind) {
  let lo = '';
  if (kind === 'local') lo = bareOrigin(d);
  accepted(A(wt, ['deliver-plan', 'LC']), 'deliver-plan in the worktree');
  approveDelivery(d, undefined, wt);
  accepted(A(wt, ['deliver-step', 'LC', 'commit']), 'commit step in the worktree');
  A(wt, ['task-source-done', 'LC']);
  gOk(wt, 'add', '-A');
  const c = run(wt, 'git', ['commit', '-qF', '.agents/local/deliver/LC/COMMIT_MSG']);
  assert.equal(c.status, 0, `the commit in the worktree was blocked: ${c.text}`);
  accepted(A(wt, ['deliver-step', 'LC', 'push']), 'push step in the worktree');
  if (kind === 'local') gOk(wt, 'push', '-q', 'origin', 'proofline/LC-lookup');
  else { gOk(wt, 'push', '-q', 'bare', 'proofline/LC-lookup'); gOk(wt, 'update-ref', 'refs/remotes/origin/proofline/LC-lookup', 'HEAD'); }
  return { lo, pr: accepted(A(wt, ['deliver-step', 'LC', 'pr']), 'pr step in the worktree') };
}

test('deliver-merged inside the run\'s worktree: merge proven from git, recorded, local main fast-forwarded, the worktree removed; the final status block lands in the main tree', () => {
  const d = project(RECIPE);
  const wt = wtDoneRun(d);
    const { lo } = wtDeliver(d, wt, 'local');
  refused(A(wt, ['deliver-merged', 'LC']), 'deliver-merged before the merge', 'not merged');
  assert.ok(existsSync(wt), 'an unmerged run lost its worktree');
  const taskFile = run(wt, 'find', ['tasks', '-name', 'LC*.md']).out.split('\n')[0];
  assert.match(read(wt, taskFile), /^- stage: PR OPEN/m, 'the pr step left no PR OPEN block');
  const sha = g(wt, 'rev-parse', 'HEAD');
  gOk(d, `--git-dir=${lo}`, 'update-ref', 'refs/heads/main', sha);
  const out = accepted(A(wt, ['deliver-merged', 'LC']), 'deliver-merged in the worktree').out;
  assert.match(out, /^worktree removed: LC/m);
  assert.ok(wtGone(d, wt), 'the worktree survived deliver-merged');
  assert.match(read(d, '.agents/local/batch/merged.tsv'), /^LC\t-\t/m);
  assert.equal(g(d, 'rev-parse', 'main'), g(d, `--git-dir=${lo}`, 'rev-parse', 'main'), 'the local main was not brought to the merge');
  const mainFile = run(d, 'find', ['tasks', '-name', 'LC*.md']).out.split('\n')[0];
  const blk = read(d, mainFile);
  assert.equal((blk.match(/^## Proofline Status/gm) ?? []).length, 1, 'not exactly one status section');
  assert.match(blk, /^- stage: MERGED$/m);
  assert.match(blk, /^- event: merged$/m);
  assert.ok(blk.includes(`- delivered_commit: ${sha.slice(0, 12)}`), 'no delivered commit in the final block');
});

test('a task file changed by more than the task\'s own status block keeps the worktree', () => {
  const d = project(RECIPE);
  const wt = wtDoneRun(d);
    const { lo } = wtDeliver(d, wt, 'local');
  const f = `${wt}/${run(wt, 'find', ['tasks', '-name', 'LC*.md']).out.split('\n')[0]}`;
  wf(f, `${readFileSync(f, 'utf8')}\n## Proofline Status\n\n<!-- PROOFLINE-STATUS:BEGIN:OTHER-1 -->\n- run: OTHER-1\n<!-- PROOFLINE-STATUS:END:OTHER-1 -->\n`);
  gOk(d, `--git-dir=${lo}`, 'update-ref', 'refs/heads/main', g(wt, 'rev-parse', 'HEAD'));
  A(wt, ['deliver-merged', 'LC']);
  assert.ok(existsSync(wt), 'a second marked block did not keep the worktree');
});

test('deliver-step cleanup after a merged pull request removes the worktree and leaves the main tree clean', () => {
  const gh = fakeGh();
  const d = project(RECIPE);
  const wt = wtDoneRun(d);
  gOk(d, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
  gOk(d, 'init', '-q', '--bare', `${d}-bare.git`);
  gOk(d, 'remote', 'add', 'bare', `${d}-bare.git`);
    wtDeliver(d, wt, 'gh');
  const h = g(wt, 'rev-parse', 'HEAD');
  gh.says('OPEN', h);
  accepted(A(wt, ['deliver-step', 'LC', 'merge', '7'], { env: gh.env }), 'merge step in the worktree');
  gh.says('MERGED', h);
  const out = accepted(A(wt, ['deliver-step', 'LC', 'cleanup', '7'], { env: gh.env }), 'cleanup step in the worktree').out;
  assert.match(out, /^worktree removed: LC/m);
  assert.ok(wtGone(d, wt), 'the worktree survived deliver-step cleanup');
  assert.equal(g(d, 'status', '--porcelain', '--untracked-files=no'), '', 'the main working tree is dirty after deliver-step cleanup');
});

test('a cleanup that fails after the merge step is recorded can be repeated: the batch row written before it lets a standalone `cleanup` remove the worktree', () => {
  const gh = fakeGh();
  const d = project(RECIPE);
  const wt = wtDoneRun(d);
  gOk(d, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
  gOk(d, 'init', '-q', '--bare', `${d}-bare.git`);
  gOk(d, 'remote', 'add', 'bare', `${d}-bare.git`);
  wtDeliver(d, wt, 'gh');
  const h = g(wt, 'rev-parse', 'HEAD');
  gh.says('OPEN', h);
  accepted(A(wt, ['deliver-step', 'LC', 'merge', '7'], { env: gh.env }), 'merge step');
  gh.says('MERGED', h);
  // the assignments folder of the run is a link: cleanup refuses to remove it, after the approval was consumed
  mkdirSync(`${wt}/.agents/local`, { recursive: true });
  mkdirSync(`${d}-elsewhere`, { recursive: true });
  run(wt, 'ln', ['-s', `${d}-elsewhere`, `${wt}/.agents/local/assignments`]);
  mkdirSync(`${d}-elsewhere/LC`, { recursive: true });
  const first = A(wt, ['deliver-step', 'LC', 'cleanup', '7'], { env: gh.env });
  assert.notEqual(first.status, 0, 'the cleanup should have failed');
  assert.ok(existsSync(wt) && existsSync(`${wt}/.agents/runs/LC`), 'the run or the worktree went in a failed cleanup');
  assert.match(read(d, '.agents/local/batch/merged.tsv'), /^LC\t7\t[0-9]+$/m, 'the merge row is written before the cleanup');
  refused(A(wt, ['deliver-step', 'LC', 'cleanup', '7'], { env: gh.env }), 'the step cannot run twice', 'already used');
  rmSync(`${wt}/.agents/local/assignments`);
  const second = accepted(A(wt, ['cleanup', 'LC']), 'a standalone cleanup after the failure');
  assert.match(second.out, /^worktree removed: LC/m);
  assert.ok(wtGone(d, wt));
});

test('cleanup: removes the worktree once the merge is on record (a batch row), also a leftover one from the main tree; a BLOCKED run keeps it', () => {
  const d = project(RECIPE);
  const wt = wtDoneRun(d);
  A(wt, ['task-source-done', 'LC']);
  gOk(wt, 'add', '-A');
  gOk(wt, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'feat: delivered');
  const row = `LC\t-\t${Math.floor(Date.now() / 1000)}\n`;
  wf(`${d}/.agents/local/batch/merged.tsv`, row);
  const out = accepted(A(wt, ['cleanup', 'LC']), 'cleanup in the worktree').out;
  assert.match(out, /^worktree removed: LC/m);
  assert.ok(wtGone(d, wt));
  const wt2 = accepted(verbs(d, 'A worktree-add LC'), 'worktree-add').out.trim().split('\n').pop() ?? '';
  assert.ok(existsSync(wt2), 'no leftover worktree');
  accepted(A(d, ['cleanup', 'LC']), 'cleanup of a leftover worktree from the main tree');
  assert.ok(wtGone(d, wt2), 'the leftover worktree survived');
  // a terminated run keeps its evidence even with a merge on record
  const b = project('SC_BRANCH=1 scaffold orchestrated');
  hooks(b);
  const wtb = intoWorktree(b);
  wf(`${b}/.agents/local/batch/merged.tsv`, row);
  accepted(A(wtb, ['terminate', 'LC', 'BLOCKED'], { input: 'reason: the registry the build needs is unreachable from this environment\nevidence: the install command fails with a network error on every retry\n' }), 'terminate');
  const cl = accepted(A(wtb, ['cleanup', 'LC']), 'cleanup of a BLOCKED run').out;
  assert.ok(existsSync(wtb) && !/worktree removed/.test(cl), 'a BLOCKED run lost its worktree');
});

test('no file, flag, lock or environment value says "merged": a hand-written MERGED file, a forged lock with --delivered, an environment claim and another run\'s row remove nothing', () => {
  const d = project(RECIPE);
  const wt = wtDoneRun(d);
  A(wt, ['task-source-done', 'LC']);
  gOk(wt, 'add', '-A');
  gOk(wt, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'feat: delivered');
  mkdirSync(`${wt}/.agents/local/deliver/LC`, { recursive: true });
  wf(`${wt}/.agents/local/deliver/LC/MERGED`, `${Math.floor(Date.now() / 1000) + 5}\n`);
  const claim = A(wt, ['cleanup', 'LC', '--delivered'], { env: { CLEANUP_MERGED: 'yes' } });
  assert.ok(existsSync(wt) && !/worktree removed/.test(claim.out), `a typed claim removed the worktree: ${claim.text}`);
  assert.match(claim.out, /no merge of LC is on record/);
  const other = project(RECIPE);
  const wt2 = wtDoneRun(other);
  A(wt2, ['task-source-done', 'LC']);
  gOk(wt2, 'add', '-A');
  gOk(wt2, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'feat: delivered');
  wf(`${other}/.agents/local/batch/merged.tsv`, `OTHER\t-\t${Math.floor(Date.now() / 1000)}\n`);
  const c2 = accepted(A(wt2, ['cleanup', 'LC']), 'cleanup');
  assert.ok(existsSync(wt2) && !/worktree removed/.test(c2.out), "another run's merged row removed the worktree");
  // an ignored file of the run's own keeps the worktree
  const third = project(RECIPE);
  const wt3 = wtDoneRun(third);
  A(wt3, ['task-source-done', 'LC']);
  gOk(wt3, 'add', '-A');
  gOk(wt3, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'feat: delivered');
  wf(`${third}/.agents/local/batch/merged.tsv`, `LC\t-\t${Math.floor(Date.now() / 1000)}\n`);
  wf(`${wt3}/notes-by-hand.log`, 'evidence\n');
  gOk(third, 'rev-parse', '--git-common-dir');
  wf(`${g(third, 'rev-parse', '--absolute-git-dir')}/info/exclude`, '*.log\n');
  const c3 = accepted(A(wt3, ['cleanup', 'LC']), 'cleanup');
  assert.ok(existsSync(`${wt3}/notes-by-hand.log`) && /holds files git does not track/.test(c3.out), 'a worktree with an ignored file of its own was removed');
});

test('a relative local origin: a worktree proves the merge, the shown commands name the origin absolute, the approved head is pushed by the step, remote.origin.url is never rewritten', () => {
  const d = project(RECIPE);
  const wt = wtDoneRun(d);
  const lo = `${d}-lo.git`;
  gOk(d, 'init', '-q', '--bare', lo);
  gOk(d, 'remote', 'set-url', 'origin', `../${lo.slice(lo.lastIndexOf('/') + 1)}`);
  gOk(d, '-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'main');
  const plan = accepted(A(wt, ['deliver-plan', 'LC']), 'deliver-plan in the worktree').out;
  const loAbs = run(d, 'sh', ['-c', `cd "${lo}" && pwd -P`]).out.trim();
  assert.ok(plan.includes(`git push ${loAbs} proofline/LC-lookup`) && plan.includes(`git push ${loAbs} proofline/LC-lookup:main`), 'the plan shows a relative origin');
  approveDelivery(d, undefined, wt);
  accepted(A(wt, ['deliver-step', 'LC', 'commit']), 'commit');
  A(wt, ['task-source-done', 'LC']);
  gOk(wt, 'add', '-A');
  assert.equal(run(wt, 'git', ['commit', '-qF', '.agents/local/deliver/LC/COMMIT_MSG']).status, 0);
  const push = accepted(A(wt, ['deliver-step', 'LC', 'push']), 'push').out;
  assert.ok(push.includes(`pushed: proofline/LC-lookup -> ${loAbs}`), `the push step did not push to the absolute origin: ${push}`);
  assert.match(read(wt, `.agents/runs/LC/approvals/${requireNames(wt).find((n) => n.endsWith('-push.yaml') && !n.includes('request'))}`), /consumed: "true"/);
  assert.equal(g(d, `--git-dir=${lo}`, 'rev-parse', '-q', '--verify', 'refs/heads/proofline/LC-lookup'), g(wt, 'rev-parse', 'HEAD'));
  const pr = accepted(A(wt, ['deliver-step', 'LC', 'pr']), 'pr').out;
  assert.ok(pr.includes(`git push ${loAbs} proofline/LC-lookup:main`));
  refused(A(wt, ['deliver-merged', 'LC', '--check']), 'before the merge', 'open: ');
  gOk(d, `--git-dir=${lo}`, 'update-ref', 'refs/heads/main', g(wt, 'rev-parse', 'HEAD'));
  assert.match(accepted(A(wt, ['deliver-merged', 'LC', '--check']), 'check').out, /^merged: the delivered commit is on origin\/main/);
  assert.equal(g(d, 'config', 'remote.origin.url'), `../${lo.slice(lo.lastIndexOf('/') + 1)}`);
});

test('a relative origin: a changed origin and an option-like origin are refused, nothing is pushed; an empty delivery records no merge', () => {
  const d = project(RECIPE);
  const wt = wtDoneRun(d);
  const lo = `${d}-lo.git`; const lo2 = `${d}-lo2.git`;
  gOk(d, 'init', '-q', '--bare', lo); gOk(d, 'init', '-q', '--bare', lo2);
  const rel = (/** @type {string} */ p) => `../${p.slice(p.lastIndexOf('/') + 1)}`;
  gOk(d, 'remote', 'set-url', 'origin', rel(lo));
  gOk(d, '-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'main');
  accepted(A(wt, ['deliver-plan', 'LC']), 'deliver-plan');
  approveDelivery(d, undefined, wt);
  accepted(A(wt, ['deliver-step', 'LC', 'commit']), 'commit');
  A(wt, ['task-source-done', 'LC']);
  gOk(wt, 'add', '-A');
  assert.equal(run(wt, 'git', ['commit', '-qF', '.agents/local/deliver/LC/COMMIT_MSG']).status, 0);
  gOk(d, 'remote', 'set-url', 'origin', rel(lo2));
  refused(A(wt, ['deliver-step', 'LC', 'push']), 'the push step after the origin changed', 'origin changed since the summary was approved');
  assert.equal(g(d, `--git-dir=${lo2}`, 'for-each-ref', 'refs/heads/proofline'), '', 'a branch reached the changed origin');
  gOk(d, 'config', 'remote.origin.url', '-oProxyCommand=touch');
  const opt = A(wt, ['deliver-step', 'LC', 'push']);
  assert.ok(!/^pushed:/m.test(opt.out), 'the push step pushed to an option-like origin');
  assert.ok(!existsSync(`${wt}/touch`) && !existsSync(`${d}/touch`), 'an option-like origin was executed');
  gOk(d, 'remote', 'set-url', 'origin', rel(lo));
  accepted(A(wt, ['deliver-step', 'LC', 'push']), 'push step');
  assert.equal(g(d, `--git-dir=${lo}`, 'rev-parse', 'refs/heads/proofline/LC-lookup'), g(wt, 'rev-parse', 'HEAD'), 'the approved head was not pushed');
  accepted(A(wt, ['deliver-step', 'LC', 'pr']), 'pr step');
  const base = /^ {2}base_sha: *"?([0-9a-f]+)"?/m.exec(read(wt, '.agents/runs/LC/RUN.yaml'))?.[1] ?? '';
  wf(`${wt}/.agents/local/deliver/LC/MERGE_HEAD`, `${base}\tmain\tproofline/LC-lookup\n`);
  refused(A(wt, ['deliver-merged', 'LC']), 'deliver-merged of an empty delivery', 'empty delivery');
  assert.ok(!existsSync(`${d}/.agents/local/batch/merged.tsv`) || read(d, '.agents/local/batch/merged.tsv') === '', 'an empty delivery was recorded as merged');
});

test('a push git itself refuses (the relative origin rejects the branch) says why in the message', () => {
  const d = project(RECIPE);
  const wt = wtDoneRun(d);
  const lo = `${d}-lo.git`;
  gOk(d, 'init', '-q', '--bare', lo);
  gOk(d, 'remote', 'set-url', 'origin', `../${lo.slice(lo.lastIndexOf('/') + 1)}`);
  gOk(d, '-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'main');
  accepted(A(wt, ['deliver-plan', 'LC']), 'deliver-plan');
  approveDelivery(d, undefined, wt);
  accepted(A(wt, ['deliver-step', 'LC', 'commit']), 'commit');
  A(wt, ['task-source-done', 'LC']);
  gOk(wt, 'add', '-A');
  assert.equal(run(wt, 'git', ['commit', '-qF', '.agents/local/deliver/LC/COMMIT_MSG']).status, 0);
  wf(`${lo}/hooks/pre-receive`, '#!/bin/sh\necho "rejected by the test origin" >&2\nexit 1\n');
  run(d, 'chmod', ['+x', `${lo}/hooks/pre-receive`]);
  refused(A(wt, ['deliver-step', 'LC', 'push']), 'a push the origin rejects', 'rejected by the test origin');
});

test('a delivery the user pushed by hand is recovered from the delivered branch\'s current head; the base is never the delivery, an unmerged push is not recorded', () => {
  const d = project(RECIPE);
  const wt = wtDoneRun(d);
  const lo = bareOrigin(d);
  accepted(A(wt, ['deliver-plan', 'LC']), 'deliver-plan');
  refused(A(wt, ['deliver-merged', 'LC']), 'no delivery commit beyond the base', 'no delivery commit');
  assert.ok(!existsSync(`${wt}/.agents/local/deliver/LC/MERGE_HEAD`), 'a hand-off was written without a delivery commit');
  approveDelivery(d, undefined, wt);
  accepted(A(wt, ['deliver-step', 'LC', 'commit']), 'commit');
  A(wt, ['task-source-done', 'LC']);
  gOk(wt, 'add', '-A');
  assert.equal(run(wt, 'git', ['commit', '-qF', '.agents/local/deliver/LC/COMMIT_MSG']).status, 0);
  gOk(wt, '-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'proofline/LC-lookup');
  refused(A(wt, ['deliver-merged', 'LC']), 'pushed by hand, not merged', 'not merged');
  assert.ok(!existsSync(`${d}/.agents/local/batch/merged.tsv`) || !/^LC\t/m.test(read(d, '.agents/local/batch/merged.tsv')), 'an unmerged hand push was recorded');
  assert.ok(existsSync(`${wt}/.agents/runs/LC`), 'the run went before the merge');
  gOk(d, `--git-dir=${lo}`, 'update-ref', 'refs/heads/main', g(wt, 'rev-parse', 'HEAD'));
  assert.match(accepted(A(wt, ['deliver-merged', 'LC']), 'merged by hand').out, /^merge recorded for LC/m);
});

test('the approved commands\' uncommitted config edit is dropped once origin has that content, so the local main fast-forwards', () => {
  const d = project(RECIPE);
  const wt = wtDoneRun(d);
  const { lo } = wtDeliver(d, wt, 'local');
  const c9 = `${d}-c9`;
  gOk(d, 'clone', '-q', lo, c9);
  gOk(c9, 'checkout', '-q', 'proofline/LC-lookup');
  wf(`${c9}/.agents/config.yaml`, `${readFileSync(`${c9}/.agents/config.yaml`, 'utf8')}# approved commands\n`);
  gOk(c9, 'add', '.agents/config.yaml');
  gOk(c9, '-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'cfg');
  gOk(c9, 'push', '-q', 'origin', 'HEAD:main');
  copyFileSync(`${c9}/.agents/config.yaml`, `${d}/.agents/config.yaml`);
  const out = accepted(A(wt, ['deliver-merged', 'LC']), 'deliver-merged').out;
  assert.match(out, /local \.agents\/config\.yaml edit was dropped/);
  assert.match(out, /^local main fast-forwarded/m);
  assert.equal(g(d, 'status', '--porcelain', '--untracked-files=no'), '');
});

/** @param {string} d */
function requireNames(d) { return existsSync(`${d}/.agents/runs/LC/approvals`) ? readdir(`${d}/.agents/runs/LC/approvals`) : []; }
import { readdirSync as readdir } from 'node:fs';
void [DONE, run];
