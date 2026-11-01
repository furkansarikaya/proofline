// @ts-check
// stash_net_count: the JS matcher against the awk of proofline-hook.sh (POSIX leftmost-longest). One awk run counts a whole corpus (records are
// separated by \001, the awk prints one number per record).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stashNetCount } from '../../adapters/claude/hooks/guards/stash.mjs';

const repo = resolve(import.meta.dirname, '../..');
const hook = readFileSync(join(repo, 'adapters/claude/hooks/proofline-hook.sh'), 'utf8');
const start = hook.indexOf("awk 'BEGIN { RS = \"\\001\" }", hook.indexOf('stash_net_count() {'));
const end = hook.indexOf("\n  }'\n", start);
const program = hook.slice(start + 5, end + 4);

const fixed = [
  'git stash', 'git stash list', 'git -C /x stash', 'git -C $W stash', 'git -C $W status', 'git -c -c $S status', 'git -C -C $S', 'git -C $W -C $S',
  'echo git stash', 'grep "git stash" f', 'cd x && git stash pop', 'FOO=1 git stash', 'A=1 B=2 git stash;git stash', 'git $SUB', 'git `x` y', 'git "$S" list',
  'git --git-dir=/x stash', 'git --git-dir /x stash', 'git --exec-path stash', 'git -C "a b" stash', "git -C 'a b' stash", 'git -C $(pwd) stash', 'git -C `pwd` stash',
  'git status; git stash drop', 'git stash;git stash', 'x | git stash', '(git stash)', '{ git stash; }', 'git -p stash', 'git --no-pager stash', 'git stash$', 'git stash)',
  'xgit stash', '.git stash', 'sgit stash', 'a-git stash', 'git  -C   d   stash', "git\tstash", 'git -C', 'git', 'git -C $', 'git -C $ stash', 'git -C $ status', 'git -C `', 'git -C `a` status',
  'git -C $(a) status', 'git -C ${X} status', 'git -C ${X} stash', 'git -c x=y -C z stash', 'git -c a stash b', 'cat x\ngit stash', 'ls && git stash', 'true; git $x',
];

/** @param {() => number} rnd */
function randomCase(rnd) {
  const toks = ['git', 'stash', '-C', '-c', '--git-dir', '--exec', '--no-pager', '-p', '$W', '$(pwd)', '`x`', '"a b"', "'a b'", 'status', 'list', ';', '&&', '|', '(', ')', '{', '}', '$', '`', 'echo', 'grep', 'A=1', 'cd', '/x', '\n', '--', 'x git', 'stash;'];
  const n = 2 + Math.floor(rnd() * 9);
  let out = '';
  for (let i = 0; i < n; i++) out += `${toks[Math.floor(rnd() * toks.length)]}${rnd() < 0.8 ? ' ' : rnd() < 0.5 ? '\t' : ''}`;
  return out.replace(/\s+$/, rnd() < 0.5 ? '' : ' ');
}

test('stash_net_count matches the awk on a table and on a seeded fuzz', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const cases = [...fixed];
  for (let i = 0; i < 1500; i++) cases.push(randomCase(rnd));
  const dir = mkdtempSync(join(tmpdir(), 'stash-net-'));
  try {
    writeFileSync(join(dir, 'p.awk'), program);
    writeFileSync(join(dir, 'in'), cases.join('\x01'));
    const r = spawnSync('awk', ['-f', join(dir, 'p.awk'), join(dir, 'in')], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    assert.equal(r.status, 0, r.stderr);
    const want = r.stdout.split('\n').filter((l) => l !== '').map(Number);
    assert.equal(want.length, cases.length);
    const bad = [];
    for (let i = 0; i < cases.length; i++) if (stashNetCount(/** @type {string} */ (cases[i])) !== want[i]) bad.push({ c: cases[i], awk: want[i], js: stashNetCount(/** @type {string} */ (cases[i])) });
    assert.deepEqual(bad.slice(0, 10), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
