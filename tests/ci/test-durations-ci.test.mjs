// @ts-check
// Issue 266 package 3a (A277): the CI duration report. The maths run on recorded reporter output (tests/fixtures/test-durations/) with an injected runner, so nothing waits or
// reads a clock; two smoke tests start the real `node --test` on tiny files in a throwaway folder (a passing one and a failing one: the verdict is node's). The workflow pins read ci.yml.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../../control-plane/agents/scripts/core/testmeasure.mjs';
import { tmp } from '../lib/harness.mjs';
import { FLOOR } from './derive-budgets.mjs';
import { analyse, parseEvents } from './test-durations.mjs';
import { budgetOf, budgetProblems, main, overBudget, overLines, parseStrict, renderSummary, requestedFiles, scaleMilli } from './test-durations-ci.mjs';

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

test('budgetOf: a `files` row for exactly one file overrides the numbers of its dir last, other files are unaffected', () => {
  const b = { dirs: { 'tests/core': { kind: 'integration' } }, files: { 'tests/core/a.test.mjs': { test_ms: 33000 } } };
  assert.deepEqual(budgetOf(b, 'tests/core/a.test.mjs'), { kind: 'integration', test: 33000, suite: 120000 });
  assert.deepEqual(budgetOf(b, 'tests/core/b.test.mjs'), { kind: 'integration', test: 10000, suite: 120000 });
  assert.equal(budgetOf({ ...b, timeouts_scale: 2 }, 'tests/core/a.test.mjs').test, 66000, 'the scale applies to a files row too');
});

test('test-budgets.json: ENFORCED (enforce true), valid, the kinds are the A275 defaults, the dirs are the pinned kinds, every file row exists, is a whole number between the absolute floors and the upper bounds', () => {
  assert.equal(budgetsJson.enforce, true);
  assert.deepEqual(budgetProblems(budgetsJson), []);
  assert.equal(budgetsJson.timeouts_scale, 1, 'CI uses the default scale');
  assert.equal(budgetsJson.default_kind, 'unit');
  for (const k of ['unit', 'integration', 'e2e']) assert.deepEqual(budgetsJson.kinds[k], DEFAULTS[/** @type {'unit'} */ (k)], k);
  assert.deepEqual(budgetsJson.dirs, Object.fromEntries([['tests/bench', 'integration'], ['tests/benchmark', 'integration'], ['tests/ci', 'integration'], ['tests/core', 'integration'], ['tests/e2e', 'integration'],
    ['tests/enforcement', 'integration'], ['tests/generator', 'unit'], ['tests/hook', 'integration'], ['tests/invariants-node', 'integration'], ['tests/lib', 'integration'], ['tests/real-session', 'integration'],
    ['tests/skills', 'unit']].map(([d, kind]) => [d, { kind }])), 'a change of a directory kind is a reviewed change of this pin');
  for (const d of Object.keys(budgetsJson.dirs)) assert.ok(existsSync(path.join(repo, d)), d);
  const rows = Object.entries(budgetsJson.files);
  assert.ok(rows.length > 200, 'the numbers come from CI measurements (tests/ci/derive-budgets.mjs)');
  for (const [f, v] of /** @type {Array<[string, any]>} */ (rows)) {
    assert.ok(existsSync(path.join(repo, f)), f);
    assert.ok(Number.isInteger(v.test_ms) && v.test_ms >= FLOOR.test_ms && v.test_ms <= 300000, `${f} test_ms ${v.test_ms}`);
    assert.ok(Number.isInteger(v.suite_ms) && v.suite_ms >= FLOOR.suite_ms && v.suite_ms <= 900000, `${f} suite_ms ${v.suite_ms}`);
  }
  assert.ok(budgetProblems({ ...budgetsJson, files: { ...budgetsJson.files, 'tests/ci/x.test.mjs': { test_ms: 1e9 } } }).length > 0, 'a row of 10^9 is refused');
});

