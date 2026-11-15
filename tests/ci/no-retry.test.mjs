// @ts-check
// Issue 266 package 3a (A277), AC-3: CI has no automatic retry of a test. A failing test fails its job, once. This scans every workflow for the ways a retry is written: the retry
// action, a retry flag or option of a runner, a rerun of failed jobs or tests, and `continue-on-error: true` on a step or job that runs tests (`fail-fast: false` is fine: it only lets the
// other legs finish). `node --test` has no retry option at all. The finder is a pure function with mutant rows, so a retry that is added later cannot slip through unseen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const dir = path.join(repo, '.github/workflows');

/** @type {Array<[RegExp, string]>} */
const RETRY = [
  [/nick-fields\/retry|uses:\s*\S*retry\S*/i, 'a retry action'],
  [/--retries\b|--retry\b|--max-retries\b|--maxRetries\b|\bmaxRetries\b|\bretryTimes\b|--flaky-retries|--rerun-failed|\brerun-failed\b|\brerun_failed\b/, 'a retry option of a test runner'],
  [/\bgh\s+run\s+rerun\b|\brerun-failed-jobs\b|actions\/runs\/[^\s]*\/rerun/i, 'a rerun of failed jobs'],
  [/\b(max[_-]?attempts?|retry[_-]?(on|wait|count|limit)|retries)\s*:/i, 'a retry setting'],
  [/\b(retry|retries)\s*\(|\bwhile\b[^\n]*\bretry\b|\buntil\b[^\n]*\bnode\b[^\n]*--test/i, 'a retry loop'],
];
const TESTISH = /--test\b|test-durations-ci|ci-steps\.mjs\s+skill|windows-probe|\bnpm\s+(run\s+)?test\b|\bjest\b|\bpytest\b|\bgo\s+test\b/;

/**
 * The retry findings of a workflow text (comments are not code and are ignored). A step is the lines from one `- ` at the step indent to the next; a job-level
 * `continue-on-error: true` counts when the job has a test step. @param {string} text @returns {string[]}
 */
export function retryFindings(text) {
  const lines = text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).filter((l) => l.trim() !== '');
  /** @type {string[]} */ const out = [];
  lines.forEach((l, i) => { for (const [re, what] of RETRY) if (re.test(l)) out.push(`line ${i + 1}: ${what}: ${l.trim()}`); });
  /** @type {string[][]} */ const steps = [];
  /** @type {string[] | null} */ let cur = null;
  for (const l of lines) {
    if (/^ {6}- /.test(l)) { cur = [l]; steps.push(cur); } else if (/^ {0,5}\S/.test(l) && !/^ {6}/.test(l)) cur = null; else if (cur) cur.push(l);
  }
  for (const s of steps) if (TESTISH.test(s.join('\n')) && /continue-on-error:\s*(true|\$\{\{)/.test(s.join('\n'))) out.push(`continue-on-error on a test step: ${s[0].trim()}`);
  if (steps.some((s) => TESTISH.test(s.join('\n'))) && lines.some((l) => /^ {4}continue-on-error:\s*(true|\$\{\{)/.test(l))) out.push('continue-on-error on a job with test steps');
  return out;
}

test('no workflow retries a test: every .github/workflows/*.yml is clean', () => {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.includes('ci.yml'));
  for (const f of files) assert.deepEqual(retryFindings(readFileSync(path.join(dir, f), 'utf8')), [], f);
});

test('the finder is not blind: mutant workflows with a retry are caught', () => {
  const head = 'jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n';
  const rows = /** @type {Array<[string, string]>} */ ([
    ['nick-fields/retry', `${head}      - uses: nick-fields/retry@v3\n        with:\n          command: node --test x\n`],
    ['retry flag', `${head}      - run: node --test --retries=2 x\n`],
    ['maxRetries', `${head}      - run: npx jest --maxRetries 3\n`],
    ['rerun-failed', `${head}      - run: node --test --rerun-failed x\n`],
    ['gh run rerun', `${head}      - run: gh run rerun \${{ github.run_id }} --failed\n`],
    ['max_attempts', `${head}      - uses: some/action@v1\n        with:\n          max_attempts: 3\n`],
    ['continue-on-error on a test step', `${head}      - name: tests\n        continue-on-error: true\n        run: node --test x\n`],
    ['continue-on-error on a durations step', `${head}      - run: node tests/ci/test-durations-ci.mjs leg -- x\n        continue-on-error: true\n`],
    ['continue-on-error on the job', `jobs:\n  t:\n    continue-on-error: true\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test x\n`],
  ]);
  for (const [name, text] of rows) assert.ok(retryFindings(text).length > 0, name);
});

test('what is allowed stays allowed: fail-fast false, comments about retry, continue-on-error on a step that runs no test, retention-days', () => {
  const ok = 'jobs:\n  t:\n    strategy:\n      fail-fast: false\n    steps:\n      # never a retry: no nick-fields/retry here, no --retries\n      - run: node --test x\n      - name: upload\n        continue-on-error: true\n        uses: actions/upload-artifact@v4\n        with:\n          retention-days: 14\n';
  assert.deepEqual(retryFindings(ok), []);
});
