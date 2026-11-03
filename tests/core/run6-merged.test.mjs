// @ts-check
// Stage 6 (A215): a local origin, the manual merge proven from git (deliver-merged), the run's worktree that goes away with the merged run, and the proof that no
// file, flag, lock or environment value says "merged" (deliver-test.sh scenarios local_origin, manual_merge_*, wt_*, hand_pushed, relative_*).
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync as wf } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('SECURITY (A215 round 3): a remote re-pointed after the summary was approved, or url.<x>.insteadOf, never proves a merge; deliver-merged names the change and records nothing', () => {
  const d = project(RECIPE);
  hooks(d);
  const lo = bareOrigin(d);
  loChain(d, lo);
  mkdirSync(`${d}/.agents/local/batch`, { recursive: true });
  assert.notEqual(A(d, ['deliver-merged', 'LC']).status, 0, 'precondition: not merged on the real origin');
  const realMain = g(d, `--git-dir=${lo}`, 'rev-parse', 'refs/heads/main');
  const fake = `${d}/.agents/local/scratch/fake.git`;
  gOk(d, 'clone', '-q', '--bare', lo, fake);
  gOk(d, `--git-dir=${fake}`, 'update-ref', 'refs/heads/main', g(d, 'rev-parse', 'proofline/LC-lookup'));
  // 1. origin re-pointed at a fake that says "merged"
  gOk(d, 'remote', 'set-url', 'origin', fake);
  let out = A(d, ['deliver-merged', 'LC']);
  assert.notEqual(out.status, 0, out.text);
  assert.match(out.text, /origin changed since the summary was approved/);
  assert.ok(existsSync(`${d}/.agents/runs/LC`), 'the run is kept');
  assert.ok(!/^LC\t/m.test(existsSync(`${d}/.agents/local/batch/merged.tsv`) ? read(d, '.agents/local/batch/merged.tsv') : ''), 'nothing recorded');
  // 2. the url kept, an insteadOf rewrite sends it to the fake
  gOk(d, 'remote', 'set-url', 'origin', lo);
  gOk(d, 'config', `url.${fake}.insteadOf`, lo);
  out = A(d, ['deliver-merged', 'LC']);
  assert.notEqual(out.status, 0, out.text);
  assert.match(out.text, /origin changed since the summary was approved/);
  assert.equal(g(d, `--git-dir=${lo}`, 'rev-parse', 'refs/heads/main'), realMain);
});

