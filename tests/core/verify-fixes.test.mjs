// @ts-check
// Review and security round 1 of stage 2: a changed path that cannot be baselined (symlink, nested git directory, submodule) fails the scope
// commands as it does in the shell; a path git would c-quote is the shell's; `freshness` decides its bridges before it writes; the core
// maps case with ASCII rules only. The shell is the specification.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { scriptsDir } from './helpers.mjs';
import { build, exec } from './verify-helpers.mjs';

const GIT_ENV = { PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
/** @param {string} fx @param {string[]} a */
const git = (fx, a) => spawnSync('git', ['-C', fx, '-c', 'protocol.file.allow=always', ...a], { env: GIT_ENV, encoding: 'utf8' });
const base = () => build('scaffold orchestrated no COMPLEX; A handoff LC IMPLEMENTED >/dev/null');
const SCOPE = ['verify-scope', 'verify-knowledge-scope', 'verify-handoff', 'validate'];

/** Both engines on their own copy of the tree: the same output, status and RUN.yaml/ledger. @param {string} fx @param {string[]} args @param {(copy: string) => void} [prep] */
function same(fx, args, prep = (/** @type {string} */ _c) => {}) {
  /** @type {Array<Record<string, unknown>>} */ const res = [];
  for (const engine of /** @type {const} */ (['node', 'sh'])) {
    const copy = mkdtempSync(path.join(tmpdir(), 'pl-vfix-'));
    cpSync(fx, copy, { recursive: true, verbatimSymlinks: true });
    prep(copy);
    const r = exec(copy, args, engine);
    const rd = (/** @type {string} */ f) => { try { return readFileSync(path.join(copy, '.agents/runs/LC', f), 'latin1'); } catch { return ''; } };
    res.push({ ...r, out: r.out.split(copy).join('<COPY>'), err: r.err.split(copy).join('<COPY>'), run: rd('RUN.yaml'), ledger: rd('LEDGER.log').replace(/ts=\S+ epoch=\S+/g, 'ts=T epoch=E') });
    rmSync(copy, { recursive: true, force: true });
  }
  assert.deepEqual(res[0], res[1], `agent.sh ${args.join(' ')}`);
  return res[0];
}
/** @param {string} fx */
const all = (fx) => { for (const c of SCOPE) same(fx, [c, 'LC']); };

describe('a changed path that cannot be baselined fails the scope commands (S2-1)', () => {
  test('an untracked symlink and two out-of-scope files', () => {
    const fx = base();
    spawnSync('ln', ['-s', '/etc/hosts', path.join(fx, 'lnk')]);
    writeFileSync(path.join(fx, 'zzz-evil.txt'), 'x\n'); mkdirSync(path.join(fx, 'src')); writeFileSync(path.join(fx, 'src/payload.go'), 'x\n');
    const r = same(fx, ['verify-scope', 'LC']);
    assert.equal(r.code, 1); assert.match(String(r.err), /cannot baseline symlink: lnk/);
    all(fx);
  });
  test('a symlink in the knowledge scope', () => {
    const fx = base();
    mkdirSync(path.join(fx, 'docs/wiki'), { recursive: true });
    spawnSync('ln', ['-s', '/etc/hosts', path.join(fx, 'docs/wiki/link.md')]);
    assert.equal(same(fx, ['verify-knowledge-scope', 'LC']).code, 1);
    all(fx);
  });
  test('a nested git directory', () => {
    const fx = base();
    mkdirSync(path.join(fx, 'nested')); git(path.join(fx, 'nested'), ['init', '-q']); writeFileSync(path.join(fx, 'nested/a.txt'), 'x\n');
    writeFileSync(path.join(fx, 'zzz-evil.txt'), 'x\n');
    assert.equal(same(fx, ['verify-scope', 'LC']).code, 1);
    all(fx);
  });
  test('a submodule', () => {
    const fx = base();
    const other = mkdtempSync(path.join(tmpdir(), 'pl-sub-'));
    git(other, ['init', '-q', '-b', 'main']); writeFileSync(path.join(other, 'f'), 'x\n'); git(other, ['add', 'f']); git(other, ['commit', '-q', '-m', 'i']);
    git(fx, ['submodule', 'add', '-q', other, 'sub']);
    all(fx);
    rmSync(other, { recursive: true, force: true });
  });
});

describe('a name git would c-quote (S2-5)', () => {
  test('control characters, a double quote and a non-ASCII name are judged by the shell', () => {
    const fx = base();
    for (const n of ['evil-\u001b]0;PWNED\u0007-\u001b[2J.txt', 'carriage\rreturn.txt', 'quo"te.txt', 'café.txt', 'back\\slash.txt']) writeFileSync(path.join(fx, n), 'x\n');
    const r = same(fx, ['verify-scope', 'LC']);
    assert.ok(!String(r.err).includes('\u001b'), 'no raw escape byte in the output');
    all(fx);
  });
});

describe('freshness decides its bridges before it writes', () => {
  test('a moved base with an unreadable task file leaves RUN.yaml and the ledger as the shell does', () => {
    const fx = base();
    mkdirSync(path.join(fx, '.agents/extra'), { recursive: true });
    writeFileSync(path.join(fx, '.agents/extra/cp.txt'), 'c\n');
    git(fx, ['add', '-f', '.agents/extra/cp.txt']); git(fx, ['commit', '-q', '-m', 'cp']);
    const yaml = readFileSync(path.join(fx, '.agents/runs/LC/RUN.yaml'), 'latin1');
    const src = /^task_source:\n(?:[^\n]*\n)*? {2}path: "?([^"\n]+)"?/m.exec(yaml)?.[1];
    const unreadable = (/** @type {string} */ c) => { if (src) { try { chmodSync(path.join(c, src), 0); } catch { /* absent */ } } };
    same(fx, ['freshness', 'LC'], unreadable);
    same(fx, ['validate', 'LC']);
  });
});

describe('case mapping on byte strings is ASCII only', () => {
  test('no core source maps a whole string with toLowerCase or toUpperCase', () => {
    const core = path.join(scriptsDir, 'core');
    /** @type {string[]} */ const bad = [];
    for (const dir of [core, path.join(core, 'commands')]) {
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
        readFileSync(path.join(dir, f), 'latin1').split('\n').forEach((l, i) => {
          if (!/\.(toLowerCase|toUpperCase)\(\)/.test(l)) return;
          // a single character mapper (`(c) => c.toLowerCase()`) or a drive letter is fine
          if (/\(c\) => (String\.fromCharCode\(.*\)|c\.to(Lower|Upper)Case\(\))/.test(l) || /\(c\) => c\.to/.test(l) || /drive\[1\]|msys\[1\]/.test(l)) return;
          bad.push(`${f}:${i + 1}: ${l.trim()}`);
        });
      }
    }
    assert.deepEqual(bad, []);
  });
});
