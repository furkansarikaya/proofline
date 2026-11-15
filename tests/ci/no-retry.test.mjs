// @ts-check
// Issue 266 package 3a (A277), AC-3: CI has no automatic retry of a test. A failing test fails its job, once. This scans EVERY workflow in .github/workflows for the ways a retry or
// a swallowed failure is written. Three layers:
//  (1) anywhere in a workflow (comments are ignored): a retry action, a retry/attempt/rerun word or option (`--retries`, `max_attempts`, `attempt_limit`, `gh run rerun`, ...);
//  (2) `continue-on-error` set to anything but a literal false, on any step or job of any workflow. There is no allowed use today (ALLOWED_CONTINUE_ON_ERROR is empty: a use needs a row with a reason);
//  (3) in a TEST STEP: a shell construct that runs a command again or hides its status (`||`, `; true`, `set +e`, `for ... in`, `while`, `until`, `break`), and a step that runs tests under
//      `if: failure()` (a rerun after a failure). A test step is a step whose `run:` command contains `--test`, `test-durations-ci`, the skill-tests command of ci-steps, `windows-probe`, or a
//      known runner (`npm test`, `jest`, `pytest`, `go test`). Non-test steps may use shell logic freely (the strict no-shell-logic check polices them).
// `fail-fast: false` is fine: it only lets the other legs finish. The finder is a pure function with mutant rows, so a retry added later cannot slip through unseen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const dir = path.join(repo, '.github/workflows');

/** Allowed non-test uses of continue-on-error: `<workflow file>:<step or job name>` -> reason. Empty: none exists. @type {Record<string, string>} */
const ALLOWED_CONTINUE_ON_ERROR = {};

