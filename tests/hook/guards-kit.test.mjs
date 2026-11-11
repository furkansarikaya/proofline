// @ts-check
// guards/kit.mjs: the worktree list read from the git dirs equals `git worktree list --porcelain`; stash_path and the glob matcher.
import { tempDir } from '../lib/tempdir.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { globMatch, stashPath, worktrees } from '../../adapters/claude/hooks/guards/kit.mjs';

/** The long physical temp directory: a Windows runner's os.tmpdir() is the 8.3 short path (C:\\Users\\RUNNER~1) while git and realpathSync.native give the long one (A246). */
const tmpdir = () => realpathSync.native(osTmpdir());
/** A path in the spelling git prints (forward slashes). @param {string} p */
const slashed = (p) => p.replaceAll('\\', '/');

/** @param {string[]} a @param {string} cwd */
const git = (a, cwd) => spawnSync('git', ['-c', 'gc.auto=0', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

test('worktrees() reads the same list as git, from the main tree and from a linked worktree', async () => {
  const base = realpathSync.native(tempDir('kit-wt-'));
  try {
    const main = join(base, 'main');
    mkdirSync(main);
    git(['init', '-q'], main); git(['commit', '-q', '--allow-empty', '-m', 'x'], main);
    git(['worktree', 'add', '-q', '--detach', join(base, 'wt1')], main);
    git(['worktree', 'add', '-q', '--detach', join(base, 'wt2')], main);
    for (const root of [main, join(base, 'wt1')]) {
      const want = git(['-C', root, 'worktree', 'list', '--porcelain'], root).stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
      const got = await worktrees(/** @type {any} */ ({ root, env: {} }));
      assert.deepEqual(got.map(slashed).sort(), want.map(slashed).sort());
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('globMatch is a shell case pattern', () => {
  assert.ok(globMatch('*.db', 'a/b.db'));
  assert.ok(globMatch('.agents/runs/*/gates/*', '.agents/runs/LC/gates/x/y'));
  assert.ok(!globMatch('*.db', 'a.dbx'));
  assert.ok(globMatch('a?c', 'abc'));
  assert.ok(globMatch('[a-c]x', 'bx'));
  assert.ok(globMatch('docs/[0-9][0-9][0-9].md', 'docs/123.md'));
  assert.ok(globMatch('a.b', 'a.b') && !globMatch('a.b', 'axb'));
});

test('stashPath resolves a directory that exists and nothing else', () => {
  const base = realpathSync.native(tempDir('kit-sp-'));
  try {
    mkdirSync(join(base, 'd'));
    const ctx = /** @type {any} */ ({ env: { TMPDIR: slashed(base), HOME: slashed(base) } });
    assert.equal(stashPath(ctx, 'd', slashed(base)), slashed(join(base, 'd')));
    assert.equal(stashPath(ctx, '$TMPDIR/d', ''), slashed(join(base, 'd')));
    assert.equal(stashPath(ctx, 'missing', base), '');
    assert.equal(stashPath(ctx, '$X/d', base), '');
    assert.equal(stashPath(ctx, '-', base), '');
    assert.equal(stashPath(ctx, 'd', ''), '');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
