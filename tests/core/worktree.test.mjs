// @ts-check
// One worktree per run (A169, A185, A225): worktree-add|path|remove, the preparation (dependency folders copied, never linked; local files copied and refused by the
// pre-commit hook; links re-pointed), the prompt hook of the main tree and the worktree runs, the leftover worktree that `proofline doctor` proposes to remove (A215),
// and the hint of the refusal at `start` inside a batch. These are the scenarios of the former batch-test.sh (sc_worktree_*, sc_prompt_*) and worktree-prep.sh.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { leftoverWorktrees } from '../../control-plane/agents/scripts/core/leftover.mjs';
import { A, AB, batchApprove, bnew, binstall, fakes, g, gOk, has, lines, mktask, path, put, read, readIf, real, repo, say, scripts, sh, wtp } from './batch-lib.mjs';
import { makeFixture, git } from './fixture.mjs';

const wbody = (/** @type {string} */ title) => `## Goal\n\n${title}.\n\n## Context\n\nFixture.\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Out of scope\n\n- Other changes.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n`;
/** @param {{ status: number|null, text: string }} r @param {string} what @param {string} [msg] */
function refused(r, what, msg) {
  assert.notEqual(r.status, 0, `${what}: the command succeeded\n${r.text}`);
  if (msg !== undefined) assert.ok(r.text.includes(msg), `${what}: rejected for another reason: ${r.text.trim().split('\n').pop()}`);
}
const ac = (/** @type {string} */ dir, /** @type {string[]} */ args, /** @type {string} */ input = '') => A(dir, args, { input });

