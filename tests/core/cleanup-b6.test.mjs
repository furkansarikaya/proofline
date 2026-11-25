// @ts-check
// Issue 338, items B6 and B7 (A357): a role left `r7/` in the repository root (the mutation counter of `gate.mjs mutant` resolved against the repository) and every
// gate went stale because an untracked path is part of the content fingerprint; the lead could not remove it. Here: the counter stays in the run folder, the lead
// has `discard-untracked` (only paths the run created, outside its scope, no link, ledgered), the evidence worktree of a run is removed at CODE_DONE also when it is
// dirty (the mutation trials leave changes), and folders with nothing in them under .agents/runs go when a run is cleaned up.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, IMPLEMENTED, accepted, project, read, refused } from './legacy-lib.mjs';
import { repo } from './helpers.mjs';
import { recheckRemovable } from '../../control-plane/agents/scripts/core/commands/runcmds.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { verifyNoScratchWorktrees } from '../../control-plane/agents/scripts/core/handoff.mjs';
import { cleanEnv } from '../hook/harness.mjs';
import { tempDir } from '../lib/tempdir.mjs';

const GATE = path.join(repo, 'skills/test-trust/scripts/gate.mjs');
const ledger = (/** @type {string} */ d) => read(d, '.agents/runs/LC/LEDGER.log');
const fp = (/** @type {string} */ d) => accepted(A(d, ['fingerprint', 'LC']), 'fingerprint').out.trim();

// ---- gate.mjs mutant ----------------------------------------------------------------------------------------------------------------