/** @type {Array<[RegExp, string]>} */
const ANYWHERE = [
  [/nick-fields\/retry|uses:\s*\S*retry\S*/i, 'a retry action'],
  [/retr(y|ies)|--flaky|attempt|rerun|re-run/i, 'a retry, attempt or rerun word'],
  [/--maxRetries\b|\bretryTimes\b/i, 'a retry option of a test runner'],
];
const TEST_RUN = /--test\b|test-durations-ci|ci-steps\.mjs\s+skill|windows-probe|\bnpm\s+(run\s+)?test\b|\bjest\b|\bpytest\b|\bgo\s+test\b/;
/** @type {Array<[RegExp, string]>} */
const SHELL = [
  [/\|\|/, 'an `||` after a test command'],
  [/;\s*(true|:)\b|;\s*:\s*$/, 'a `; true` that hides the status'],
  [/\bset\s+\+e\b/, '`set +e`'],
  [/\bfor\s+\S+\s+in\b|\bfor\s*\(\(/, 'a for loop'],
  [/\bwhile\b|\buntil\b/, 'a while or until loop'],
  [/\bbreak\b/, 'a loop break'],
];

/** The text of the `run:` of a step (one line or a block scalar), '' when the step has none. @param {string[]} step */
function runOf(step) {
  const i = step.findIndex((l) => /^\s*(- )?run:/.test(l));
  if (i < 0) return '';
  const first = step[i].replace(/^\s*(- )?run:\s*/, '');
  if (!/^[|>][+-]?$/.test(first)) return first;
  const indent = step[i].search(/\S/);
  const body = [];
  for (let k = i + 1; k < step.length && step[k].search(/\S/) > indent; k++) body.push(step[k]);
  return body.join('\n');
}

/**
 * The findings of a workflow text (comments are ignored). A step is the lines from one `- ` at the step indent to the next. @param {string} text @param {string} [file]
 * @returns {string[]}
 */
export function retryFindings(text, file = 'x.yml') {
  const lines = text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).filter((l) => l.trim() !== '');
  /** @type {string[]} */ const out = [];
  lines.forEach((l, i) => {
    for (const [re, what] of ANYWHERE) if (re.test(l)) out.push(`line ${i + 1}: ${what}: ${l.trim()}`);
    const m = /^\s*(?:- )?continue-on-error:\s*(.*)$/.exec(l);
    if (m && !/^["']?false["']?$/.test(m[1].trim()) && !Object.keys(ALLOWED_CONTINUE_ON_ERROR).some((k) => k.startsWith(`${file}:`))) out.push(`line ${i + 1}: continue-on-error is not false: ${l.trim()}`);
  });
  /** @type {string[][]} */ const steps = [];
  /** @type {string[] | null} */ let cur = null;
  for (const l of lines) {
    if (/^ {6}- /.test(l)) { cur = [l]; steps.push(cur); } else if (!/^ {7}/.test(l)) cur = null; else if (cur) cur.push(l);
  }
  for (const s of steps) {
    const run = runOf(s);
    if (!TEST_RUN.test(run)) continue;
    for (const [re, what] of SHELL) if (re.test(run)) out.push(`test step ${s[0].trim()}: ${what}`);
    if (s.some((l) => /^\s*(- )?if:.*\bfailure\(\)/.test(l))) out.push(`test step ${s[0].trim()}: runs tests under if: failure()`);
  }
  return out;
}

test('no workflow retries a test: every .github/workflows/*.yml is clean', () => {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.includes('ci.yml'));
  for (const f of files) assert.deepEqual(retryFindings(readFileSync(path.join(dir, f), 'utf8'), f), [], f);
  assert.deepEqual(ALLOWED_CONTINUE_ON_ERROR, {}, 'a use of continue-on-error needs a reviewed row with a reason');
});

test('the finder is not blind: every mutant workflow with a retry or a swallowed test failure is caught', () => {
  const head = 'jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n';
  const step = (/** @type {string} */ run) => `${head}      - name: tests\n        run: ${run}\n`;
  const rows = /** @type {Array<[string, string]>} */ ([
    ['nick-fields/retry', `${head}      - uses: nick-fields/retry@v3\n        with:\n          command: node --test x\n`],
    ['retry flag', step('node --test --retries=2 x')],
    ['maxRetries', step('npx jest --maxRetries 3')],
    ['rerun-failed', step('node --test --rerun-failed x')],
    ['gh run rerun', step('gh run rerun ${{ github.run_id }} --failed')],
    ['max_attempts', `${head}      - uses: some/action@v1\n        with:\n          max_attempts: 3\n`],
    ['attempt_limit', `${head}      - uses: some/action@v1\n        with:\n          attempt_limit: 3\n`],
    ['continue-on-error on a test step', `${head}      - name: tests\n        continue-on-error: true\n        run: node --test x\n`],
    ['continue-on-error quoted', `${head}      - name: tests\n        continue-on-error: "true"\n        run: node --test x\n`],
    ['continue-on-error expression', `${head}      - name: tests\n        continue-on-error: \${{ matrix.experimental }}\n        run: node --test x\n`],
    ['continue-on-error on a durations step', `${head}      - run: node tests/ci/test-durations-ci.mjs leg -- x\n        continue-on-error: true\n`],
    ['continue-on-error on the job', `jobs:\n  t:\n    continue-on-error: true\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test x\n`],
    ['|| true', step('node --test x || true')],
    ['x || x', step('node --test x || node --test x')],
    ['; true', step('node --test x; true')],
    ['set +e', `${head}      - name: tests\n        run: |\n          set +e\n          node --test x\n`],
    ['for loop with break', `${head}      - name: tests\n        run: |\n          for i in 1 2 3; do\n            node --test x && break\n          done\n`],
    ['until', `${head}      - name: tests\n        run: |\n          until node --test x; do echo again; done\n`],
    ['while !', step('while ! node --test x; do :; done')],
    ['a rerun step after failure()', `${head}      - name: tests\n        run: node --test x\n      - name: again\n        if: failure()\n        run: node --test x\n`],
  ]);
  for (const [name, text] of rows) assert.ok(retryFindings(text).length > 0, name);
  assert.ok(rows.length >= 20);
});

test('what is allowed stays allowed: fail-fast false, comments about retry, shell logic in a step that runs no test, continue-on-error false, retention-days', () => {
  const ok = 'jobs:\n  t:\n    strategy:\n      fail-fast: false\n    steps:\n      # never a retry: no nick-fields/retry here, no --retries\n      - run: node --test x\n      - name: prepare\n        run: for f in a b; do echo $f; done || true\n      - name: upload\n        continue-on-error: false\n        uses: actions/upload-artifact@v4\n        with:\n          retention-days: 14\n';
  assert.deepEqual(retryFindings(ok), []);
});