test('worktree-add|path|remove: one worktree per run, open runs counted per worktree, branch from the detached canonical tip, removal refused while a run is inside (sc_worktree_cmds)', () => {
  const F = fakes(); const dir = bnew();
  binstall(dir, { remote: false });
  const main = real(dir);
  let r = ac(dir, ['start', 'W-1', '--title', 'first'], wbody('first'));
  assert.equal(r.status, 0, r.text);
  refused(ac(dir, ['start', 'W-2', '--title', 'second'], wbody('second')), 'a second run in the same worktree names the way out', 'agent.sh worktree-add');
  const add = AB(F, dir, ['worktree-add', 'W-2']);
  assert.equal(add.status, 0, add.text);
  const wt = add.out.trim();
  assert.equal(wt, `${main}/.agents/local/worktrees/W-2`);
  assert.ok(has(`${wt}/.agents/scripts`));
  assert.equal(AB(F, dir, ['worktree-add', 'W-2']).out.trim(), wt, 'a second worktree-add did not reuse the worktree');
  // A200: commands written in the main tree after the user's yes (uncommitted) reach a worktree made from the committed branch, only when they are the sole config difference
  const cfgOf = (/** @type {string} */ d) => A(d, ['config-get', 'commands.test']).out.trim();
  assert.equal(cfgOf(wt), '', 'the fixture already has commands.test');
  const cfgKeep = read(`${dir}/.agents/config.yaml`);
  const cfgNew = cfgKeep.replace(/^ {2}test:[ \t]*$/m, '  test: npm test');
  assert.notEqual(cfgNew, cfgKeep, 'the fixture config has no empty commands.test line');
  writeFileSync(`${dir}/.agents/config.yaml`, cfgNew);
  AB(F, dir, ['worktree-add', 'W-2']);
  assert.equal(cfgOf(wt), 'npm test', 'A200: the worktree did not get the approved commands');
  writeFileSync(`${dir}/.agents/config.yaml`, cfgKeep); gOk(wt, ['checkout', '-q', '--', '.agents/config.yaml']);
  assert.equal(AB(F, dir, ['worktree-path', 'W-2']).out.trim(), wt);
  assert.notEqual(AB(F, dir, ['worktree-path', 'W-9']).status, 0);
  for (const d of ['batch', 'approvals', 'metrics', 'friction', 'prompts']) assert.ok(!existsSync(`${wt}/.agents/local/${d}`) || !lstatSync(`${wt}/.agents/local/${d}`).isSymbolicLink(), `A185: the worktree has a link to the shared ${d} folder`);
  assert.equal(sh(wt, 'find', ['.agents/local', '-type', 'l']).out.trim(), '', 'A185: the worktree holds a symlink');
  assert.ok(has(`${main}/.agents/local/approvals`), 'A185: the shared folders live in the main tree');
  assert.equal(gOk(dir, ['check-ignore', '.agents/local/worktrees/W-2']), '.agents/local/worktrees/W-2', 'the worktree folder is not git-ignored');
  assert.equal(ac(wt, ['start', 'W-2', '--title', 'second'], wbody('second')).status, 0, 'start W-2 in its own worktree');
  assert.equal(A(dir, ['open-runs']).out.trim(), 'W-1 -');
  assert.equal(A(wt, ['open-runs']).out.trim(), 'W-2 -', 'open runs are not per worktree');
  // the task branch starts from the detached HEAD at the canonical tip; the canonical branch stays in the main working tree
  assert.equal(A(wt, ['classify', 'W-2', 'TRIVIAL']).status, 0);
  const br = A(wt, ['branch', 'W-2']);
  assert.equal(br.status, 0, `branch from a detached task worktree: ${br.text}`);
  assert.match(g(wt, ['branch', '--show-current']), /^proofline\/W-2-/);
  assert.equal(g(dir, ['branch', '--show-current']), 'main', 'worktree-add moved the main working tree off main');
  refused(AB(F, wt, ['worktree-add', 'W-3']), 'worktree-add ran inside a task worktree', 'not inside a task worktree');
  refused(AB(F, dir, ['worktree-remove', 'W-2']), 'removing a worktree that still holds a run', 'still holds the run');
  assert.ok(has(wt), 'the refused removal removed the worktree');
  const rm = AB(F, dir, ['worktree-remove', 'W-2', '--force']);
  assert.equal(rm.status, 0, rm.text);
  assert.ok(rm.out.includes('evidence archived') && rm.out.includes('worktree removed: W-2'), rm.text);
  assert.ok(!has(wt) && g(dir, ['worktree', 'list']).split('\n').length === 1, 'worktree left after removal');
  assert.match(AB(F, dir, ['worktree-remove', 'W-2']).out, /no worktree/, 'removing a missing worktree is not a no-op');
  // usage and role
  refused(AB(F, dir, ['worktree-add', '../x']), 'an invalid id', 'usage: agent.sh worktree-add <TASK-ID>');
  refused(AB(F, dir, ['worktree-remove', 'W-1', '--forced']), 'a bad option', 'usage: agent.sh worktree-remove');
  refused(AB(F, dir, ['worktree-add', 'W-4'], { role: 'implementer' }), 'worktree-add without a lead', 'command denied');
  put(`${main}/.agents/local/worktrees/W-5/x`, 'x');
  refused(AB(F, dir, ['worktree-add', 'W-5']), 'a folder that is no worktree', 'exists but is not a registered worktree');
});

test('start refuses a second open run and, inside an approved batch, tells the lead to run it from the task\'s own worktree (A225)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX'); binstall(dir);
  AB(F, dir, ['batch-plan', 'all']); batchApprove(dir);
  // T-1 is started in the main working tree (a lead that forgot its worktree), then T-2 is started there too
  assert.equal(AB(F, dir, ['start', 'T-1', '--task-file', '.agents/tasks/T-1.md']).status, 0);
  const r = AB(F, dir, ['start', 'T-2', '--task-file', '.agents/tasks/T-2.md']);
  refused(r, 'a second run in the same folder of a batch', 'another open run exists in this worktree: T-1');
  assert.ok(r.text.includes('T-2 belongs to the approved batch: run this command from the task\'s own worktree, .agents/local/worktrees/T-2'), r.text);
  assert.ok(r.text.includes('agent.sh worktree-add <TASK-ID>'), 'the old way out is kept');
  // outside a batch the text is the old one, without the batch hint
  const dir2 = bnew(); binstall(dir2, { remote: false });
  assert.equal(ac(dir2, ['start', 'W-1', '--title', 'first'], wbody('first')).status, 0);
  const r2 = ac(dir2, ['start', 'W-2', '--title', 'second'], wbody('second'));
  refused(r2, 'a second run outside a batch', 'agent.sh worktree-add');
  assert.ok(!r2.text.includes('belongs to the approved batch'), r2.text);
  // the worktree of the task starts it without that refusal
  const wt = AB(F, dir, ['worktree-add', 'T-2']).out.trim();
  assert.equal(AB(F, wt, ['start', 'T-2', '--task-file', '.agents/tasks/T-2.md']).status, 0, 'the task\'s own worktree starts it');
});