test('budgetProblems: a budget that would silently fall back to a default is a problem', () => {
  assert.deepEqual(budgetProblems({ enforce: false }), []);
  assert.deepEqual(budgetProblems({ enforce: true, kinds: { unit: { test_ms: 5 } }, dirs: { a: { kind: 'e2e' } }, files: { 'a/x': { suite_ms: 3600000 } }, timeouts_scale: 1.5 }), []);
  for (const bad of [null, [], 'x', {}, { kinds: {} }, { enforce: 'true' }, { enforce: 1 }, { enforce: true, default_kind: 'huge' }, { enforce: true, kinds: { unit: { test_ms: 0 } } }, { enforce: true, kinds: { weird: {} } },
    { enforce: true, dirs: { a: { kind: 'x' } } }, { enforce: true, dirs: [] }, { enforce: true, files: { f: { test_ms: 1.5 } } }, { enforce: true, files: { f: { suite_ms: '9' } } }, { enforce: true, files: { f: 4 } },
    { enforce: true, timeouts_scale: true }, { enforce: true, timeouts_scale: '1' }, { enforce: true, timeouts_scale: -2 }, { enforce: true, timeouts_scale: 0.4 }, { enforce: true, timeouts_scale: 10.5 },
    { enforce: true, files: { f: { test_ms: 1e308 } } }, { enforce: true, files: { f: { test_ms: 9007199254740993 } } }, { enforce: true, kinds: { unit: { suite_ms: 3600001 } } }]) assert.ok(budgetProblems(bad).length > 0, JSON.stringify(bad));
});

test('overBudget: the worst of the runs counts, tests and files over the limit are named in a fixed order', () => {
  const ev = parseEvents(fx('run1.jsonl'));
  const tight = { enforce: false, default_kind: 'unit', kinds: { unit: { test_ms: 1000, suite_ms: 1000 } } };
  const o = overBudget(tight, [{ events: ev }]);
  assert.ok(o.tests.length > 0 && o.files.length > 0);
  for (const t of o.tests) assert.ok(t.ms > t.limit && t.limit === 1000);
  assert.deepEqual(o.tests.map((t) => `${t.file}\0${t.name}`), o.tests.map((t) => `${t.file}\0${t.name}`).sort());
  assert.deepEqual(overBudget({ kinds: { unit: { test_ms: 3600000, suite_ms: 3600000 } } }, [{ events: ev }]), { tests: [], files: [] });
  const both = overBudget(tight, [{ events: ev }, { events: parseEvents(fx('run2.jsonl')) }]);
  assert.ok(both.tests.some((t) => t.name.endsWith('jittery') && t.ms === 2600), 'the slower of the two runs');
});

/** @param {string[]} argv @param {{ status?: number[], budgets?: any, env?: Record<string, string>, events?: Array<string | null>, cwd?: string }} o */
function drive(argv, o) {
  const dir = tmp('dur-ci-');
  /** @type {string[]} */ const out = [];
  /** @type {Record<string, string>} */ const files = {};
  const outs = [...(o.events ?? [fx('run1.jsonl'), fx('run2.jsonl')])];
  const statuses = [...(o.status ?? [0])];
  const st = main(argv, {
    budgets: o.budgets ?? { enforce: false }, env: { TEST_DURATIONS_DIR: path.join(dir, 'out'), GITHUB_STEP_SUMMARY: path.join(dir, 'sum.md'), ...o.env }, write: (s) => out.push(s), cwd: o.cwd ?? dir,
    run: () => ({ status: statuses.shift() ?? 0, events: /** @type {string | null} */ (outs.shift()) }),
    writeFile: (p, s) => { files[p] = s; }, append: (p, s) => { files[p] = (files[p] ?? '') + s; },
  });
  return { st, out: out.join(''), json: files[path.join(dir, 'out', 'test-durations-leg-one.json')], summary: files[path.join(dir, 'sum.md')] };
}

test('the verdict is node\'s: a failing run keeps its own status, an exceeded budget in report-only mode changes nothing, and only enforce:true turns a passing run with an exceeded budget into 1', () => {
  const tight = { enforce: false, kinds: { unit: { test_ms: 1000, suite_ms: 1000 } } };
  assert.equal(drive(['leg one', '--', '--test-name-pattern=.'], { status: [0], budgets: tight }).st, 0);
  assert.equal(drive(['leg one', '--', '--test-name-pattern=.'], { status: [3], budgets: tight }).st, 3);
  assert.equal(drive(['leg one', '--', '--test-name-pattern=.'], { status: [1], budgets: { ...tight, enforce: true } }).st, 1);
  assert.equal(drive(['leg one', '--', '--test-name-pattern=.'], { status: [7], budgets: { ...tight, enforce: true } }).st, 7);
  assert.equal(drive(['leg one', '--', '--test-name-pattern=.'], { status: [0], budgets: { ...tight, enforce: true } }).st, 1);
  assert.equal(drive(['leg one', '--', '--test-name-pattern=.'], { status: [0], budgets: { enforce: true, kinds: { unit: { test_ms: 3600000, suite_ms: 3600000 } } } }).st, 0);
});

