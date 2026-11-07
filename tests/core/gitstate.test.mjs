// @ts-check
// The state of .git/config and HEAD the dispatcher compares before and after a step (A226): read from the git folder's files, in a main tree and in a linked
// worktree, with packed refs, detached, unborn; and equal to what git itself says whenever the plain reading is not possible.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { gitState } from '../../control-plane/agents/scripts/core/gitstate.mjs';
import * as proc from '../../control-plane/agents/scripts/core/proc.mjs';
import { cleanEnv } from '../hook/harness.mjs';

const base = mkdtempSync(path.join(tmpdir(), 'gitstate-'));
after(() => rmSync(base, { recursive: true, force: true }));
const env = cleanEnv({});
/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
let n = 0;
const repo = () => { const d = path.join(base, `r${++n}`); mkdirSync(d); git(d, ['init', '-q', '-b', 'main']); return d; };

describe('gitState', () => {
  test('an unborn branch, a commit, a second commit, another branch, a detached HEAD, a changed config: each state differs from the one before', () => {
    const d = repo();
    const states = [gitState(d, env)];
    assert.match(states[0], /^[0-9a-f]{40}\|refs\/heads\/main\|none$/);
    writeFileSync(path.join(d, 'a'), '1'); git(d, ['add', '-A']); git(d, ['commit', '-qm', 'one']);
    states.push(gitState(d, env));
    writeFileSync(path.join(d, 'a'), '2'); git(d, ['commit', '-qam', 'two']);
    states.push(gitState(d, env));
    git(d, ['checkout', '-qb', 'other']);
    states.push(gitState(d, env));
    git(d, ['checkout', '-q', '--detach']);
    states.push(gitState(d, env));
    assert.match(states[4], /^[0-9a-f]{40}\|detached\|[0-9a-f]{40}$/);
    git(d, ['config', 'core.hooksPath', '/dev/null']);
    states.push(gitState(d, env));
    assert.equal(new Set(states).size, states.length);
    assert.equal(gitState(d, env), states[5], 'two reads of the same files are equal');
  });
  test('packed refs are read: a branch moved after pack-refs is seen, and a loose ref beats a packed one', () => {
    const d = repo();
    writeFileSync(path.join(d, 'a'), '1'); git(d, ['add', '-A']); git(d, ['commit', '-qm', 'one']);
    const loose = gitState(d, env);
    git(d, ['pack-refs', '--all', '--prune']);
    assert.equal(gitState(d, env), loose, 'the same commit through packed-refs');
    git(d, ['commit', '-q', '--allow-empty', '-m', 'two']);
    assert.notEqual(gitState(d, env), loose);
  });
  test('a linked worktree: its own HEAD, the common config and refs', () => {
    const d = repo();
    writeFileSync(path.join(d, 'a'), '1'); git(d, ['add', '-A']); git(d, ['commit', '-qm', 'one']);
    const wt = path.join(base, 'wt');
    git(d, ['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
    const s0 = gitState(wt, env);
    assert.match(s0, /\|detached\|[0-9a-f]{40}$/);
    git(wt, ['commit', '-q', '--allow-empty', '-m', 'in the worktree']);
    const s1 = gitState(wt, env);
    assert.notEqual(s1, s0);
    git(d, ['config', 'core.hooksPath', '/dev/null']);
    assert.notEqual(gitState(wt, env), s1, 'the common config is the worktree\'s config');
    git(wt, ['checkout', '-qb', 'wt-branch']);
    assert.match(gitState(wt, env), /\|refs\/heads\/wt-branch\|[0-9a-f]{40}$/);
  });
  test('the reftable format and a folder that is no repository are answered with git itself, in the same shape', () => {
    const d = path.join(base, 'rt');
    mkdirSync(d);
    const init = spawnSync('git', ['init', '-q', '--ref-format=reftable', d], { env, encoding: 'utf8' });
    if (init.status !== 0) return;   // an older git: no reftable to test
    git(d, ['commit', '-q', '--allow-empty', '-m', 'one']);
    proc.resetSpawnCounts();
    const s = gitState(d, env);
    assert.match(s, /^[0-9a-f]{40}\|refs\/heads\/[a-z]+\|[0-9a-f]{40}$/);
    assert.ok(proc.spawnCounts().total >= 1, 'git was asked');
    git(d, ['commit', '-q', '--allow-empty', '-m', 'two']);
    assert.notEqual(gitState(d, env), s);
    const plain = path.join(base, 'plain');
    mkdirSync(plain);
    assert.equal(gitState(plain, env), 'none');
  });
  test('a branch ref that is itself a symbolic ref is followed: a commit made on its target during the step is seen (the old reading stopped at the first hop)', () => {
    const d = repo();
    writeFileSync(path.join(d, 'a'), '1'); git(d, ['add', '-A']); git(d, ['commit', '-qm', 'one']);
    git(d, ['branch', 'b']);
    writeFileSync(path.join(d, '.git/refs/heads/main'), 'ref: refs/heads/b\n');
    const before = gitState(d, env);
    assert.match(before, /\|refs\/heads\/main>refs\/heads\/b\|[0-9a-f]{40}$/);
    assert.equal(git(d, ['rev-parse', 'HEAD']), before.split('|')[2], 'the commit git itself resolves');
    git(d, ['commit', '-q', '--allow-empty', '-m', 'made during the step']);
    const after = gitState(d, env);
    assert.notEqual(after, before);
    assert.equal(git(d, ['rev-parse', 'HEAD']), after.split('|')[2]);
    git(d, ['pack-refs', '--all']);
    assert.equal(gitState(d, env).split('|')[2], after.split('|')[2], 'the same chain after pack-refs');
  });
  test('a symbolic ref whose target is only in packed-refs, and a ref that does not exist yet', () => {
    const d = repo();
    writeFileSync(path.join(d, 'a'), '1'); git(d, ['add', '-A']); git(d, ['commit', '-qm', 'one']);
    git(d, ['branch', 'b']); git(d, ['pack-refs', '--all', '--prune']);
    writeFileSync(path.join(d, '.git/refs/heads/main'), 'ref: refs/heads/b\n');
    assert.match(gitState(d, env), /\|refs\/heads\/main>refs\/heads\/b\|[0-9a-f]{40}$/);
    writeFileSync(path.join(d, '.git/refs/heads/main'), 'ref: refs/heads/nowhere\n');
    const s = gitState(d, env);
    assert.match(s, /\|refs\/heads\/main>refs\/heads\/nowhere\|none$/);
    git(d, ['update-ref', 'refs/heads/nowhere', git(d, ['rev-parse', 'refs/heads/b'])]);
    assert.notEqual(gitState(d, env), s, 'the ref coming into existence is a change');
  });
  test('fail closed: a cycle, too many hops and a ref file that holds neither a commit nor a symbolic ref keep the raw bytes in the state, so any change of them is seen', () => {
    const d = repo();
    writeFileSync(path.join(d, 'a'), '1'); git(d, ['add', '-A']); git(d, ['commit', '-qm', 'one']);
    const heads = path.join(d, '.git/refs/heads');
    writeFileSync(path.join(heads, 'main'), 'ref: refs/heads/x\n'); writeFileSync(path.join(heads, 'x'), 'ref: refs/heads/main\n');
    const cycle = gitState(d, env);
    assert.match(cycle, /\|refs\/heads\/main>refs\/heads\/x\|unresolved:cycle at refs\/heads\/main$/);
    assert.equal(gitState(d, env), cycle);
    writeFileSync(path.join(heads, 'x'), 'ref: refs/heads/y\n'); writeFileSync(path.join(heads, 'y'), 'ref: refs/heads/main\n');
    assert.notEqual(gitState(d, env), cycle, 'a changed link of the cycle');
    for (let i = 0; i < 12; i++) writeFileSync(path.join(heads, `h${i}`), `ref: refs/heads/h${i + 1}\n`);
    writeFileSync(path.join(heads, 'main'), 'ref: refs/heads/h0\n');
    const deep = gitState(d, env);
    assert.match(deep, /\|unresolved:more than 8 hops/);
    writeFileSync(path.join(heads, 'h3'), 'ref: refs/heads/other\n');
    assert.notEqual(gitState(d, env), deep, 'a change inside the bound is seen (git itself stops at 5 hops, the old reading at the first)');
    writeFileSync(path.join(heads, 'main'), 'not a ref at all\n');
    const junk = gitState(d, env);
    assert.match(junk, /\|unresolved:not a ref at all$/);
    writeFileSync(path.join(heads, 'main'), 'not a ref at all, changed\n');
    assert.notEqual(gitState(d, env), junk);
  });
  test('no process is started to read a normal repository', () => {
    const d = repo();
    git(d, ['commit', '-q', '--allow-empty', '-m', 'one']);
    proc.resetSpawnCounts();
    gitState(d, env);
    assert.equal(proc.spawnCounts().total, 0);
  });
});