test('worktree-add: a dependency folder is the worktree\'s own copy, .env* is copied, listed and refused by pre-commit, nothing needs a symlink (sc_worktree_prep)', () => {
  const F = fakes(); const dir = bnew();
  binstall(dir, { remote: false });
  const main = real(dir);
  writeFileSync(`${dir}/.gitignore`, `${read(`${dir}/.gitignore`)}node_modules/\n.env*\n`);
  gOk(dir, ['add', '.gitignore']); gOk(dir, ['commit', '-qm', 'ignore']);
  put(`${dir}/node_modules/pkg/index.js`, 'v1\n'); put(`${dir}/.env`, 'SECRET=1\n'); put(`${dir}/.env.local`, 'X=1\n');
  const a = AB(F, dir, ['worktree-add', 'W-1']);
  assert.equal(a.status, 0, a.text);
  const wt = a.out.trim();
  // 4: a dependency change in the worktree leaves the main tree alone
  assert.ok(has(`${wt}/node_modules/pkg`) && !lstatSync(`${wt}/node_modules`).isSymbolicLink(), 'node_modules is not a real copy in the worktree');
  writeFileSync(`${wt}/node_modules/pkg/index.js`, 'v2\n'); writeFileSync(`${wt}/node_modules/added.js`, 'new\n');
  assert.equal(read(`${dir}/node_modules/pkg/index.js`), 'v1\n'); assert.ok(!has(`${dir}/node_modules/added.js`), 'a dependency change in the worktree reached the main tree');
  // 5: .env* is copied, listed, and refused by the pre-commit hook even when forced
  assert.equal(read(`${wt}/.env`), 'SECRET=1\n'); assert.ok(has(`${wt}/.env.local`), '.env* was not copied into the worktree');
  assert.ok(lines(`${wt}/.agents/local/worktree-copied`).includes('.env'), 'the copied file is not listed');
  assert.ok(!g(wt, ['status', '--porcelain']).includes('.env'), 'git status shows the copied .env');
  gOk(wt, ['add', '-A']);
  assert.ok(!g(wt, ['diff', '--cached', '--name-only']).includes('.env'), 'git add -A staged the copied .env');
  assert.equal(sh(wt, 'node', [path.join(repo, 'tests/legacy-githooks/install.mjs'), `${wt}/.agents/githooks`]).status, 0, 'no githooks to copy');
  gOk(wt, ['add', '-f', '.env']);
  const pc = sh(wt, 'git', ['-c', 'core.hooksPath=.agents/githooks', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'env']);
  assert.notEqual(pc.status, 0, 'the pre-commit hook let a copied .env into a commit');
  assert.ok(pc.text.includes('worktree.copy_files'), `the refusal does not say why: ${pc.text}`);
  // a file git does not ignore is reported, never copied
  put(`${dir}/.envrc.keep`, 'C=1\n');
  writeFileSync(`${dir}/.gitignore`, read(`${dir}/.gitignore`).replace(/^\.env\*$/m, '.env'));
  const b = AB(F, dir, ['worktree-add', 'W-2']);
  assert.equal(b.status, 0, b.text);
  assert.ok(!has(`${b.out.trim()}/.envrc.keep`), 'a file git does not ignore was copied');
  assert.match(b.err, /\.envrc\.keep is not copied: git does not ignore it in the main tree/);
  // 6: the same with symlink creation blocked
  const lnfail = `${F.FAKE}/lnfail`; put(`${lnfail}/ln`, '#!/bin/sh\necho "ln: symbolic links not allowed" >&2\nexit 1\n'); chmodSync(`${lnfail}/ln`, 0o755);
  writeFileSync(`${dir}/.gitignore`, 'node_modules/\n.env*\n');
  const c = AB(F, dir, ['worktree-add', 'W-3'], { env: { PATH: `${lnfail}:${F.env.PATH}` } });
  assert.equal(c.status, 0, `worktree-add failed with symlinks blocked: ${c.err}`);
  const wt3 = c.out.trim();
  assert.ok(has(`${wt3}/node_modules/pkg`) && !lstatSync(`${wt3}/node_modules`).isSymbolicLink() && has(`${wt3}/.env`), 'no real copy with symlinks blocked');
  assert.equal(sh(wt3, 'find', ['.agents/local', '-type', 'l']).out.trim(), '', 'a link was made with symlinks blocked');
  assert.equal(AB(F, dir, ['worktree-add', 'W-3'], { env: { PATH: `${lnfail}:${F.env.PATH}` } }).out.trim(), wt3, 'reuse with symlinks blocked');
  void main;
});