test('enforce:true: a passing run with a test over its budget exits 1 and prints the OVER BUDGET lines and the reason; a failing run keeps node\'s status; there is exactly one run, no retry', () => {
  const tight = { enforce: true, kinds: { unit: { test_ms: 1000, suite_ms: 1000 } } };
  const r = drive(['leg one', '--', '--test-name-pattern=.'], { status: [0], budgets: tight });
  assert.equal(r.st, 1);
  assert.match(r.out, /OVER BUDGET: tests\/b\.test\.mjs :: .* took [\d.]+ ms over 1000\n/);
  assert.match(r.out, /OVER BUDGET: tests\/[a-z.]+ \(suite\) took [\d.]+ ms over 1000\n/);
  assert.match(r.out, /over budget\. Fix the slow test; relaxing a budget needs a reason/);
  assert.equal(JSON.parse(r.json).enforce, true);
  assert.match(r.summary, /budgets ENFORCED/);
  let calls = 0;
  const base = { budgets: tight, env: {}, write: () => {}, writeFile: () => {}, append: () => {} };
  const st = main(['leg', '--', '--test-name-pattern=.'], { ...base, run: () => { calls++; return { status: 1, events: fx('run1.jsonl') }; } });
  assert.equal(st, 1);
  assert.equal(calls, 1, 'a failing test is run once');
  assert.equal(main(['leg', '--', '--test-name-pattern=.'], { ...base, run: () => ({ status: 9, events: fx('run1.jsonl') }) }), 9, 'node\'s own status, not 1');
  assert.deepEqual(overLines({ tests: [{ file: 'f', name: 'n', ms: 5, limit: 1 }], files: [{ file: 'f', ms: 6, limit: 2 }] }), ['OVER BUDGET: f :: n took 5.0 ms over 1', 'OVER BUDGET: f (suite) took 6.0 ms over 2']);
});

test('enforce:true fails CLOSED: a stream that cannot be read, is empty, or lacks a requested test file is exit 1 on a passing run, never a silent green', () => {
  const loose = { enforce: true, kinds: { unit: { test_ms: 1e6, suite_ms: 1e6 } } };
  const go = (/** @type {string[]} */ args, /** @type {string | null} */ events, /** @type {any} */ budgets = loose) => {
    let out = '';
    const st = main(['leg', '--', ...args], { budgets, env: {}, write: (s) => { out += s; }, writeFile: () => {}, append: () => {}, cwd: repo, run: () => ({ status: 0, events }) });
    return { st, out };
  };
  assert.match(go(['--test-name-pattern=.'], null).out, /not available; failing closed/);
  assert.equal(go(['--test-name-pattern=.'], null).st, 1);
  assert.equal(go(['--test-name-pattern=.'], null, { ...loose, enforce: false }).st, 0, 'report-only mode is not blocked by it');
  const empty = go(['--test-name-pattern=.'], '');
  assert.equal(empty.st, 1);
  assert.match(empty.out, /event stream is empty/);
  const ev = '{"file":"tests/ci/classify.test.mjs","name":"a","nesting":0,"ms":1,"outcome":"pass","suite":false}\n';
  assert.equal(go(['tests/ci/classify.test.mjs'], ev).st, 0, 'the requested file is in the stream');
  const miss = go(['tests/ci/classify.test.mjs', 'tests/ci/affected.test.mjs'], ev);
  assert.equal(miss.st, 1);
  assert.match(miss.out, /1 requested test file\(s\) have no event.*tests\/ci\/affected\.test\.mjs/);
  assert.equal(go(['tests/ci/*.test.mjs'], ev).st, 1, 'a glob expands to every file of the folder');
  assert.equal(go(['--test-name-pattern=zzz', 'tests/ci/*.test.mjs'], ev).st, 0, 'with a name pattern a file may run no test');
  assert.equal(go(['tests/skills/'], ev).st, 0, 'a directory is node\'s to expand');
  const rig = '{"file":"tests/core/port-t3-rig.mjs","name":"stage","nesting":0,"ms":1,"outcome":"pass","suite":false}\n';
  assert.equal(go(['tests/ci/classify.test.mjs', 'tests/ci/affected.test.mjs'], ev + rig).st, 0, 'files whose tests a helper module registers (the port rig) are covered by the helper\'s events');
  assert.equal(go(['tests/ci/affected.test.mjs'], ev).st, 1, 'a stream of another test file does not cover it');
});