test('gate.mjs mutant: with a run folder the counter lives in it, a relative name is relative to it, a path outside it is refused and nothing is written there', () => {
  const t = tempDir('b6-gate-');
  const cwd = path.join(t, 'repo-root');
  const run = path.join(t, 'repo-root/.agents/runs/LC');
  mkdirSync(run, { recursive: true });
  const cfg = path.join(t, 'config.yaml');
  writeFileSync(cfg, 'test_trust:\n  mutation_budget: 2\n');
  /** @param {string[]} a */
  const g = (a) => spawnSync(process.execPath, [GATE, 'mutant', ...a], { cwd, encoding: 'utf8' });
  let r = g(['r7/mutants.count', cfg, run]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^OK 1\/2/);
  assert.equal(existsSync(path.join(cwd, 'r7')), false, 'a folder was made in the repository root');
  assert.equal(readFileSync(path.join(run, 'r7/mutants.count'), 'utf8'), '1\n', 'the counter is in the run folder');
  r = g([path.join(run, 'reviews/test-trust/tests/mutants.count'), cfg, run]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(path.join(run, 'reviews/test-trust/tests/mutants.count'), 'utf8'), '1\n');
  for (const bad of [path.join(cwd, 'r7/outside.count'), '../outside.count', path.join(t, 'elsewhere.count')]) {
    r = g([bad, cfg, run]);
    assert.equal(r.status, 2, `${bad}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /inside the run folder/);
  }
  assert.equal(existsSync(path.join(cwd, 'r7')), false);
  assert.equal(existsSync(path.join(t, 'elsewhere.count')) || existsSync(path.join(run, '../outside.count')), false);
  // a link in the way: the counter would be written through it
  mkdirSync(path.join(t, 'target'));
  symlinkSync(path.join(t, 'target'), path.join(run, 'lnk'));
  r = g(['lnk/mutants.count', cfg, run]);
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.equal(readdirSync(path.join(t, 'target')).length, 0, 'written through a link');
  // without a run folder nothing changes (the documented form outside a run)
  r = g([path.join(t, 'plain.count'), cfg]);
  assert.equal(r.status, 0, r.stderr);
});

// ---- discard-untracked --------------------------------------------------------------------------------------------------------------

test('discard-untracked: a path the run created outside its scope is removed (the fingerprint is the one before), ledgered, lead only; tracked, in-scope, earlier, outside and linked paths are refused', () => {
  const d = project(`scaffold orchestrated no TRIVIAL; ${IMPLEMENTED}`);
  const before = fp(d);
  mkdirSync(`${d}/r7/deep`, { recursive: true });
  writeFileSync(`${d}/r7/mutants.count`, '3\n');
  writeFileSync(`${d}/r7/deep/x.txt`, 'x\n');
  assert.notEqual(fp(d), before, 'the stray folder is part of the fingerprint');
  refused(A(d, ['discard-untracked', 'LC', 'r7'], { role: 'qa' }), 'a role removed an untracked path', 'command denied for qa: discard-untracked');
  assert.ok(existsSync(`${d}/r7/mutants.count`));
  refused(A(d, ['discard-untracked', 'LC']), 'no path', 'usage: agent.sh discard-untracked');
  // never a path of the plan scope, a tracked file, a path of the control plane, a path outside the project, a link
  spawnSync('git', ['-C', d, 'rm', '-q', '--cached', 'impl.txt']);   // untracked again: only the plan scope says no
  refused(A(d, ['discard-untracked', 'LC', 'impl.txt']), 'a path inside the plan scope', 'inside the plan scope');
  assert.ok(existsSync(`${d}/impl.txt`));
  spawnSync('git', ['-C', d, 'add', 'impl.txt']);
  const tracked = spawnSync('git', ['-C', d, 'ls-files'], { encoding: 'utf8' }).stdout.split('\n').find((f) => f !== '' && !f.startsWith('.agents/') && !f.startsWith('.claude/')) ?? 'README.md';
  refused(A(d, ['discard-untracked', 'LC', tracked]), 'a tracked file', 'not untracked');
  assert.ok(existsSync(`${d}/${tracked}`));
  for (const bad of ['../x', '/etc/passwd', '.git', '.git/config', '.agents/config.yaml', '.agents/runs/LC/PLAN.md', '.claude/x', 'a/../r7', './r7', 'r7/', '', 'sp ace', '-r7']) {
    refused(A(d, ['discard-untracked', 'LC', bad]), `discard-untracked accepted '${bad}'`);
  }
  assert.ok(existsSync(`${d}/r7/mutants.count`) && existsSync(`${d}/.agents/config.yaml`) && existsSync(`${d}/.git`));
  mkdirSync(`${d}/real`); writeFileSync(`${d}/real/f.txt`, 'f\n');
  symlinkSync(`${d}/real`, `${d}/lnk`);
  refused(A(d, ['discard-untracked', 'LC', 'lnk/f.txt']), 'removed through a link', 'link');
  refused(A(d, ['discard-untracked', 'LC', 'lnk']), 'removed a link', 'link');
  assert.ok(existsSync(`${d}/real/f.txt`));
  rmSync(`${d}/lnk`); rmSync(`${d}/real`, { recursive: true });
  // a link inside the folder is refused too (nothing is removed, not even the rest of the folder)
  mkdirSync(`${d}/withlink`); writeFileSync(`${d}/withlink/a.txt`, 'a\n'); symlinkSync('a.txt', `${d}/withlink/l`);
  refused(A(d, ['discard-untracked', 'LC', 'withlink']), 'a folder holding a link', 'link');
  assert.ok(existsSync(`${d}/withlink/a.txt`));
  rmSync(`${d}/withlink`, { recursive: true });
  // a path that was already untracked when the run began is the user's own: it is in the baseline
  writeFileSync(`${d}/user-notes.txt`, 'mine\n');
  const runYaml = read(d, '.agents/runs/LC/RUN.yaml');
  assert.match(runYaml, /^ {2}untracked:\n/m, 'the baseline has no untracked list');
  writeFileSync(`${d}/.agents/runs/LC/RUN.yaml`, runYaml.replace(/^ {2}untracked:\n/m, '  untracked:\n    - path: user-notes.txt\n      sha256: "0"\n'));
  refused(A(d, ['discard-untracked', 'LC', 'user-notes.txt']), 'a path of the baseline', 'before the run');
  assert.ok(existsSync(`${d}/user-notes.txt`));
  writeFileSync(`${d}/.agents/runs/LC/RUN.yaml`, runYaml);
  rmSync(`${d}/user-notes.txt`);
  // the real one
  const ok = accepted(A(d, ['discard-untracked', 'LC', 'r7']), 'discard-untracked r7');
  const will = ok.out.indexOf('will remove r7');
  assert.ok(will >= 0 && will < ok.out.indexOf('discarded untracked: r7'), 'the files are named before the removal');
  assert.match(ok.out, /^ {2}r7\/deep\/x\.txt$/m);
  assert.match(ok.out, /^discarded untracked: r7 \(2 files, sha256 [0-9a-f]{64}\)$/m);
  assert.equal(existsSync(`${d}/r7`), false);
  assert.equal(fp(d), before, 'the gates are fresh again: the fingerprint is the one before the stray folder');
  assert.match(ledger(d), /event=discard-untracked .*path=r7 files=2 sha256=[0-9a-f]{64}/);
  // a second call finds nothing to remove
  refused(A(d, ['discard-untracked', 'LC', 'r7']), 'removing it twice', 'not untracked');
});

test('discard-untracked: an unknown run is refused; a run whose gates are not enforced still gets the ledger row', () => {
  const d = project('scaffold standalone');
  // a run whose gates are not enforced: the lifecycle_gates section of RUN.yaml is gone
  const ry = read(d, '.agents/runs/LC/RUN.yaml');
  writeFileSync(`${d}/.agents/runs/LC/RUN.yaml`, ry.replace(/^lifecycle_gates:\n(?: .*\n)*/m, ''));
  assert.doesNotMatch(read(d, '.agents/runs/LC/RUN.yaml'), /^lifecycle_gates:/m);
  assert.match(ry, /^lifecycle_gates:/m, 'the fixture run had enforced gates');
  writeFileSync(`${d}/stray.txt`, 'x\n');
  refused(A(d, ['discard-untracked', 'NOPE', 'stray.txt']), 'an unknown run');
  assert.ok(existsSync(`${d}/stray.txt`));
  const r = accepted(A(d, ['discard-untracked', 'LC', 'stray.txt']), 'discard-untracked in a standalone run');
  assert.match(r.out, /will remove stray\.txt/);
  assert.equal(existsSync(`${d}/stray.txt`), false);
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), /event=discard-untracked .*path=stray\.txt files=1 sha256=[0-9a-f]{64}/);
});

test('recheckRemovable: a parent that became a link, a leaf that became a link and a folder that left the project are refused right before the removal', () => {
  const t = tempDir('b6-recheck-');
  const root = path.join(t, 'proj');
  const outside = path.join(t, 'outside');
  mkdirSync(path.join(root, 'a/b'), { recursive: true }); mkdirSync(outside);
  writeFileSync(path.join(root, 'a/b/f.txt'), 'x\n'); writeFileSync(path.join(outside, 'keep.txt'), 'k\n');
  assert.equal(recheckRemovable(root, 'a/b'), '');
  assert.equal(recheckRemovable(root, 'a/b/f.txt'), '');
  rmSync(path.join(root, 'a'), { recursive: true });                 // the parent is swapped for a link to a folder outside the project
  symlinkSync(outside, path.join(root, 'a'));
  assert.match(recheckRemovable(root, 'a/keep.txt'), /a became a link/);
  rmSync(path.join(root, 'a'));
  mkdirSync(path.join(root, 'a'));
  symlinkSync(outside, path.join(root, 'a/b'));                       // the leaf swapped for a link
  assert.match(recheckRemovable(root, 'a/b'), /a\/b became a link/);
  assert.match(recheckRemovable(root, 'a/gone'), /is gone/);
  assert.equal(existsSync(path.join(outside, 'keep.txt')), true);
});

// ---- the evidence worktree of the run, also dirty -------------------------------------------------------------------------------------

/** @param {string} d @param {string} tmp */
function ctxIn(d, tmp) {
  return new Context({ env: cleanEnv({ AGENT_ROLE: 'lead', TMPDIR: tmp }), cwd: d, stdout: { write: () => true }, stderr: { write: () => true } }, `${d}/.agents/scripts/agent.sh`);
}

test('CODE_DONE removes this run\'s own evidence worktree also when the mutation trials left changes in it; another name, a branch and a locked one stay blockers', () => {
  const d = project('scaffold standalone');
  const tmp = tempDir('b6-evid-');
  const g = (/** @type {string[]} */ a) => spawnSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  const mk = (/** @type {string} */ name, /** @type {string[]} */ more = []) => { const p = path.join(tmp, name); const r = g(['worktree', 'add', '--detach', p, 'HEAD', ...more]); assert.equal(r.status, 0, r.stderr); return p; };
  const dirty = mk('verify-LC.qa');
  writeFileSync(path.join(dirty, 'mutated.txt'), 'trial\n');
  const base = mk('verify-LC.reviewer-base');
  const foreign = mk('somebody-elses');
  const ctx = ctxIn(d, tmp);
  assert.throws(() => verifyNoScratchWorktrees(ctx, 'LC'), /somebody-elses/, 'a foreign worktree stays a blocker');
  const registered = g(['worktree', 'list', '--porcelain']).stdout;
  assert.ok(!registered.includes(dirty), 'the dirty evidence worktree of the run was not removed');
  assert.ok(!registered.includes(base), 'the clean one was not removed');
  assert.ok(registered.includes(foreign), 'a foreign worktree was removed');
  assert.equal(existsSync(dirty), false);
  g(['worktree', 'remove', '--force', foreign]);
  // a locked one is git's to refuse
  const locked = mk('verify-LC.sec');
  g(['worktree', 'lock', locked]);
  assert.throws(() => verifyNoScratchWorktrees(ctxIn(d, tmp), 'LC'), /verify-LC\.sec/);
  assert.ok(existsSync(locked), 'a locked worktree was removed');
  g(['worktree', 'unlock', locked]);
  verifyNoScratchWorktrees(ctxIn(d, tmp), 'LC');
  assert.equal(existsSync(locked), false);
  // the worktree of ANOTHER run with a similar prefix is not this run's
  const other = mk('verify-LC-2.qa');
  assert.throws(() => verifyNoScratchWorktrees(ctxIn(d, tmp), 'LC'), /verify-LC-2/);
  assert.ok(existsSync(other));
});

// ---- empty run folders ----------------------------------------------------------------------------------------------------------------

test('cleanup removes the folders under .agents/runs that hold nothing at all (an empty scratch folder), and never a folder that holds a file', () => {
  const d = project('scaffold standalone');
  mkdirSync(`${d}/.agents/runs/TASK-024/scratch/sub`, { recursive: true });
  mkdirSync(`${d}/.agents/runs/TASK-026`, { recursive: true });
  mkdirSync(`${d}/.agents/runs/TASK-030/scratch`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/TASK-030/scratch/keep.txt`, 'evidence\n');
  accepted(A(d, ['terminate', 'LC', 'BLOCKED'], { input: 'reason: the verification toolchain is unavailable in this environment\nevidence: go test exited 127 because the go binary is missing\n' }), 'terminate');
  const r = accepted(A(d, ['cleanup', 'LC']), 'cleanup');
  assert.match(r.out, /^removed empty run folders: TASK-024 TASK-026$/m);
  assert.equal(existsSync(`${d}/.agents/runs/TASK-024`), false);
  assert.equal(existsSync(`${d}/.agents/runs/TASK-026`), false);
  assert.equal(readFileSync(`${d}/.agents/runs/TASK-030/scratch/keep.txt`, 'utf8'), 'evidence\n', 'a folder with a file was touched');
});