test('worktree-add: a link inside a copied dependency folder that led into the main tree is re-pointed; an inner link is kept (sc_worktree_links)', () => {
  const F = fakes(); const dir = bnew();
  binstall(dir, { remote: false });
  const main = real(dir);
  writeFileSync(`${dir}/.gitignore`, `${read(`${dir}/.gitignore`)}node_modules/\n`);
  gOk(dir, ['add', '.gitignore']); gOk(dir, ['commit', '-qm', 'ignore']);
  put(`${dir}/node_modules/pkg/index.js`, 'v1\n'); mkdirSync(`${dir}/node_modules/.bin`, { recursive: true }); put(`${dir}/shared/tool.js`, 'tool\n');
  // relative, leaves the folder: from the copy (main/.agents/local/worktrees/W-1/node_modules/.bin) six levels up is the main tree
  symlinkSync('../../../../../../shared/tool.js', `${dir}/node_modules/.bin/rel`);
  symlinkSync(`${main}/shared/tool.js`, `${dir}/node_modules/abs`);
  symlinkSync('pkg/index.js', `${dir}/node_modules/inside`);
  const a = AB(F, dir, ['worktree-add', 'W-1']);
  assert.equal(a.status, 0, a.text);
  const wt = a.out.trim();
  for (const l of [`${wt}/node_modules/.bin/rel`, `${wt}/node_modules/abs`]) {
    if (!lstatSync(l, { throwIfNoEntry: false })?.isSymbolicLink()) continue; // rejected (removed) is as good as re-pointed
    if (l.endsWith('/rel')) assert.notEqual(readlinkSync(l), '../../../../../../shared/tool.js', 'the relative link that reaches the main tree was copied unchanged');
    const target = real(path.dirname(l)) + '/' + path.basename(readlinkSync(l));
    const resolved = spawnSync('python3', ['-I', '-c', 'import os,sys; print(os.path.realpath(sys.argv[1]))', l], { encoding: 'utf8' }).stdout.trim() || target;
    assert.ok(resolved.startsWith(`${wt}/`) || !resolved.startsWith(`${main}/`), `the copied link ${l} still leads into the main tree: ${resolved}`);
  }
  try { writeFileSync(`${wt}/node_modules/.bin/rel`, 'changed\n'); } catch { /* the link may lead nowhere */ }
  assert.equal(read(`${dir}/shared/tool.js`), 'tool\n', 'a write through a copied link reached the main tree\'s shared/tool.js');
  assert.equal(readlinkSync(`${wt}/node_modules/inside`), 'pkg/index.js', 'a link that stays inside the folder was changed');
});