test('requestedFiles: explicit files, globs and ** are expanded; options, directories and name-pattern runs are not listed', () => {
  const r = (/** @type {string[]} */ a) => requestedFiles(a, repo);
  assert.deepEqual(r(['tests/ci/classify.test.mjs', './tests/ci/classify.test.mjs']), ['tests/ci/classify.test.mjs']);
  assert.ok(r(['tests/ci/*.test.mjs']).includes('tests/ci/no-retry.test.mjs'));
  assert.ok(r(['tests/ci/*.test.mjs']).every((f) => /^tests\/ci\/[^/]+\.test\.mjs$/.test(f)));
  assert.ok(r(['tests/**/classify.test.mjs']).includes('tests/ci/classify.test.mjs'));
  assert.deepEqual(r(['--test-name-pattern=a', 'tests/ci/*.test.mjs']), []);
  assert.deepEqual(r(['--other', 'tests/skills/']), []);
  assert.deepEqual(r(['tests/nothing/*.test.mjs']), []);
});

test('parseStrict: a duplicate key in any object is refused, valid JSON parses, bad syntax throws', () => {
  assert.deepEqual(parseStrict('{"a":[1,{"b":"x\\"y"}],"c":{},"d":null}'), { a: [1, { b: 'x"y' }], c: {}, d: null });
  assert.throws(() => parseStrict('{"enforce":true,"enforce":false}'), /duplicate key "enforce"/);
  assert.throws(() => parseStrict('{"kinds":{"unit":{"test_ms":1,"test_ms":2}}}'), /duplicate key "test_ms"/);
  assert.throws(() => parseStrict('{"a":1,'), /JSON|Unexpected/);
});

test('the budgets file fails CLOSED: missing, malformed or invalid is exit 2 with a clear message, and no test is started', () => {
  const dir = tmp('dur-ci-bud-');
  const bad = path.join(dir, 'b.json');
  /** @param {string | null} body */
  const go = (body) => {
    if (body !== null) writeFileSync(bad, body);
    let out = '';
    const st = main(['leg', '--', '--test-name-pattern=.'], { budgetsFile: body === null ? path.join(dir, 'missing.json') : bad, env: {}, write: (s) => { out += s; }, run: () => assert.fail('nothing runs') });
    return { st, out };
  };
  for (const body of [null, '', '{', 'null', '[]', '{}', '{"kinds":{}}', '{"enforce":"yes"}', '{"enforce":true,"enforce":false}', '{"enforce":false,"enforce":true}', '{"enforce":true,"files":{"tests/x":{"test_ms":0}}}',
    '{"enforce":true,"kinds":{"unit":{"suite_ms":1.5}}}', '{"enforce":true,"files":{"f":{"test_ms":1e308}}}', '{"enforce":true,"files":{"f":{"test_ms":9007199254740993}}}', '{"enforce":true,"files":{"f":{"suite_ms":3600001}}}',
    '{"enforce":true,"timeouts_scale":"1"}', '{"enforce":true,"timeouts_scale":-1}', '{"enforce":true,"timeouts_scale":11}', '{"enforce":true,"timeouts_scale":0.1}']) {
    const r = go(body);
    assert.equal(r.st, 2, String(body));
    assert.match(r.out, /budgets file .*fails closed/, String(body));
  }
});

