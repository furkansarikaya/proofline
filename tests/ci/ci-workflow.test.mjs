// @ts-check
// The shape of .github/workflows/ci.yml after the end of the CI fast mode and of the self-test shards (issue #176 package F, A246): a pull request runs the
// same jobs a push runs on Linux, nothing reads a fast-mode output, the empty `selftest` job is gone and `checks` waits for every remaining gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
/** @param {string} name */
const job = (name) => (new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|^  #|(?![\\s\\S]))`, 'm').exec(ci) ?? [])[1] ?? '';
const jobNames = [...ci.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)].map((m) => m[1]).filter((n) => !['push', 'pull_request', 'schedule', 'workflow_dispatch', 'contents', 'group'].includes(n));

test('fast mode is gone: no file, no reader, no output, no notice, no base worktree for it', () => {
  for (const f of ['tests/ci/fast-mode.txt', 'tests/ci/fast-mode.mjs', 'tests/ci/fast-mode.test.mjs']) assert.ok(!existsSync(join(repo, f)), `${f} must not exist`);
  assert.ok(!/fast[- ]mode|outputs\.fast|outputs\.notice|FAST MODE|fm-changed|basehas/i.test(ci), 'ci.yml mentions fast mode');
});

test('a pull request runs the fixtures job and the skill tests step like a push: only the documentation classifier skips them', () => {
  assert.match(job('fixtures'), /^    if: needs\.changes\.outputs\.code == 'true'$/m);
  const skill = /- name: skill tests\n([\s\S]*?)run:/.exec(job('static'));
  assert.ok(skill);
  assert.match(skill[1], /if: needs\.changes\.outputs\.code == 'true'\n/);
});

test('the self-test shard job (16 shards of no unit) is gone', () => {
  assert.ok(!jobNames.includes('selftest'));
  assert.ok(!/selftest/.test(ci), 'no step runs or uploads self-test output');
});

test('checks needs every job except the nightly-only measurement hook-windows, and keeps the stable names', () => {
  const needs = /needs: \[([^\]]*)\]/.exec(job('checks'));
  assert.ok(needs);
  const listed = needs[1].split(',').map((s) => s.trim());
  for (const n of ['changes', 'static', 'fixtures', 'visual-browser', 'invariants', 'node-tests', 'hook-node', 'types']) assert.ok(listed.includes(n), n);
  assert.deepEqual(jobNames.filter((n) => !listed.includes(n) && n !== 'checks'), ['hook-windows']);
});

test('A250: the Windows hook leg is a gate of the nightly and manual runs: no continue-on-error, not run on a pull request', () => {
  const j = job('hook-windows');
  assert.ok(j !== '');
  assert.ok(!/continue-on-error/.test(j), 'hook-windows must not be a measurement any more');
  assert.match(j, /github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/);
});

test('node --test gets globs, never a bare directory, in node-tests and types', () => {
  for (const n of ['node-tests', 'types']) assert.ok(!/node --test tests\/[a-z]+\/(\s|$)/m.test(job(n)), n);
});

test('CODEOWNERS puts .github/, tests/ci/ and tests/invariants-node/ under the repository owner', () => {
  const co = readFileSync(join(repo, '.github/CODEOWNERS'), 'utf8');
  assert.match(co, /^\/\.github\/ @furkansarikaya$/m);
  assert.match(co, /^\/tests\/ci\/ @furkansarikaya$/m);
  assert.match(co, /^\/tests\/invariants-node\/ @furkansarikaya$/m);
  assert.ok(!/fast mode/.test(co));
});

// A skipped job counts as passed in `checks`, so a job-level `if:` on a gate silently removes the gate from every pull request. The conditions that are allowed are pinned literally.
const NIGHTLY = "(github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && needs.changes.outputs.code == 'true'";
/** @type {Record<string, string | null>} job -> the one job-level condition it may have (null: none) */
const ALLOWED_IF = {
  changes: null, static: null, 'node-tests': null, 'hook-node': null, types: null, invariants: null,
  fixtures: "needs.changes.outputs.code == 'true'", 'visual-browser': NIGHTLY, 'hook-windows': NIGHTLY, checks: 'always()',
};
/** The problems of a workflow text: a job with a condition it may not have, an unknown job, a step that can never run. @param {string} text @returns {string[]} */
export function ifProblems(text) {
  /** @type {string[]} */ const bad = [];
  const names = [...text.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)].map((m) => m[1]).filter((n) => !['push', 'pull_request', 'schedule', 'workflow_dispatch', 'contents', 'group'].includes(n));
  const body = (/** @type {string} */ n) => (new RegExp(`^  ${n}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|^  #|(?![\\s\\S]))`, 'm').exec(text) ?? [])[1] ?? '';
  for (const n of names) {
    if (!(n in ALLOWED_IF)) { bad.push(`unknown job ${n}`); continue; }
    const ifs = [...body(n).matchAll(/^    if: (.*)$/gm)].map((m) => m[1].trim());
    const want = ALLOWED_IF[n];
    if (want === null ? ifs.length !== 0 : ifs.length !== 1 || ifs[0] !== want) bad.push(`${n}: job-level if ${JSON.stringify(ifs)}, allowed ${JSON.stringify(want)}`);
    if (/^ +if: (false|0|'false')\s*$/m.test(body(n))) bad.push(`${n}: an if that is always false`);
  }
  for (const n of Object.keys(ALLOWED_IF)) if (!names.includes(n)) bad.push(`job ${n} is missing`);
  return bad;
}

test('only fixtures, changes, checks and the nightly-only jobs have a job-level condition, each pinned literally', () => {
  assert.deepEqual(ifProblems(ci), []);
});

test('the pin goes red for each way of skipping a gate on a pull request', () => {
  const add = (/** @type {string} */ job, /** @type {string} */ cond) => ci.replace(new RegExp(`^(  ${job}:\\n)`, 'm'), `$1    if: ${cond}\n`);
  for (const job of ['static', 'node-tests', 'hook-node', 'types', 'invariants']) {
    for (const cond of ['false', "github.event_name != 'pull_request'", "needs.changes.outputs.code == 'true'"]) {
      assert.notDeepEqual(ifProblems(add(job, cond)), [], `${job}: if: ${cond}`);
    }
  }
  const fx = ci.replace("    if: needs.changes.outputs.code == 'true'\n    strategy", "    if: false\n    strategy");
  assert.notEqual(fx, ci); assert.notDeepEqual(ifProblems(fx), [], 'fixtures: if: false');
  assert.notDeepEqual(ifProblems(ci.replace("needs.changes.outputs.code == 'true'\n    strategy", "github.event_name != 'pull_request'\n    strategy")), [], 'fixtures: other condition');
  assert.notDeepEqual(ifProblems(ci.replaceAll(NIGHTLY, "github.event_name != 'pull_request'")), [], 'nightly jobs: other condition');
  assert.notDeepEqual(ifProblems(ci.replace('  checks:\n    if: always()', '  checks:\n    if: false')), [], 'checks');
  assert.notDeepEqual(ifProblems(`${ci}\n  extra:\n    runs-on: ubuntu-latest\n`), [], 'a job nobody pinned');
});