/** The prompt hook of the main tree, as the runtime runs it. @param {string} main @param {string} prompt */
function hook(main, prompt) {
  const ev = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: main, prompt });
  const r = spawnSync('node', [path.join(repo, 'adapters/claude/hooks/proofline-hook.mjs'), 'prompt', 'claude'], {
    input: ev, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: 'C', CLAUDE_PROJECT_DIR: main, PROOFLINE_NO_TTY: '1', PROOFLINE_HOOK_APPROVE_BUDGET: '120', PROOFLINE_HOOK_LOCK_WAIT: '60',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@example.invalid' },
  });
  return r.stdout + r.stderr;
}
const sleepMs = (/** @type {number} */ ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const PLAN_X = '---\nscope:\n  - path: x.txt\n    criteria: [AC-1]\n---\n# Plan\n';

test('a worktree run\'s pending request is approved by the main tree\'s prompt hook (shared approve.log, no worktree process without a request); a linked capture is refused (sc_worktree_prompt_approval)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'W-1', 'COMPLEX'); binstall(dir, { remote: false });
  const main = real(dir);
  const wt = AB(F, dir, ['worktree-add', 'W-1']).out.trim();
  assert.equal(A(wt, ['start', 'W-1', '--task-file', '.agents/tasks/W-1.md']).status, 0, 'start W-1 in its worktree');
  put(`${wt}/.agents/runs/W-1/PLAN.md`, PLAN_X);
  assert.equal(A(wt, ['request-approval', 'W-1', 'scope']).status, 0);
  const done = () => readdirSyncSafe(`${wt}/.agents/runs/W-1/approvals`).filter((n) => /^[0-9]{3}-scope\.yaml$/.test(n)).length;
  assert.equal(done(), 0);
  // the user's reply reaches the hook of the MAIN tree session; the run is in the worktree
  sleepMs(1100); const out = hook(main, 'approve scope');
  assert.equal(done(), 1, `the prompt hook did not record the scope approval in the worktree run: ${out}`);
  assert.ok(out.includes('approval recorded'), `the hook did not say it recorded the approval: ${out}`);
  assert.ok(!has(`${dir}/.agents/runs/W-1`), 'the approval created a run folder in the main tree');
  assert.ok(readIf(`${dir}/.agents/local/approve.log`).includes('W-1'), 'no line for W-1 in the shared approve.log of the main tree');
  assert.ok(!has(`${wt}/.agents/local/approve.log`), 'the worktree kept its own approve.log');
  // a run in another worktree with NO request: the prompt adds no work for it, its agent.sh is never started
  mktask(dir, 'W-2', 'COMPLEX'); gOk(dir, ['add', '-A']); gOk(dir, ['commit', '-qm', 'task W-2']);
  const wt2 = AB(F, dir, ['worktree-add', 'W-2']).out.trim();
  assert.equal(A(wt2, ['start', 'W-2', '--task-file', '.agents/tasks/W-2.md']).status, 0);
  const real2 = `${wt2}/.agents/scripts/agent.real.sh`;
  sh(wt2, 'mv', [`${wt2}/.agents/scripts/agent.sh`, real2]);
  put(`${wt2}/.agents/scripts/agent.sh`, `#!/bin/sh\necho "$*" >> "${F.FAKE}/wtcalls"\nexec sh "$(dirname "$0")/agent.real.sh" "$@"\n`);
  put(`${F.FAKE}/wtcalls`, '');
  hook(main, 'thanks, looks good');
  assert.equal(readIf(`${F.FAKE}/wtcalls`), '', 'a prompt without a pending request started the worktree\'s agent.sh');
  sh(wt2, 'mv', [real2, `${wt2}/.agents/scripts/agent.sh`]);
  // the capture is safe state in the main tree: a capture planted as a link is refused, as in the main tree
  assert.equal(A(wt, ['request-approval', 'W-1', 'scope']).status, 0); sleepMs(1100);
  const cap = `${dir}/.agents/local/prompts/s1.json`;
  const keep = `${F.FAKE}/cap.real`;
  sh(dir, 'cp', [cap, keep]); sh(dir, 'rm', ['-f', cap]); symlinkSync(keep, cap);
  const l1 = A(wt, ['approve-pending', 'W-1']);
  assert.ok(l1.text.includes('not a regular single-link file') && done() === 1, `a symlinked capture in the shared prompts folder was accepted from the worktree: ${l1.text}`);
  sh(dir, 'rm', ['-f', cap]); sh(dir, 'ln', [keep, cap]);
  const l2 = A(wt, ['approve-pending', 'W-1']);
  assert.ok(l2.text.includes('not a regular single-link file') && done() === 1, `a hard-linked capture was accepted from the worktree: ${l2.text}`);
});

/** @param {string} d */
function readdirSyncSafe(d) { try { return readdirSync(d); } catch { return []; } }

