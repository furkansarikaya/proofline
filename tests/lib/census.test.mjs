// @ts-check
// A census of the temporary folders the tests make (A253): a test that calls `mkdtemp*` leaves the folder behind when its run is killed, and 14 GB of such folders is what this
// package removed. Every folder of a test process is made with `tempDir()` (tests/lib/tempdir.mjs) or `tmp()` of the harness, which remove it at exit and on SIGINT/SIGTERM and which
// `node tests/lib/clean-temp.mjs` finds again. A new `mkdtemp*` call in a test file fails here until it is moved to those helpers, or listed below with the reason it is safe.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from './tempdir.mjs';

const root = path.resolve(import.meta.dirname, '..');   // tests/
/** File (relative to tests/) -> the number of `mkdtemp*` calls it may have, and why they are safe. */
const EXCEPT = /** @type {Record<string, [number, string]>} */ ({
  'lib/tempdir.mjs': [1, 'the helper itself'],
  'lib/census.test.mjs': [2, 'the text of the regular expression and of the sample file of this test'],
  'lib/harness.mjs': [3, 'the base folder of tmp() (removed at exit and on signals), tmp() under it, and the private build folder of the cache'],
  'core/githooks-trust.test.mjs': [1, 'inside the sandbox folder of the test, which the test removes'],
  'core/frontend-lib.mjs': [1, 'inside the test folder T'],
  'core/run6-corpnet.test.mjs': [1, 'in the home folder on purpose (a path outside the temp folder), removed in a finally'],
  'core/run6-platform.test.mjs': [2, 'under tests/core/.fake-tools, which clean-temp prunes (cleanFakeTools)'],
  'ci/change-reason.test.mjs': [1, 'inside the test folder T'],
  'ci/sync-design-library.test.mjs': [2, 'inside the test folder T'],
  'fixtures/trees.mjs': [1, 'inside the folder the script removes itself'],
  'hook/session-head.test.mjs': [1, 'inside the hook test base (tests/hook/harness.mjs)'],
  'hook/pretool-bash.test.mjs': [1, 'inside the hook test base'],
  'hook/capture.test.mjs': [1, 'inside the hook test base'],
  'hook/hardening.test.mjs': [2, 'inside the hook test base'],
  'hook/kill-guard.test.mjs': [1, 'inside the hook test base'],
  'e2e/capabilities.test.mjs': [1, 'inside the test root'],
  'real-session/smoke.mjs': [3, 'inside the smoke run folder, which a person keeps on purpose (proofline-smoke.*)'],
});

/** @param {string} d @returns {string[]} */
function files(d) {
  return readdirSync(d).flatMap((n) => {
    const p = path.join(d, n);
    if (n === 'node_modules' || n.startsWith('.')) return [];
    return statSync(p).isDirectory() ? files(p) : /\.(mjs|cjs|js)$/.test(n) ? [p] : [];
  });
}

/** The problems of a tree: files with more `mkdtemp*` calls than `except` allows. @param {string} dir @param {Record<string, [number, string]>} except */
function census(dir, except) {
  /** @type {string[]} */ const problems = [];
  for (const f of files(dir)) {
    const rel = path.relative(dir, f).split(path.sep).join('/');
    const calls = (readFileSync(f, 'utf8').match(/\bmkdtemp(?:Sync)?\(/g) ?? []).length;
    const allowed = except[rel]?.[0] ?? 0;
    if (calls > allowed) problems.push(`${rel}: ${calls} mkdtemp call(s), ${allowed} allowed: use tempDir() of tests/lib/tempdir.mjs (or tmp() of the harness)`);
  }
  for (const rel of Object.keys(except)) if (!existsSync(path.join(dir, rel))) problems.push(`${rel} is listed but does not exist`);
  return problems;
}

test('no test file makes a temporary folder outside tempDir()/tmp() unless it is listed with a reason', () => {
  assert.deepEqual(census(root, EXCEPT), []);
});

test('the census finds a new leaker (also under skills/), a listed file that is gone, and accepts a listed one', () => {
  const d = tempDir('census-tree-');
  mkdirSync(path.join(d, 'skills'));
  writeFileSync(path.join(d, 'skills/new.test.mjs'), "import { mkdtempSync } from 'node:fs';\nconst x = mkdtempSync(join(tmpdir(), 'wiki-'));\n");
  writeFileSync(path.join(d, 'ok.mjs'), 'const y = mkdtempSync(a);\n');
  assert.deepEqual(census(d, { 'ok.mjs': [1, 'inside a base'], 'gone.mjs': [1, 'x'] }), ['skills/new.test.mjs: 1 mkdtemp call(s), 0 allowed: use tempDir() of tests/lib/tempdir.mjs (or tmp() of the harness)', 'gone.mjs is listed but does not exist']);
});

test('tempDir makes an empty folder in the proofline-t- family', () => {
  const d = tempDir('census-');
  assert.match(path.basename(d), /^proofline-t-census-[A-Za-z0-9]{6}$/);
  assert.deepEqual(readdirSync(d), []);
});
