// @ts-check
// Issue 338 B10 (A357): `worktree-add` starts a run from the canonical branch of the remote, not from a local branch that a merge left behind (R2: a merged pull request
// left the local `main` behind and the next worktree started on a stale base). It fetches the branch, fast-forwards the local branch when it is strictly behind, and refuses
// to start behind it or on a diverged branch. A local branch that is ahead (unpushed commits) and a project without a remote keep working as before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AB, binstall, bnew, fakes, g, gOk, has, path, put, real, rmSync } from './batch-lib.mjs';
import { tempDir } from '../lib/tempdir.mjs';

/** A project with a bare origin and a second clone that can move the origin. @returns {{ dir: string, other: string, origin: string, F: ReturnType<typeof fakes>, push: (name: string) => string }} */
function setup() {
  const F = fakes();
  const dir = bnew();
  binstall(dir);
  const origin = g(dir, ['remote', 'get-url', 'origin']);
  const other = tempDir('proofline-b10-other-');
  gOk(other, ['clone', '-q', '-b', 'main', origin, '.']);
  /** A commit on the origin's main made from the second clone. @param {string} name */
  const push = (name) => {
    put(path.join(other, name), `${name}\n`);
    gOk(other, ['add', '-A']);
    gOk(other, ['commit', '-q', '-m', `origin ${name}`]);
    gOk(other, ['push', '-q', 'origin', 'HEAD:main']);
    return g(other, ['rev-parse', 'HEAD']);
  };
  return { dir, other, origin, F, push };
}

test('worktree-add: a local main that is behind its remote is fast-forwarded, and the worktree starts on the remote tip', () => {
  const { dir, F, push } = setup();
  const tip = push('from-origin.txt');
  assert.notEqual(g(dir, ['rev-parse', 'main']), tip, 'the local main must be behind to begin with');
  const r = AB(F, dir, ['worktree-add', 'B-1']);
  assert.equal(r.status, 0, r.text);
  const wt = r.out.trim();
  assert.equal(g(dir, ['rev-parse', 'main']), tip, 'the local main was not fast-forwarded');
  assert.equal(g(wt, ['rev-parse', 'HEAD']), tip, 'the worktree did not start on the remote tip');
  assert.ok(has(path.join(wt, 'from-origin.txt')));
  assert.ok(has(path.join(dir, 'from-origin.txt')), 'the main working tree followed its branch');
  assert.match(r.text, /fast-forwarded main/);
});

test('worktree-add: a diverged main, a main that cannot be fast-forwarded and a local main that is ahead', () => {
  const { dir, F, push } = setup();
  // ahead: an unpushed local commit is the base, as before
  put(path.join(dir, 'local-only.txt'), 'x\n'); gOk(dir, ['add', '-A']); gOk(dir, ['commit', '-q', '-m', 'local only']);
  const local = g(dir, ['rev-parse', 'main']);
  let r = AB(F, dir, ['worktree-add', 'B-ahead']);
  assert.equal(r.status, 0, r.text);
  assert.equal(g(r.out.trim(), ['rev-parse', 'HEAD']), local);
  AB(F, dir, ['worktree-remove', 'B-ahead', '--force']);
  // diverged: the remote has a commit the local main has not, and the local main has one the remote has not
  const tip = push('remote-side.txt');
  r = AB(F, dir, ['worktree-add', 'B-div']);
  assert.notEqual(r.status, 0, 'a diverged base was accepted');
  assert.match(r.text, /diverged/);
  assert.equal(g(dir, ['rev-parse', 'main']), local, 'the local main moved');
  assert.ok(!has(path.join(real(dir), '.agents/local/worktrees/B-div')), 'a worktree was made on a diverged base');
  // behind but the main working tree holds a change that the fast-forward would overwrite: refused, nothing moved
  gOk(dir, ['reset', '-q', '--hard', 'HEAD~1']);
  put(path.join(dir, 'remote-side.txt'), 'mine, uncommitted\n');
  const behind = g(dir, ['rev-parse', 'main']);
  r = AB(F, dir, ['worktree-add', 'B-dirty']);
  assert.notEqual(r.status, 0, 'a worktree was started behind the remote');
  assert.match(r.text, /behind origin\/main/);
  assert.equal(g(dir, ['rev-parse', 'main']), behind);
  assert.notEqual(behind, tip);
});

test('worktree-add: a remote that cannot be reached: the last known origin tip is still used (with a note)', () => {
  const { dir, F, origin, push } = setup();
  const tip = push('later.txt');
  gOk(dir, ['fetch', '-q', 'origin']);   // the tracking ref now knows the tip, the local main does not
  rmSync(origin, { recursive: true, force: true });   // the remote is gone
  const r = AB(F, dir, ['worktree-add', 'B-off']);
  assert.equal(g(dir, ['rev-parse', 'origin/main']), tip);
  assert.equal(r.status, 0, r.text);   // the last known tip is used to fast-forward even when the fetch fails
  assert.equal(g(dir, ['rev-parse', 'main']), tip);
  assert.match(r.text, /could not fetch origin/);
});

test('worktree-add: a project without a remote is unchanged', () => {
  const F = fakes();
  const dir = bnew();
  binstall(dir, { remote: false });
  const r = AB(F, dir, ['worktree-add', 'B-none']);
  assert.equal(r.status, 0, r.text);
  assert.doesNotMatch(r.text, /fetch|fast-forward/);
});