test('the main tree\'s prompt hook runs only an unchanged worktree agent.sh, and a reply binds to the run it names when several wait (sc_prompt_guards)', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'W-1', 'COMPLEX'); mktask(dir, 'W-2', 'COMPLEX'); binstall(dir, { remote: false });
  const main = real(dir);
  for (const r of ['W-1', 'W-2']) {
    const w = AB(F, dir, ['worktree-add', r]).out.trim();
    assert.equal(A(w, ['start', r, '--task-file', `.agents/tasks/${r}.md`]).status, 0, `start ${r}`);
    put(`${w}/.agents/runs/${r}/PLAN.md`, PLAN_X);
    assert.equal(A(w, ['request-approval', r, 'scope']).status, 0);
  }
  const w1 = wtp(dir, 'W-1'); const w2 = wtp(dir, 'W-2');
  const approved = (/** @type {string} */ w, /** @type {string} */ r) => readdirSyncSafe(`${w}/.agents/runs/${r}/approvals`).some((n) => /^[0-9]{3}-scope\.yaml$/.test(n));
  // two runs wait: a reply that names none approves neither; naming W-2 approves only W-2
  sleepMs(1100); const out = hook(main, 'approve scope');
  assert.ok(!approved(w1, 'W-1') && !approved(w2, 'W-2'), 'an unnamed reply approved a run while two waited');
  assert.ok(out.includes('say which run you approve'), `the hook did not ask which run: ${out}`);
  sleepMs(1100); const out2 = hook(main, 'i approve the scope for W-2');
  assert.ok(approved(w2, 'W-2'), `the reply naming W-2 did not approve W-2: ${out2}`);
  assert.ok(!approved(w1, 'W-1'), 'the reply naming W-2 also approved W-1');
  // a worktree agent.sh that differs from the main one is never run (the Node hook runs the project's own core and only reads the worktree's data)
  appendFileSync(`${w1}/.agents/scripts/agent.sh`, `\necho forged > "${F.FAKE}/forged"\n`);
  sleepMs(1100); hook(main, 'i approve the scope for W-1');
  assert.ok(!has(`${F.FAKE}/forged`), 'the hook ran a modified worktree agent.sh');
});

test('worktree-deps (the former worktree-prep.sh --deps for build-record): the ignored dependency folders are copied into the export, a tracked or unignored folder is left alone', () => {
  const F = fakes(); const dir = bnew();
  binstall(dir, { remote: false });
  writeFileSync(`${dir}/.gitignore`, `${read(`${dir}/.gitignore`)}node_modules/\n`);
  gOk(dir, ['add', '.gitignore']); gOk(dir, ['commit', '-qm', 'ignore']);
  put(`${dir}/node_modules/pkg/index.js`, 'v1\n'); put(`${dir}/vendor/lib.go`, 'package x\n'); // vendor is not ignored: left alone
  const out = `${F.FAKE}/export`; mkdirSync(out, { recursive: true });
  const r = sh(dir, 'node', [path.join(scripts, 'proofline-core.mjs'), 'cli', 'worktree-deps', dir, out]);
  assert.equal(r.status, 0, r.text);
  assert.equal(read(`${out}/node_modules/pkg/index.js`), 'v1\n');
  assert.ok(!lstatSync(`${out}/node_modules`).isSymbolicLink());
  assert.ok(!has(`${out}/vendor`), 'a folder git does not ignore was copied');
  assert.equal(sh(dir, 'node', [path.join(scripts, 'proofline-core.mjs'), 'cli', 'worktree-deps', dir]).status, 2, 'a missing argument is a usage error');
  assert.equal(sh(dir, 'node', [path.join(scripts, 'proofline-core.mjs'), 'cli', 'worktree-deps', dir, `${out}/nope`]).status, 2, 'a missing folder is a usage error');
});

// ---- the leftover worktree (A215, A225) ------------------------------------------------------------------------------------------------

/** A fixture project with a worktree for each task id; each worktree holds a run whose handoff state is given. @param {Array<{ id: string, state: string }>} runs */
function leftoverProject(runs) {
  const fx = makeFixture();
  for (const r of runs) {
    const d = `${fx.root}/.agents/local/worktrees/${r.id}`;
    git(fx.root, ['worktree', 'add', '-q', '--detach', d, 'main']);
    mkdirSync(`${d}/.agents/runs/${r.id}`, { recursive: true });
    writeFileSync(`${d}/.agents/runs/${r.id}/RUN.yaml`, `task:\n  id: ${r.id}\nexecution:\n  state: ${r.state === 'DONE' ? 'DONE' : 'IMPLEMENTING'}\nhandoff:\n  state: ${r.state}\n`);
  }
  return fx;
}

