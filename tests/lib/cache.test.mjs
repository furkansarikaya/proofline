// @ts-check
// The template cache of the harness (`cached` and `copyOf` of tests/lib/harness.mjs), the Node form of tests/ci/fixture-test.sh (retired by issue #176 package E1, A244, with the shell
// fixture library it tested): a template is built for its key, found again under the same key, built anew under another key (the old one stays as it was), every copy is independent
// and never changes the template, and concurrent callers of one key leave ONE complete template behind at the final path, whoever built it and however many did: the publish is an
// atomic rename, a second build is wasted work and not a wrong result, so the number of builds is not asserted beyond "at least one, at most one per caller". The contenders are separate
// processes that meet at a file barrier inside the builder (no sleep, no time window): all of them are inside the build when the first one publishes, so the loser path always runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { cached, cleanEnv, copyOf, discard, git, tmp } from './harness.mjs';

const harnessUrl = new URL('./harness.mjs', import.meta.url).href;

/** A builder: a repository with one commit that holds the given text in a.txt, and one line appended to the build log. @param {string} text @param {string} [log] */
const builder = (text, log) => (/** @type {string} */ dir) => {
  writeFileSync(path.join(dir, 'a.txt'), text);
  git(dir, ['init', '-q', '-b', 'main']); git(dir, ['add', 'a.txt']); git(dir, ['commit', '-q', '-m', 'base']);
  if (log) appendFileSync(log, `${text}\n`);
};
const lines = (/** @type {string} */ f) => readFileSync(f, 'utf8').split('\n').filter(Boolean);

describe('a template', () => {
  test('is built on first use, found again under the same key, and built anew under another key; the old one stays as it was', () => {
    const root = tmp('cache'); const log = path.join(tmp('log'), 'builds');
    writeFileSync(log, '');
    const t1 = cached('k1', builder('v1', log), root);
    assert.equal(readFileSync(path.join(t1, 'a.txt'), 'utf8'), 'v1');
    assert.equal(t1, path.join(root, 'k1'));
    assert.equal(cached('k1', builder('v1', log), root), t1, 'the same key reuses the template');
    assert.deepEqual(lines(log), ['v1'], 'no second build for the same key');
    const t2 = cached('k2', builder('v2', log), root);
    assert.notEqual(t2, t1);
    assert.equal(readFileSync(path.join(t2, 'a.txt'), 'utf8'), 'v2');
    assert.equal(readFileSync(path.join(t1, 'a.txt'), 'utf8'), 'v1');
    assert.deepEqual(lines(log), ['v1', 'v2']);
  });

  test('two copies are independent (files and git history); a copy is a working repository of its own and never changes the template', () => {
    const root = tmp('cache');
    const t = cached('k', builder('v2'), root);
    const c1 = copyOf(t); const c2 = copyOf(t);
    writeFileSync(path.join(c1, 'a.txt'), 'changed in c1'); git(c1, ['commit', '-q', '-am', 'c1only']); writeFileSync(path.join(c1, 'new.txt'), 'extra');
    assert.equal(readFileSync(path.join(c2, 'a.txt'), 'utf8'), 'v2');
    assert.ok(!existsSync(path.join(c2, 'new.txt')));
    assert.equal(git(c2, ['rev-list', '--count', 'HEAD']), '1');
    assert.equal(git(c1, ['rev-list', '--count', 'HEAD']), '2');
    assert.equal(readFileSync(path.join(t, 'a.txt'), 'utf8'), 'v2');
    assert.equal(git(t, ['rev-list', '--count', 'HEAD']), '1');
    assert.equal(git(t, ['status', '--porcelain']).replace('?? .built', ''), '', 'the template is clean (its marker aside)');
    assert.equal(git(c2, ['rev-parse', '--git-dir']), '.git');
    assert.equal(git(c2, ['status', '--porcelain']), '', 'a copy is clean');
    assert.ok(!existsSync(path.join(c2, '.built')), 'the marker of a finished build is not copied');
  });

  test('a failing builder leaves neither a template nor a build directory, and a later caller builds', () => {
    const root = tmp('cache');
    assert.throws(() => cached('bad', () => { throw new Error('the builder failed'); }, root), /the builder failed/);
    assert.deepEqual(readdirSync(root), [], 'nothing is left under the cache folder');
    const t = cached('bad', builder('ok'), root);
    assert.equal(readFileSync(path.join(t, 'a.txt'), 'utf8'), 'ok');
  });

  test('a template that is already there is returned without a build, whatever else lies in the cache folder', () => {
    const root = tmp('cache');
    mkdirSync(path.join(root, 'done'), { recursive: true }); writeFileSync(path.join(root, 'done', '.built'), '');
    mkdirSync(path.join(root, 'build-done-stale'));   // the private folder of a builder that was killed
    assert.equal(cached('done', () => { throw new Error('built over a present template'); }, root), path.join(root, 'done'));
  });
});

