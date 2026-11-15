// @ts-check
// Issue 266 package 3a (A277), AC-3: CI has no automatic retry of a test. A failing test fails its job, once. This scans EVERY workflow in .github/workflows for the ways a retry or
// a swallowed failure is written. Three layers:
//  (1) anywhere in a workflow (comments are ignored): a retry action, a retry/attempt/rerun word or option (`--retries`, `max_attempts`, `attempt_limit`, `gh run rerun`, ...);
//  (2) `continue-on-error` set to anything but a literal false, on any step or job of any workflow. There is no allowed use today (ALLOWED_CONTINUE_ON_ERROR is empty: a use needs a row with a reason);
//  (3) in a TEST STEP: a shell construct that runs a command again or hides its status (`||`, `; true`, `set +e`, `for ... in`, `while`, `until`, `break`), and a step that runs tests under
//      `if: failure()` (a rerun after a failure). A test step is a step whose `run:` command contains `--test`, `test-durations-ci`, the skill-tests command of ci-steps, `windows-probe`, or a
//      known runner (`npm test`, `jest`, `pytest`, `go test`). Non-test steps may use shell logic freely (the strict no-shell-logic check polices them).
// Package P3b hardening (review F1-F3): `make test`, `yarn test`, `pnpm test` and the ci-steps `windows-timing` command count as test runs; `exit 0`, a pipe into `cat` or `tee`
// (the status of the last command wins without pipefail) hide the status and are refused in a test step; a test step under any `if:` that mentions failure(), always(),
// cancelled() or success(), and the same test command run again in another step or job whose own `if:` is such a condition, are reruns under other conditions.
// ACCEPTED LIMITS (A277): the finder reads the text of the workflow. A script file that runs the tests (a retry hidden in `sh scripts/x.sh`) and an obfuscated command
// (`node --te""st`, a command built in a variable, `xargs -P` spread over several lines) are not seen; review and the one place that starts tests (tests/ci/test-durations-ci.mjs, pinned in test-durations-ci.test.mjs) are the guard.
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
  [/\buses:\s*['"]?[^\s'"]*(\.github\/workflows\/|\.\/)/, 'a reusable workflow or local action call (its steps are not seen here)'],
  [/^\s*(-\s+)?([\w.'"-]+:\s*)?&[A-Za-z_][\w-]*(\s|$)|^\s*(-\s+)?([\w.'"-]+:\s+)?\*[A-Za-z_][\w-]*\s*$|<<\s*:/, 'a YAML anchor, alias or merge key (a whole step could be repeated unseen)'],
];
const TEST_RUN = /--test\b|test-durations-ci|ci-steps\.mjs\s+(skill|windows)|windows-probe|\bnpm\s+(run\s+)?test\b|\b(yarn|pnpm)\s+(run\s+)?test\b|\bmake\s+(\S+\s+)*test\b|\bjest\b|\bpytest\b|\bgo\s+test\b/;
/** A condition under which a step or job runs when the tests before it failed or whatever happened. */
const RERUN_IF = /\b(failure|always|cancelled|success)\(\)|\.(result|outcome|conclusion)\b|['"](failure|cancelled|skipped|success)['"]/;
/** @type {Array<[RegExp, string]>} */
const SHELL = [
  [/\|\|/, 'an `||` after a test command'],
  [/;\s*(true|:)\b|;\s*:\s*$/, 'a `; true` that hides the status'],
  [/\bset\s+\+e\b/, '`set +e`'],
  [/\bfor\s+\S+\s+in\b|\bfor\s*\(\(/, 'a for loop'],
  [/\bwhile\b|\buntil\b/, 'a while or until loop'],
  [/\bbreak\b/, 'a loop break'],
  [/\bexit\s+0\b/, '`exit 0` that hides the status'],
  [/\|&?\s*(cat|tee|true|:|exit)\b/, 'a pipe into cat, tee, true or exit that hides the status of the tests'],
  [/(?<![&>|<])&(\s|$)/, 'a trailing or lone `&` (background) that hides the status'],
  [/(^|[\n;&|({])\s*(if|elif)\s/, 'an `if` around a test command (no pipefail under bash -e: the status is swallowed)'],
  [/(^|[\n;&|({])\s*!\s/, 'a negated test command'],
  [/\bxargs\b/, 'xargs around a test command'],
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
    const m = /['"]?continue-on-error['"]?\s*:\s*([^,}]*)/.exec(l);   // anywhere in the line: a flow mapping `{ run: x, continue-on-error: true }` too
    if (m && !/^["']?false["']?$/.test(m[1].trim()) && !Object.keys(ALLOWED_CONTINUE_ON_ERROR).some((k) => k.startsWith(`${file}:`))) out.push(`line ${i + 1}: continue-on-error is not false: ${l.trim()}`);
  });
  /** @type {Map<string, string[]>} the normalised test command -> for each place it runs 'cond' (under a rerun condition) or 'plain' */
  const seen = new Map();
  let jobName = '';
  /** @type {Array<{ job: string, step: string[] }>} */ const placed = [];
  /** @type {Map<string, string>} the job-level `if:` of each job */ const jobIfs = new Map();
  for (const l of lines) {
    const j = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (j) jobName = j[1];
    const ji = /^ {4}if:\s*(.*)$/.exec(l);
    if (ji) jobIfs.set(jobName, ji[1]);
    if (/^ {6}- /.test(l)) placed.push({ job: jobName, step: [l] });
    else if (/^ {7}/.test(l) && placed.length > 0 && placed[placed.length - 1].job === jobName) placed[placed.length - 1].step.push(l);
  }
  for (const { job, step: s } of placed) {
    const run = runOf(s);
    if (!TEST_RUN.test(run)) continue;
    for (const [re, what] of SHELL) if (re.test(run)) out.push(`test step ${s[0].trim()}: ${what}`);
    if (s.some((l) => /^\s*(- )?if:.*\bfailure\(\)/.test(l))) out.push(`test step ${s[0].trim()}: runs tests under if: failure()`);
    else if (s.some((l) => /^\s*(- )?if:/.test(l) && RERUN_IF.test(l))) out.push(`test step ${s[0].trim()}: runs tests under an if: that mentions failure(), always(), cancelled() or success()`);
    const norm = run.replace(/\s+/g, ' ').trim();
    const cond = s.some((l) => /^\s*(- )?if:/.test(l) && RERUN_IF.test(l)) || RERUN_IF.test(jobIfs.get(job) ?? '');
    const prev = seen.get(norm) ?? [];
    if (prev.length > 0 && (cond || prev.includes('cond'))) out.push(`test step ${s[0].trim()}: the same test command runs again in job ${job} under a rerun condition (if: failure() and the like)`);
    seen.set(norm, [...prev, cond ? 'cond' : 'plain']);
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
    ['make test', step('make test || true')],
    ['npm test with exit 0', step('npm test; exit 0')],
    ['pipe into cat', step('node --test x | cat')],
    ['pipe into tee then exit 0', step('node --test x | tee log.txt; exit 0')],
    ['pipe into tee', step('node --test x | tee log.txt')],
    ['exit 0 on its own line', `${head}      - name: tests\n        run: |\n          node --test x\n          exit 0\n`],
    ['yarn test loop', step('for i in 1 2; do yarn test && break; done')],
    ['windows-timing swallowed', step('node tests/ci/ci-steps.mjs windows-timing || true')],
    ['ci-steps skill-tests retried', step('node tests/ci/ci-steps.mjs skill-tests || node tests/ci/ci-steps.mjs skill-tests')],
    ['test step under always()', `${head}      - name: tests\n        if: always()\n        run: node --test x\n`],
    ['test step under cancelled()', `${head}      - name: tests\n        if: cancelled() || failure()\n        run: node --test x\n`],
    ['test step under success()', `${head}      - name: tests\n        if: success() && matrix.rerun\n        run: node --test x\n`],
    ['second job reruns the same command after failure', `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test x\n  b:\n    needs: [a]\n    if: failure()\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test x\n`],
    ['second job reruns the same command under always()', `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node tests/ci/test-durations-ci.mjs leg -- x\n  b:\n    needs: [a]\n    if: always()\n    runs-on: ubuntu-latest\n    steps:\n      - run: node tests/ci/test-durations-ci.mjs leg -- x\n`],
    ['rerun gated on needs result failure', `${head}      - name: tests\n        if: needs.a.result == 'failure'\n        run: node --test x\n`],
    ['rerun gated on step outcome', `${head}      - id: t\n        run: node --test x\n      - name: again\n        if: steps.t.outcome == 'failure'\n        run: node --test x\n`],
    ['rerun gated on not success', `${head}      - name: again\n        if: needs.a.result != 'success'\n        run: node --test x\n`],
    ['rerun gated on conclusion', `${head}      - name: again\n        if: steps.t.conclusion == 'failure'\n        run: node --test x\n`],
    ['second job reruns under needs result', `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test x\n  b:\n    needs: [a]\n    if: needs.a.result == 'failure'\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test x\n`],
    ['pipe into true', step('node --test x | true')],
    ['|& cat', step('node --test x |& cat')],
    ['|& tee', step('node --test x |& tee log.txt')],
    ['|& true', step('node --test x |& true')],
    ['trailing ampersand', step('node --test x &')],
    ['ampersand then wait', step('node --test x & wait')],
    ['if around the test', `${head}      - name: tests\n        run: |\n          if node --test x; then echo ok; fi\n`],
    ['if with else', step('if node --test x; then echo ok; else echo again; fi')],
    ['negated test', step('! node --test x')],
    ['xargs', step('echo x | xargs node --test')],
    ['flow-style continue-on-error', `${head}      - { name: t, run: node --test x, continue-on-error: true }\n`],
    ['continue-on-error with a space before the colon', `${head}      - name: t\n        continue-on-error : true\n        run: node --test x\n`],
    ['flow-style continue-on-error in a job', 'jobs:\n  t: { runs-on: ubuntu-latest, continue-on-error: true, steps: [] }\n'],
    ['reusable workflow call, local', 'jobs:\n  t:\n    uses: ./.github/workflows/tests.yml\n'],
    ['reusable workflow call, remote', 'jobs:\n  t:\n    uses: org/repo/.github/workflows/tests.yml@v1\n'],
    ['local composite action', `${head}      - uses: ./.github/actions/tests\n`],
    ['anchor on a step', `${head}      - &t\n        run: node --test x\n      - *t\n`],
    ['alias of a step', `${head}      - run: node --test x\n      - *t\n`],
    ['merge key', `${head}      - name: again\n        <<: *t\n`],
    ['anchor on a mapping value', `${head}      - name: t\n        env: &e\n          A: 1\n        run: node --test x\n`],
    ['a rerun step after failure()', `${head}      - name: tests\n        run: node --test x\n      - name: again\n        if: failure()\n        run: node --test x\n`],
  ]);
  for (const [name, text] of rows) assert.ok(retryFindings(text).length > 0, name);
  assert.ok(rows.length >= 55);
});

test('what is allowed stays allowed: fail-fast false, comments about retry, shell logic in a step that runs no test, continue-on-error false, retention-days', () => {
  const ok = 'jobs:\n  t:\n    strategy:\n      fail-fast: false\n    steps:\n      # never a retry: no nick-fields/retry here, no --retries\n      - run: node --test x\n      - name: prepare\n        run: for f in a b; do echo $f; done || true\n      - name: upload\n        continue-on-error: false\n        uses: actions/upload-artifact@v4\n        with:\n          retention-days: 14\n';
  assert.deepEqual(retryFindings(ok), []);
  for (const ok2 of ['node --test x 2>&1', 'node --test x && echo ok', 'node --test x > out.txt 2>&1', 'node tests/ci/test-durations-ci.mjs "leg a" -- x', 'node --test "tests/**/*.test.mjs"']) {
    assert.deepEqual(retryFindings(`jobs:\n  t:\n    steps:\n      - run: ${ok2}\n`), [], ok2);
  }
  assert.deepEqual(retryFindings("jobs:\n  t:\n    steps:\n      - uses: actions/checkout@v4\n      - name: needs\n        if: needs.changes.outputs.code == 'true'\n        run: node --test x\n"), [], 'an if on an output is not a rerun condition');
  const twoJobs = 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test x\n  b:\n    needs: [a]\n    if: always()\n    runs-on: ubuntu-latest\n    steps:\n      - name: upload\n        run: echo done | cat\n';
  assert.deepEqual(retryFindings(twoJobs), [], 'a job under always() that runs no test, and a pipe into cat outside a test step');
  assert.deepEqual(retryFindings('jobs:\n  a:\n    steps:\n      - run: node --test x\n  b:\n    steps:\n      - run: node --test x\n'), [], 'the same test command in two plain jobs is not a rerun');
});

test('the accepted limits are real: a script file or an obfuscated command is not seen (recorded in A277), the finder does not claim to see them', () => {
  assert.deepEqual(retryFindings('jobs:\n  t:\n    steps:\n      - run: sh scripts/run-tests.sh\n'), []);
  assert.deepEqual(retryFindings('jobs:\n  t:\n    steps:\n      - run: node --te""st x || true\n'), []);
});