test('doctor proposes the removal of a worktree whose run is DONE and merged; it never removes it (A215 leftover worktree)', () => {
  const fx = leftoverProject([{ id: 'L-1', state: 'DONE' }, { id: 'L-2', state: 'DONE' }, { id: 'L-3', state: 'DONE' }, { id: 'L-4', state: 'CODE_DONE' }, { id: 'L-5', state: 'DONE' }]);
  const root = fx.root;
  // L-1: the merge is recorded in the batch
  put(`${root}/.agents/local/batch/merged.tsv`, 'L-1\t12\t1700000000\nL-4\t13\t1700000001\n'); // L-4 has a record too, but its run is not DONE
  // L-2: the cleanup approval was consumed (the process died after it)
  put(`${root}/.agents/local/worktrees/L-2/.agents/runs/L-2/approvals/001-cleanup.yaml`, 'kind: "cleanup"\nconsumed: "true"\n');
  // L-3: the delivered commit is on the canonical branch
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  put(`${root}/.agents/local/worktrees/L-3/.agents/local/deliver/L-3/SUMMARY.md`, `merge_by: user\nhead: ${head}\nbase: main\nbranch: x\n`);
  // L-4 is not DONE; L-5 is DONE but nothing proves a merge: its delivery may be in progress
  const found = leftoverWorktrees(fx.ctx());
  assert.deepEqual(found.map((f) => f.id).sort(), ['L-1', 'L-2', 'L-3']);
  const by = Object.fromEntries(found.map((f) => [f.id, f]));
  assert.match(by['L-1'].reason, /merge is recorded in the batch/);
  assert.match(by['L-2'].reason, /cleanup approval was consumed/);
  assert.match(by['L-3'].reason, /delivered commit is on main/);
  assert.equal(by['L-1'].command, 'sh .agents/scripts/agent.sh worktree-remove L-1 --force');
  // the CLI form doctor.sh reads: one tab-separated line per leftover
  const r = sh(root, 'node', [path.join(root, '.agents/scripts/proofline-core.mjs'), 'cli', 'leftover-worktrees']);
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(r.out.trim().split('\n').map((l) => l.split('\t')[0]).sort(), ['L-1', 'L-2', 'L-3']);
  assert.equal(r.out.trim().split('\n')[0].split('\t')[3].startsWith('sh .agents/scripts/agent.sh worktree-remove'), true);
  // nothing was removed
  for (const id of ['L-1', 'L-2', 'L-3', 'L-4', 'L-5']) assert.ok(existsSync(`${root}/.agents/local/worktrees/${id}/.agents/runs/${id}`), `${id} was touched`);
});

test('proofline doctor prints one WARN with the removal command per leftover worktree and counts it (A215)', () => {
  const fx = leftoverProject([{ id: 'L-1', state: 'DONE' }]);
  put(`${fx.root}/.agents/local/batch/merged.tsv`, 'L-1\t12\t1700000000\n');
  const r = spawnSync('sh', ['-c', 'ROOT="$1"; D_WARNS=0; . "$2"; doctor_worktrees; echo "warns=$D_WARNS"', 'x', fx.root, path.join(repo, 'bin/lib/doctor.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^WARN worktrees: the worktree of L-1 is a leftover: its run is DONE and its merge is recorded in the batch, but .*\.agents\/local\/worktrees\/L-1 is still present\. To remove it \(the run records are archived first\), run: sh \.agents\/scripts\/agent\.sh worktree-remove L-1 --force$/m);
  assert.match(r.stdout, /warns=1/);
  assert.ok(existsSync(`${fx.root}/.agents/local/worktrees/L-1`), 'doctor removed the worktree');
  // no leftover: no output
  const clean = leftoverProject([{ id: 'L-9', state: 'DONE' }]);
  const r2 = spawnSync('sh', ['-c', 'ROOT="$1"; D_WARNS=0; . "$2"; doctor_worktrees; echo "warns=$D_WARNS"', 'x', clean.root, path.join(repo, 'bin/lib/doctor.sh')], { encoding: 'utf8' });
  assert.equal(r2.stdout.trim(), 'warns=0');
  void Context; void say; void lines; void readFileSync;
});