describe('concurrent callers of one key', () => {
  /**
   * N processes call `cached` with a builder that meets the others at a barrier (a file per contender, polled without a clock decision: every contender is inside its build before
   * any of them can publish), then builds. Resolves with each contender's exit code, stdout and stderr.
   * @param {string} root @param {string} key @param {number} n @param {string} bar
   */
  function contend(root, key, n, bar) {
    const code = `
      import { cached } from ${JSON.stringify(harnessUrl)};
      import { spawnSync } from 'node:child_process';
      import { existsSync, readdirSync, writeFileSync } from 'node:fs';
      const [root, key, bar, n, me] = process.argv.slice(1);
      const wait = () => { const c = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(c, 0, 0, 10); };
      const dir = cached(key, (d) => {
        writeFileSync(bar + '/' + me, '');
        while (readdirSync(bar).length < Number(n)) wait();
        const g = (...a) => spawnSync('git', a, { cwd: d, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@example.invalid' } });
        writeFileSync(d + '/a.txt', 'v3'); g('init', '-q', '-b', 'main'); g('add', 'a.txt'); g('commit', '-q', '-m', 'base');
      }, root);
      process.stdout.write(dir);
    `;
    return Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code, root, key, bar, String(n), String(i)], { env: cleanEnv({}) });
      let out = ''; let err = '';
      c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
      c.on('close', (status) => resolve({ status, out, err }));
    })));
  }
  /** What a race has to leave behind. @param {string} root @param {string} key @param {Array<{ status: number | null, out: string, err: string }>} results */
  function outcome(root, key, results) {
    for (const [i, r] of results.entries()) assert.equal(r.status, 0, `contender ${i}: ${r.err}`);
    assert.deepEqual([...new Set(results.map((r) => r.out))], [path.join(root, key)], 'every contender got the final path');
    assert.deepEqual(readdirSync(root).sort(), [key], 'the final directory is the only thing under the cache folder (no private build directory)');
    const t = path.join(root, key);
    assert.equal(readFileSync(path.join(t, 'a.txt'), 'utf8'), 'v3', 'the template is complete');
    assert.equal(git(t, ['rev-list', '--count', 'HEAD']), '1');
    assert.equal(git(t, ['status', '--porcelain']).replace('?? .built', ''), '', 'the template is a clean repository of one commit');
    assert.ok(existsSync(path.join(t, '.built')));
    assert.deepEqual(readdirSync(t).filter((n) => n.startsWith('build-')), [], 'no build directory is nested in the template');
  }

  for (const n of [4, 8]) {
    test(`${n} contenders inside the build at once: one complete template at the final path, nothing left behind`, { timeout: 120000 }, async () => {
      const root = tmp('cache'); const bar = tmp('barrier');
      const results = await contend(root, 'race', n, bar);
      assert.equal(readdirSync(bar).length, n, 'every contender built (they met at the barrier)');
      outcome(root, 'race', /** @type {any} */ (results));
    });
  }

  test('a contender that arrives after the publish finds the template and does not build', async () => {
    const root = tmp('cache'); const bar = tmp('barrier');
    outcome(root, 'late', /** @type {any} */ (await contend(root, 'late', 1, bar)));
    const second = /** @type {any} */ (await contend(root, 'late', 1, bar));
    assert.equal(readdirSync(bar).length, 1, 'the second contender did not enter the builder');
    outcome(root, 'late', second);
  });
});

test('a publish that fails for a real reason removes the private build directory and says so (it does not pass for a lost race)', () => {
  const root = tmp('cache');
  writeFileSync(path.join(root, 'blocked'), 'a file where the template should go');
  assert.throws(() => cached('blocked', (d) => writeFileSync(path.join(d, 'a.txt'), 'x'), root));
  assert.deepEqual(readdirSync(root).sort(), ['blocked'], 'no build-* directory is left');
});

test('a loser that finds the complete template discards its copy, and the copy is gone when cached() returns', () => {
  const root = tmp('cache');
  const first = cached('k', (d) => writeFileSync(path.join(d, 'a.txt'), 'v1'), root);
  mkdirSync(path.join(first, 'sub')); // the winner's directory is not empty and stays so
  // a second call that does not see .built (as a contender that started before the publish) builds, loses the rename and cleans up
  rmSync(path.join(first, '.built'));
  const second = cached('k', (d) => { writeFileSync(path.join(d, 'a.txt'), 'v2'); writeFileSync(path.join(first, '.built'), ''); }, root);
  assert.equal(second, first);
  assert.deepEqual(readdirSync(root).sort(), ['k']);
  assert.equal(readFileSync(path.join(first, 'a.txt'), 'utf8'), 'v1', 'the winner is untouched');
});

test('discard does not trust the first removal: a directory the platform call leaves behind is removed entry by entry, links are not followed', () => {
  const root = tmp('cache'); const outside = path.join(tmp('outside'), 'keep.txt');
  writeFileSync(outside, 'mine');
  const dir = path.join(root, 'build-x-1');
  mkdirSync(path.join(dir, '.git/objects/ab'), { recursive: true });
  writeFileSync(path.join(dir, '.git/objects/ab/cd'), 'x', { mode: 0o444 }); writeFileSync(path.join(dir, '.built'), '');
  symlinkSync(path.dirname(outside), path.join(dir, 'link'));
  const ro = path.join(dir, '.git/objects/pack');   // a read-only directory with a file in it (git leaves such trees)
  mkdirSync(ro); writeFileSync(path.join(ro, 'p.pack'), 'x'); chmodSync(ro, 0o555);
  try { discard(dir, () => { /* a removal that reports success and removes nothing */ }); } finally { try { chmodSync(ro, 0o700); } catch { /* already gone */ } }
  assert.deepEqual(readdirSync(root), [], 'the directory is gone');
  assert.equal(readFileSync(outside, 'utf8'), 'mine', 'a link inside it was removed, not followed');
  discard(dir, () => { throw new Error('busy'); });   // already gone, whatever the first attempt did
});