test('a report that cannot be written never changes the verdict: the notice is printed and the status is node\'s', () => {
  for (const st of [0, 4]) {
    let out = '';
    const code = main(['leg', '--', '--test-name-pattern=.'], { budgets: { enforce: false }, env: { GITHUB_STEP_SUMMARY: '/s.md' }, write: (s) => { out += s; }, run: () => ({ status: st, events: fx('run1.jsonl') }), writeFile: () => { throw new Error('disk full'); }, append: () => {} });
    assert.equal(code, st);
    assert.match(out, /the report could not be written \(disk full\); the exit status is node's/);
  }
});

test('the summary and the JSON: slowest tests, per-file totals, grand total and OVER BUDGET lines; the JSON holds every test and file; no host or load figure', () => {
  const r = drive(['leg one', '--', '--test-name-pattern=.'], { status: [0], budgets: { enforce: false, kinds: { unit: { test_ms: 1000, suite_ms: 1000 } } } });
  assert.match(r.summary, /^### Test durations: leg one\n/);
  assert.match(r.summary, /budgets report-only/, 'enforce is not set in this injected budgets object');
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
  const r = drive(['leg one', '--', '--test-name-pattern=.'], { status: [0, 0], env: { TEST_DURATIONS_TWICE: 'true' } });
  assert.equal(r.st, 0);
  assert.match(r.summary, /run twice/);
  assert.match(r.summary, /UNSTABLE TESTS: 3\n/);
  assert.match(r.out, /UNSTABLE TESTS: 3/);
  assert.equal(JSON.parse(r.json).runs, 2);
  assert.equal(drive(['leg one', '--', '--test-name-pattern=.'], { status: [0, 2], env: { TEST_DURATIONS_TWICE: 'true' } }).st, 2, 'a failed second run keeps its status');
  const once = drive(['leg one', '--', '--test-name-pattern=.'], { status: [0], env: { TEST_DURATIONS_TWICE: 'false' } });
  assert.doesNotMatch(once.summary, /UNSTABLE/);
});

test('usage: a missing leg name, a missing -- or no test arguments are refused with 2 and nothing runs', () => {
  for (const bad of [[], ['--', '--test-name-pattern=.'], ['leg'], ['leg', '--'], ['a', 'b', '--', '--test-name-pattern=.'], ['bad;name', '--', '--test-name-pattern=.']]) {
    let msg = '';
    assert.equal(main(bad, { run: () => assert.fail('no run'), write: (s) => { msg += s; } }), 2, bad.join(' '));
    assert.match(msg, /usage: test-durations-ci\.mjs/);
  }
});

test('smoke, real node --test: the exit status of a passing file is 0 and of a failing file is 1, the report files exist either way, the spec text reaches the log', () => {
  const d = tmp('dur-ci-smoke-');
  writeFileSync(path.join(d, 'ok.test.mjs'), "import { test } from 'node:test';\ntest('adds', () => {});\n");
  writeFileSync(path.join(d, 'bad.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('breaks', () => { assert.equal(1, 2); });\n");
  for (const [file, want] of /** @type {Array<[string, number]>} */ ([['ok.test.mjs', 0], ['bad.test.mjs', 1]])) {
    const out = path.join(d, `out-${want}`);
    const sum = path.join(d, `sum-${want}.md`);
    const env = { TEST_DURATIONS_DIR: out, GITHUB_STEP_SUMMARY: sum };
    const r = realRun(['smoke', '--', path.join(d, file)], env);
    assert.equal(r.status, want, r.stderr);
    assert.match(r.stderr, want === 0 ? /adds/ : /breaks/, 'the spec text is the step log (stderr); stdout carries only the wrapper notices');
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
  for (const f of readdirSync(path.join(repo, '.github/workflows')).filter((n) => /\.ya?ml$/.test(n))) {
    assert.ok(!/continue-on-error/.test(readFileSync(path.join(repo, '.github/workflows', f), 'utf8').replace(/^\s*#.*$/gm, '')), `${f} has no continue-on-error at all`);
  }
});

test('ci.yml: the manual run has a boolean input `twice`, default false; the Windows legs are untouched', () => {
  assert.match(ci, /\n {6}twice:\n {8}description: [^\n]*\n {8}required: false\n {8}default: false\n {8}type: boolean\n/);
  assert.ok(!/test-durations/.test(job('hook-windows')) && !/test-durations/.test(job('windows-core')));
});
