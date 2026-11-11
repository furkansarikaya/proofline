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
/** File (relative to tests/) -> the number of `mkdtemp*` calls it may have, and why they are safe (optional 3rd/4th: bare uses of the name allowed, a hand-named tmpdir folder allowed). */
const EXCEPT = /** @type {Record<string, [number, string, number?, boolean?]>} */ ({
  'lib/tempdir.mjs': [1, 'the helper itself'],
  'lib/census.test.mjs': [2, 'the text of the regular expression and of the sample files of this test', 6, true],
  'lib/harness.mjs': [3, 'the base folder of tmp() (removed at exit and on signals), tmp() under it, and the private build folder of the cache'],
  'core/githooks-trust.test.mjs': [1, 'inside the sandbox folder of the test, which the test removes'],
  'core/frontend-lib.mjs': [1, 'inside the test folder T'],
  'core/run6-corpnet.test.mjs': [1, 'in the home folder on purpose (a path outside the temp folder), removed in a finally'],
  'core/run6-platform.test.mjs': [2, 'under tests/core/.fake-tools/<pid>, which clean-temp prunes (cleanFakeTools)'],
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

/** The problems of a tree: files with more `mkdtemp*` calls than `except` allows. @param {string} dir @param {Record<string, [number, string, number?, boolean?]>} except */
function census(dir, except) {
  /** @type {string[]} */ const problems = [];
  for (const f of files(dir)) {
    const rel = path.relative(dir, f).split(path.sep).join('/');
    const text = readFileSync(f, 'utf8');
    const calls = (text.match(/\bmkdtemp(?:Sync)?\(/g) ?? []).length;
    const allowed = except[rel]?.[0] ?? 0;
    if (calls > allowed) problems.push(`${rel}: ${calls} mkdtemp call(s), ${allowed} allowed: use tempDir() of tests/lib/tempdir.mjs (or tmp() of the harness)`);
    // an alias (`const e = mkdtempSync; e(...)`) is a call the count above cannot see: the name is allowed in an import, a re-export, a destructuring of a dynamic import and a comment, nowhere else without a call
    const code = text.replace(/\bimport\s[^;]*?\bfrom\s*['"][^'"]+['"]/gs, '').replace(/\bexport\s*\{[^}]*\}/g, '').replace(/\{[^}]*\}\s*=\s*await\s+import\([^)]*\)/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const bare = (code.match(/\bmkdtemp(?:Sync)?\b(?!\s*\()/g) ?? []).length;
    if (bare > (except[rel]?.[2] ?? 0)) problems.push(`${rel}: mkdtemp used as a value (an alias?), not as a call: use tempDir() of tests/lib/tempdir.mjs`);
    // a folder named by hand under the temp folder is never found again after a kill
    if (/\bmkdirSync\(\s*(?:`\$\{\s*(?:os\.)?tmpdir\(\)|(?:os\.)?tmpdir\(\)\s*\+|(?:path\.)?(?:join|resolve)\(\s*(?:os\.)?tmpdir\(\)[^)]*(?:Date\.now|Math\.random|process\.pid))/.test(code) && !except[rel]?.[3]) {
      problems.push(`${rel}: a folder named by hand under tmpdir() (mkdirSync): use tempDir() of tests/lib/tempdir.mjs`);
    }
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

test('the census finds an alias of mkdtemp and a folder named by hand under tmpdir(), and leaves imports, comments and calls alone', () => {
  const d = tempDir('census-alias-');
  writeFileSync(path.join(d, 'alias.mjs'), "import {\n  mkdtempSync,\n} from 'node:fs';\nconst e = mkdtempSync;\n");
  writeFileSync(path.join(d, 'rolled.mjs'), "import { mkdirSync } from 'node:fs';\nmkdirSync(tmpdir() + '/x' + Date.now());\n");
  writeFileSync(path.join(d, 'rolled2.mjs'), 'mkdirSync(`${tmpdir()}/x-${process.pid}`);\n');
  writeFileSync(path.join(d, 'fine.mjs'), "import { mkdtempSync as m } from 'node:fs';\n// mkdtemp is not used here\n/* mkdtempSync */\nconst x = 'http://a';\n");
  assert.deepEqual(census(d, {}), [
    'alias.mjs: mkdtemp used as a value (an alias?), not as a call: use tempDir() of tests/lib/tempdir.mjs',
    'rolled.mjs: a folder named by hand under tmpdir() (mkdirSync): use tempDir() of tests/lib/tempdir.mjs',
    'rolled2.mjs: a folder named by hand under tmpdir() (mkdirSync): use tempDir() of tests/lib/tempdir.mjs',
  ]);
});

test('tempDir makes an empty folder in the proofline-t- family', () => {
  const d = tempDir('census-');
  assert.match(path.basename(d), /^proofline-t-census-[A-Za-z0-9]{6}$/);
  assert.deepEqual(readdirSync(d), []);
});