test('SECURITY (A215 round 3): a fake git first on PATH (in the project) neither fakes the merge-proof fetch nor is run by the delivery', () => {
  const d = project(RECIPE);
  hooks(d);
  const lo = bareOrigin(d);
  loChain(d, lo);
  mkdirSync(`${d}/.agents/local/batch`, { recursive: true });
  const realGit = run(d, 'sh', ['-c', 'command -v git']).out.trim();
  const bin = `${d}/.agents/local/scratch/bin`;
  mkdirSync(bin, { recursive: true });
  const mark = `${d}/.agents/local/scratch/fake-git-ran`;
  wf(`${bin}/git`, `#!/bin/sh\necho "$*" >> "${mark}"\nfor a in "$@"; do if [ "$a" = fetch ]; then "${realGit}" -C "$2" update-ref refs/remotes/origin/main "$("${realGit}" -C "$2" rev-parse proofline/LC-lookup)"; exit 0; fi; done\nexec "${realGit}" "$@"\n`);
  chmodSync(`${bin}/git`, 0o755);
  const out = A(d, ['deliver-merged', 'LC'], { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.notEqual(out.status, 0, out.text);
  assert.ok(!/fetch/.test(existsSync(mark) ? read(d, '.agents/local/scratch/fake-git-ran') : ''), 'the fake git never answered the fetch');
  assert.ok(existsSync(`${d}/.agents/runs/LC`), 'the run is kept');
  assert.ok(!/^LC\t/m.test(existsSync(`${d}/.agents/local/batch/merged.tsv`) ? read(d, '.agents/local/batch/merged.tsv') : ''), 'nothing recorded');
});

test('SECURITY (A215 round 4): a re-plan after the approvals rewrites the summary and its origin pins; the proof then needs the approval chain of THAT summary, so it records nothing', () => {
  const d = project(RECIPE);
  hooks(d);
  const lo = bareOrigin(d);
  loChain(d, lo);
  mkdirSync(`${d}/.agents/local/batch`, { recursive: true });
  const realMain = g(d, `--git-dir=${lo}`, 'rev-parse', 'refs/heads/main');
  const fake = `${d}/.agents/local/scratch/fake.git`;
  gOk(d, 'clone', '-q', '--bare', lo, fake);
  gOk(d, `--git-dir=${fake}`, 'update-ref', 'refs/heads/main', g(d, 'rev-parse', 'proofline/LC-lookup'));
  gOk(d, 'remote', 'set-url', 'origin', fake);
  A(d, ['deliver-plan', 'LC']);
  const out = A(d, ['deliver-merged', 'LC']);
  assert.notEqual(out.status, 0, out.text);
  assert.match(out.text, /summary the user approved|approval/i);
  assert.ok(existsSync(`${d}/.agents/runs/LC`), 'the run is kept');
  assert.ok(!/^LC\t/m.test(existsSync(`${d}/.agents/local/batch/merged.tsv`) ? read(d, '.agents/local/batch/merged.tsv') : ''), 'nothing recorded');
  assert.equal(g(d, `--git-dir=${lo}`, 'rev-parse', 'refs/heads/main'), realMain);
});

test('SECURITY (A215 round 4): the merge-proof fetch is hermetic: a repository config (a reference-transaction hook through core.hooksPath) cannot move origin/main during it', () => {
  const d = project(RECIPE);
  hooks(d);
  const lo = bareOrigin(d);
  loChain(d, lo);
  mkdirSync(`${d}/.agents/local/batch`, { recursive: true });
  const realMain = g(d, `--git-dir=${lo}`, 'rev-parse', 'refs/heads/main');
  const realGit = run(d, 'sh', ['-c', 'command -v git']).out.trim();
  const hd = `${d}/.agents/local/scratch/hk`;
  mkdirSync(hd, { recursive: true });
  const del = g(d, 'rev-parse', 'proofline/LC-lookup');
  wf(`${hd}/reference-transaction`, `#!/bin/sh\n[ "$1" = committed ] || exit 0\n[ -n "$PL_X" ] && exit 0\nif grep -q ' refs/remotes/origin/main$'; then PL_X=1 "${realGit}" update-ref refs/remotes/origin/main ${del}; fi\nexit 0\n`);
  chmodSync(`${hd}/reference-transaction`, 0o755);
  gOk(d, 'config', 'core.hooksPath', hd);
  const out = A(d, ['deliver-merged', 'LC']);
  assert.notEqual(out.status, 0, out.text);
  assert.ok(!/^LC\t/m.test(existsSync(`${d}/.agents/local/batch/merged.tsv`) ? read(d, '.agents/local/batch/merged.tsv') : ''), 'nothing recorded');
  assert.equal(g(d, `--git-dir=${lo}`, 'rev-parse', 'refs/heads/main'), realMain);
});

test('SECURITY (A215 round 4): hermeticFetch reads the pinned url with no repository config (core.sshCommand, http.proxy and the like never apply) and leaves the project refs alone', async () => {
  const { hermeticFetch } = await import('../../control-plane/agents/scripts/core/deliver.mjs');
  const base = mkdtempSync(path.join(tmpdir(), 'hf-'));
  const w = `${base}/w`; const real = `${base}/real.git`; const fake = `${base}/fake.git`;
  gOk(base, 'init', '-q', '-b', 'main', w);
  gOk(w, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  gOk(base, 'clone', '-q', '--bare', w, real);
  gOk(w, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'delivered');
  gOk(base, 'clone', '-q', '--bare', w, fake);
  const realGit = run(w, 'sh', ['-c', 'command -v git']).out.trim();
  const ctx = /** @type {any} */ ({ env: { PATH: '/usr/bin:/bin' }, cwd: w, root: w, childEnv: () => ({ PATH: '/usr/bin:/bin' }), sharedMain: () => w });
  // a local url: with the project config nothing changes, the real repository is read
  const ok = hermeticFetch(ctx, realGit, real, 'main');
  assert.ok(ok !== null && ok.tip === g(w, '--git-dir', real, 'rev-parse', 'main'), 'the pinned url is read');
  assert.ok(existsSync(ok.tmp));
  ok.done();
  assert.ok(!existsSync(ok.tmp), 'the temporary repository is removed');
  // an ssh url the project config would serve from a fake repository: the config is ignored, so the fetch fails here
  gOk(w, 'config', 'core.sshCommand', `sh -c 'exec git-upload-pack ${fake}' x`);
  const bad = hermeticFetch(ctx, realGit, 'ssh://git.example.invalid/acme/app.git', 'main');
  assert.equal(bad, null, 'the project sshCommand did not serve the fetch');
  assert.equal(g(w, 'for-each-ref', 'refs/remotes'), '', 'no project ref was written');
});

test('SECURITY (A215 round 5): the hermetic repository fails closed when anything of it changed (a refs/replace planted by a same-user process), and its folder is not in the shared temporary folder', async () => {
  const { hermeticFetch } = await import('../../control-plane/agents/scripts/core/deliver.mjs');
  const base = mkdtempSync(path.join(tmpdir(), 'hf5-'));
  const w = `${base}/w`; const real = `${base}/real.git`;
  gOk(base, 'init', '-q', '-b', 'main', w);
  gOk(w, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  gOk(base, 'clone', '-q', '--bare', w, real);
  const realGit = run(w, 'sh', ['-c', 'command -v git']).out.trim();
  const ctx = /** @type {any} */ ({ env: { PATH: '/usr/bin:/bin' }, cwd: w, root: w, childEnv: () => ({ PATH: '/usr/bin:/bin' }), sharedMain: () => w });
  const hf = hermeticFetch(ctx, realGit, real, 'main');
  assert.ok(hf !== null);
  assert.ok(hf.intact(), 'untouched');
  assert.ok(!hf.tmp.startsWith(`${tmpdir()}/pl-proof-`), `the folder has a predictable place: ${hf.tmp}`);
  const F = gOk(w, 'commit-tree', `${hf.tip}^{tree}`, '-m', 'other');
  hf.gp(['update-ref', `refs/replace/${hf.tip}`, F]);
  assert.equal(hf.intact(), false, 'a planted replace ref is noticed');
  hf.done();
  const hf2 = hermeticFetch(ctx, realGit, real, 'main');
  assert.ok(hf2 !== null);
  wf(`${hf2.tmp}/info-grafts-probe`, '');
  wf(`${hf2.tmp}/hooks-probe`, '');
  mkdirSync(`${hf2.tmp}/info`, { recursive: true });
  wf(`${hf2.tmp}/info/grafts`, `${hf2.tip}\n`);
  assert.equal(hf2.intact(), false, 'a planted grafts file is noticed');
  hf2.done();
});

test('SECURITY (A215 round 5): a loose object of the project store rewritten in place (git does not hash-check an object it reads) is caught: the history is walked with every commit re-hashed', async () => {
  const { hermeticFetch } = await import('../../control-plane/agents/scripts/core/deliver.mjs');
  const { deflateSync } = await import('node:zlib');
  const base = mkdtempSync(path.join(tmpdir(), 'hf5b-'));
  const w = `${base}/w`; const real = `${base}/real.git`;
  const id = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
  gOk(base, 'init', '-q', '-b', 'main', w);
  gOk(w, ...id, 'commit', '-q', '--allow-empty', '-m', 'base');
  const c0 = g(w, 'rev-parse', 'HEAD');
  gOk(base, 'clone', '-q', '--bare', w, real);
  gOk(w, ...id, 'commit', '-q', '--allow-empty', '-m', 'someone else landed this');
  const c1 = g(w, 'rev-parse', 'HEAD');
  gOk(w, ...id, 'commit', '-q', '--allow-empty', '-m', 'and this');
  const x = g(w, 'rev-parse', 'HEAD');
  gOk(w, 'push', '-q', real, 'HEAD:refs/heads/main');
  gOk(w, 'update-ref', 'refs/remotes/origin/main', x);
  const tree = g(w, 'rev-parse', `${c0}^{tree}`);
  const d = gOk(w, 'commit-tree', tree, '-p', c0, '-m', 'delivered, never merged');
  const realGit = run(w, 'sh', ['-c', 'command -v git']).out.trim();
  const ctx = /** @type {any} */ ({ env: { PATH: '/usr/bin:/bin' }, cwd: w, root: w, childEnv: () => ({ PATH: '/usr/bin:/bin' }), sharedMain: () => w });
  const honest = hermeticFetch(ctx, realGit, real, 'main');
  assert.ok(honest !== null);
  assert.equal(honest.reaches(d, c0), false, 'the delivered commit is not on origin');
  assert.equal(honest.reaches(c1, c0), true, 'a commit that is on the history is found');
  assert.ok(honest.verify(c0, [d]), 'an honest range re-hashes');
  honest.done();
  // the forgery: the loose object of a commit of the range rewritten so that its parent is the delivered commit
  const f = `${w}/.git/objects/${c1.slice(0, 2)}/${c1.slice(2)}`;
  chmodSync(f, 0o644);
  const body = `tree ${tree}\nparent ${d}\nauthor t <t@t> 1 +0000\ncommitter t <t@t> 1 +0000\n\nforged\n`;
  wf(f, deflateSync(Buffer.concat([Buffer.from(`commit ${Buffer.byteLength(body)}\0`), Buffer.from(body)])));
  const hf = hermeticFetch(ctx, realGit, real, 'main');
  assert.ok(hf !== null);
  assert.equal(hf.gp(['merge-base', '--is-ancestor', d, hf.tip]).status, 0, 'the forgery fakes the ancestry for git itself (it does not hash-check)');
  assert.throws(() => hf.reaches(d, c0), /does not match its hash/, 'the walk re-hashes every commit and refuses');
  assert.throws(() => hf.verify(c0, [d]), /does not match its hash/);
  hf.done();
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
  // the only change left in the main tree is the status block the control plane put into the task file (a block-only change never stops a fast-forward)
  assert.ok(['', ' M tasks/done/LC.md'].includes(g(d, 'status', '--porcelain', '--untracked-files=no')), g(d, 'status', '--porcelain', '--untracked-files=no'));
});

/** @param {string} d */
function requireNames(d) { return existsSync(`${d}/.agents/runs/LC/approvals`) ? readdir(`${d}/.agents/runs/LC/approvals`) : []; }
import { readdirSync as readdir } from 'node:fs';
void [DONE, run];
