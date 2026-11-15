// @ts-check
// Issue 266 package 3a (A277): the CI duration report. The maths run on recorded reporter output (tests/fixtures/test-durations/) with an injected runner, so nothing waits or
// reads a clock; two smoke tests start the real `node --test` on tiny files in a throwaway folder (a passing one and a failing one: the verdict is node's). The workflow pins read ci.yml.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../../control-plane/agents/scripts/core/testmeasure.mjs';
import { tmp } from '../lib/harness.mjs';
import { analyse, parseEvents } from './test-durations.mjs';
import { budgetOf, main, overBudget, renderSummary, scaleMilli } from './test-durations-ci.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const fx = (/** @type {string} */ n) => readFileSync(path.join(repo, 'tests', 'fixtures', 'test-durations', n), 'utf8');
const ci = readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');
const budgetsJson = JSON.parse(readFileSync(path.join(import.meta.dirname, 'test-budgets.json'), 'utf8'));
/** @param {string} name */
const job = (name) => (new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|^  #|(?![\\s\\S]))`, 'm').exec(ci) ?? [])[1] ?? '';

test('budgetOf: the built-in A275 numbers are the fallback, a dir entry sets the kind (longest prefix wins) and may override a number, the scale multiplies and rounds up', () => {
  assert.deepEqual(budgetOf({}, 'tests/x/a.test.mjs'), { kind: 'unit', test: 2000, suite: 30000 });
  const b = { dirs: { 'tests/core': { kind: 'integration' }, 'tests/core/special': { kind: 'e2e', test_ms: 5000 } }, kinds: { integration: { suite_ms: 99999 } } };
  assert.deepEqual(budgetOf(b, 'tests/core/a.test.mjs'), { kind: 'integration', test: 10000, suite: 99999 });
  assert.deepEqual(budgetOf(b, 'tests/core/special/a.test.mjs'), { kind: 'e2e', test: 5000, suite: 600000 });
  assert.equal(budgetOf(b, 'tests/corex/a.test.mjs').kind, 'unit', 'a prefix is a path prefix, not a text prefix');
  assert.deepEqual(budgetOf({ timeouts_scale: 1.5 }, 'a'), { kind: 'unit', test: 3000, suite: 45000 });
  assert.equal(scaleMilli({ timeouts_scale: 20 }), 1000, 'out of range is 1, as in the control plane');
  assert.equal(scaleMilli({ timeouts_scale: '0.5' }), 500);
  assert.equal(budgetOf({ dirs: { t: { kind: 'bogus', test_ms: -4 } }, default_kind: 'bogus' }, 't/x').test, DEFAULTS.unit.test_ms, 'bad data falls back to the defaults');
});

test('test-budgets.json: report-only (enforce false until P3b), the kinds are the A275 defaults, every dir names a known kind', () => {
  assert.equal(budgetsJson.enforce, false);
  for (const k of ['unit', 'integration', 'e2e']) assert.deepEqual(budgetsJson.kinds[k], DEFAULTS[/** @type {'unit'} */ (k)], k);
  for (const [d, v] of Object.entries(budgetsJson.dirs)) { assert.ok(existsSync(path.join(repo, d)), d); assert.ok(['unit', 'integration', 'e2e'].includes(/** @type {any} */ (v).kind), d); }
});

test('overBudget: the worst of the runs counts, tests and files over the limit are named in a fixed order', () => {
  const ev = parseEvents(fx('run1.jsonl'));
  const tight = { default_kind: 'unit', kinds: { unit: { test_ms: 1000, suite_ms: 1000 } } };
  const o = overBudget(tight, [{ events: ev }]);
  assert.ok(o.tests.length > 0 && o.files.length > 0);
  for (const t of o.tests) assert.ok(t.ms > t.limit && t.limit === 1000);
  assert.deepEqual(o.tests.map((t) => `${t.file}\0${t.name}`), o.tests.map((t) => `${t.file}\0${t.name}`).sort());
  assert.deepEqual(overBudget({ kinds: { unit: { test_ms: 1e9, suite_ms: 1e9 } } }, [{ events: ev }]), { tests: [], files: [] });
  const both = overBudget(tight, [{ events: ev }, { events: parseEvents(fx('run2.jsonl')) }]);
  assert.ok(both.tests.some((t) => t.name.endsWith('jittery') && t.ms === 2600), 'the slower of the two runs');
});

/** @param {string[]} argv @param {{ status?: number[], budgets?: any, env?: Record<string, string> }} o */
function drive(argv, o) {
  const dir = tmp('dur-ci-');
  /** @type {string[]} */ const out = [];
  /** @type {Record<string, string>} */ const files = {};
  const outs = [fx('run1.jsonl'), fx('run2.jsonl')];
  const statuses = [...(o.status ?? [0])];
  const st = main(argv, {
    budgets: o.budgets ?? {}, env: { TEST_DURATIONS_DIR: path.join(dir, 'out'), GITHUB_STEP_SUMMARY: path.join(dir, 'sum.md'), ...o.env }, scratch: () => dir, write: (s) => out.push(s),
    run: (_a, ev) => { files[ev] = /** @type {string} */ (outs.shift()); return statuses.shift() ?? 0; },
    readFile: (p) => files[p] ?? '', writeFile: (p, s) => { files[p] = s; }, append: (p, s) => { files[p] = (files[p] ?? '') + s; },
  });
  return { st, out: out.join(''), json: files[path.join(dir, 'out', 'test-durations-leg-one.json')], summary: files[path.join(dir, 'sum.md')] };
}

test('the verdict is node\'s: a failing run keeps its own status, an exceeded budget in report-only mode changes nothing, and only enforce:true turns a passing run with an exceeded budget into 1', () => {
  const tight = { kinds: { unit: { test_ms: 1000, suite_ms: 1000 } } };
  assert.equal(drive(['leg one', '--', 'x'], { status: [0], budgets: tight }).st, 0);
  assert.equal(drive(['leg one', '--', 'x'], { status: [3], budgets: tight }).st, 3);
  assert.equal(drive(['leg one', '--', 'x'], { status: [1], budgets: { ...tight, enforce: true } }).st, 1);
  assert.equal(drive(['leg one', '--', 'x'], { status: [7], budgets: { ...tight, enforce: true } }).st, 7);
  assert.equal(drive(['leg one', '--', 'x'], { status: [0], budgets: { ...tight, enforce: true } }).st, 1);
  assert.equal(drive(['leg one', '--', 'x'], { status: [0], budgets: { enforce: true, kinds: { unit: { test_ms: 1e9, suite_ms: 1e9 } } } }).st, 0);
});

test('a report that cannot be written never changes the verdict: the notice is printed and the status is node\'s', () => {
  for (const st of [0, 4]) {
    let out = '';
    const code = main(['leg', '--', 'x'], { budgets: {}, env: { GITHUB_STEP_SUMMARY: '/s.md' }, scratch: () => tmp('dur-ci-'), write: (s) => { out += s; }, run: () => st, readFile: () => fx('run1.jsonl'), writeFile: () => { throw new Error('disk full'); }, append: () => {} });
    assert.equal(code, st);
    assert.match(out, /the report could not be written \(disk full\); the exit status is node's/);
  }
});

test('the summary and the JSON: slowest tests, per-file totals, grand total and OVER BUDGET lines; the JSON holds every test and file; no host or load figure', () => {
  const r = drive(['leg one', '--', 'x'], { status: [0], budgets: { kinds: { unit: { test_ms: 1000, suite_ms: 1000 } } } });
  assert.match(r.summary, /^### Test durations: leg one\n/);
  assert.match(r.summary, /budgets report-only/);
  assert.match(r.summary, /\| slowest tests \| ms \| file \|/);
  assert.match(r.summary, /\| file \(suite total\) \| tests \| ms \|/);
  assert.match(r.summary, /\ngrand total \d+(\.\d+)? ms\n/);
  assert.match(r.summary, /OVER BUDGET: tests\/b\.test\.mjs :: .* took [\d.]+ ms over 1000/);
  assert.match(r.out, /OVER BUDGET: /, 'also printed to the step log');
  assert.ok(r.summary.split('\n').filter((l) => /^\| .* \| [\d.]+ \| tests\//.test(l)).length <= 10);
  const j = JSON.parse(r.json);
  assert.equal(j.leg, 'leg one'); assert.equal(j.enforce, false); assert.equal(j.node_status, 0);
  assert.equal(j.tests_detail.length, j.tests); assert.ok(j.files.length > 0); assert.ok(j.over_budget.tests.length > 0);
  assert.ok(!/load|hostname/i.test(JSON.stringify(Object.keys(j))));
});

test('twice: the second run is reported, the unstable tests are counted in the summary, and unstable tests never change the status', () => {
  const r = drive(['leg one', '--', 'x'], { status: [0, 0], env: { TEST_DURATIONS_TWICE: 'true' } });
  assert.equal(r.st, 0);
  assert.match(r.summary, /run twice/);
  assert.match(r.summary, /UNSTABLE TESTS: 3\n/);
  assert.match(r.out, /UNSTABLE TESTS: 3/);
  assert.equal(JSON.parse(r.json).runs, 2);
  assert.equal(drive(['leg one', '--', 'x'], { status: [0, 2], env: { TEST_DURATIONS_TWICE: 'true' } }).st, 2, 'a failed second run keeps its status');
  const once = drive(['leg one', '--', 'x'], { status: [0], env: { TEST_DURATIONS_TWICE: 'false' } });
  assert.doesNotMatch(once.summary, /UNSTABLE/);
});

test('usage: a missing leg name, a missing -- or no test arguments are refused with 2 and nothing runs', () => {
  for (const bad of [[], ['--', 'x'], ['leg'], ['leg', '--'], ['a', 'b', '--', 'x'], ['bad;name', '--', 'x']]) {
    let msg = '';
    assert.equal(main(bad, { run: () => assert.fail('no run'), write: (s) => { msg += s; } }), 2, bad.join(' '));
    assert.match(msg, /usage: test-durations-ci\.mjs/);
  }
});

test('smoke, real node --test: the exit status of a passing file is 0 and of a failing file is 1, the report files exist either way, the spec text reaches stdout', () => {
  const d = tmp('dur-ci-smoke-');
  writeFileSync(path.join(d, 'ok.test.mjs'), "import { test } from 'node:test';\ntest('adds', () => {});\n");
  writeFileSync(path.join(d, 'bad.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('breaks', () => { assert.equal(1, 2); });\n");
  for (const [file, want] of /** @type {Array<[string, number]>} */ ([['ok.test.mjs', 0], ['bad.test.mjs', 1]])) {
    const out = path.join(d, `out-${want}`);
    const sum = path.join(d, `sum-${want}.md`);
    const env = { TEST_DURATIONS_DIR: out, GITHUB_STEP_SUMMARY: sum };
    const r = realRun(['smoke', '--', path.join(d, file)], env);
    assert.equal(r.status, want, r.stderr);
    assert.match(r.stdout, want === 0 ? /adds/ : /breaks/);
    const j = JSON.parse(readFileSync(path.join(out, 'test-durations-smoke.json'), 'utf8'));
    assert.equal(j.node_status, want); assert.equal(j.tests, 1);
    assert.match(readFileSync(sum, 'utf8'), /### Test durations: smoke/);
  }
});

/** @param {string[]} args @param {Record<string, string>} env */
function realRun(args, env) {
  const { NODE_TEST_CONTEXT: _c, ...base } = process.env;
  return spawnSync(process.execPath, [path.join(import.meta.dirname, 'test-durations-ci.mjs'), ...args], { encoding: 'utf8', env: { ...base, ...env } });
}

test('renderSummary cells carry no control character, backtick, `<` or `[` from a test name (a fence or link would break the job summary)', () => {
  const a = analyse([{ status: 0, events: parseEvents('{"file":"a.test.mjs","name":"x\\ny|z","nesting":0,"ms":1,"outcome":"pass","suite":false}\n') }], { top: 5, ratio: 4, floorMs: 2000 });
  const t = renderSummary('l', a, { tests: [], files: [] }, false, false);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f]/.test(t));
  assert.match(t, /\| x y z \|/);
  const evil = analyse([{ status: 0, events: parseEvents('{"file":"a`b<c.test.mjs","name":"```\\n<img src=x> [l](http://e)","nesting":0,"ms":1,"outcome":"pass","suite":false}\n') }], { top: 5, ratio: 4, floorMs: 2000 });
  const u = renderSummary('l`<[', evil, { tests: [{ file: 'a`.mjs', name: '`<[x', ms: 5, limit: 1 }], files: [] }, false, false);
  assert.ok(!/[`<[]/.test(u.replace(/^```$/gm, '').replace(/\| --- /g, '')), u);
});

test('ci.yml: every Linux Node test run goes through the duration wrapper (only the Windows leg and the front matter check call node --test directly), the wrapper never has a retry or a continue-on-error', () => {
  const direct = ci.split('\n').filter((l) => /run: .*node --test/.test(l));
  assert.deepEqual(direct.map((l) => l.trim()), ['run: node --test tests/skills/frontmatter.test.mjs', 'run: node --test "tests/hook/*.test.mjs"']);
  for (const n of ['static', 'node-tests', 'hook-node', 'invariants']) {
    assert.match(job(n), /run: node tests\/ci\/(test-durations-ci\.mjs|ci-steps\.mjs skill-tests)/, n);
    assert.match(job(n), /TEST_DURATIONS_TWICE: \$\{\{ inputs\.twice \}\}/, n);
    assert.match(job(n), /uses: actions\/upload-artifact@v4\n\s+with:\n\s+name: test-durations-[^\n]+\n\s+path: \$\{\{ runner\.temp \}\}\/test-durations\/\*\.json\n\s+retention-days: 14\n/, n);
    assert.match(job(n), /- name: upload the duration report[^\n]*\n\s+if: always\(\)/, n);
  }
  assert.ok(!/continue-on-error/.test(ci.replace(/^\s*#.*$/gm, '')));
});

test('ci.yml: the manual run has a boolean input `twice`, default false; the Windows legs are untouched', () => {
  assert.match(ci, /\n {6}twice:\n {8}description: [^\n]*\n {8}required: false\n {8}default: false\n {8}type: boolean\n/);
  assert.ok(!/test-durations/.test(job('hook-windows')) && !/test-durations/.test(job('windows-core')));
});
