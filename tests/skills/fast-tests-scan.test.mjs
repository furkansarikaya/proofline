// @ts-check
// Issue 265 package C (A276): the scan for real waits (AC-6), the REVIEW_TESTS finding kinds and their validators (AC-7), and the fixture of AC-9.
// Nothing here waits, reads a clock or touches the network: the scan reads tiny text files in a per-test temp folder, the validators read JSON, and the fixture's own
// selfcheck takes an injected runner.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { flatten, loadEcosystems } from '../../control-plane/agents/ecosystems.mjs';
import { applyAllowlist, parseAllowlist, reportJson, scanRules, scanText } from '../../control-plane/agents/scripts/core/waitscan.mjs';
import { checkFast, checkPlanExceptions } from '../../skills/test-trust/scripts/validate-findings.mjs';
import { computeGate } from '../../skills/test-trust/scripts/gate.mjs';
import { testExceptionProblems } from '../../skills/plan-contract/scripts/validate-plan.mjs';
import { tmp } from '../lib/harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const core = path.join(root, 'control-plane/agents/scripts/proofline-core.mjs');
const rows = flatten(loadEcosystems(path.join(root, 'control-plane/agents/ecosystems.json')));
const rules = scanRules(rows);
const hits = (/** @type {string} */ file, /** @type {string} */ text, /** @type {string[]} */ kinds = ['wait']) => scanText(file, text, rules, kinds).map((c) => `${c.line}:${c.pattern}`);

test('the rules come from the data of every ecosystem and nothing else', () => {
  assert.deepEqual(rules.map((r) => r.id), ['cargo', 'dart', 'dotnet', 'go', 'jvm', 'npm', 'php', 'python', 'ruby', 'swift']);
  assert.ok(rules.every((r) => r.files.length > 0 && r.wait.length > 0 && r.clock_read.length > 0));
});

test('each ecosystem family: its sleep calls are candidates in its own files only', () => {
  assert.deepEqual(hits('a.test.js', 'await new Promise((r) => setTimeout(r, 5));\nclearTimeout(x);\nsetInterval(f, 1)'), ['1:setTimeout', '3:setInterval']);
  assert.deepEqual(hits('test_a.py', 'time.sleep(1)\nawait asyncio.sleep(2)\nsleep(3)'), ['1:time.sleep', '2:asyncio.sleep']);
  assert.deepEqual(hits('a_test.go', 'time.Sleep(time.Second)\n<-time.After(d)\ntime.AfterFunc(d, f)'), ['1:time.Sleep', '2:time.After']);
  assert.deepEqual(hits('A.java', 'Thread.sleep(10);'), ['1:Thread.sleep']);
  assert.deepEqual(hits('A.cs', 'await Task.Delay(10); Thread.Sleep(5);'), ['1:Task.Delay', '1:Thread.Sleep']);
  assert.deepEqual(hits('a_spec.rb', 'sleep 1\nusleep 2'), ['1:sleep']);
  assert.deepEqual(hits('lib.rs', 'std::thread::sleep(d); thread::sleep(d);'), ['1:std::thread::sleep', '1:thread::sleep']);
  assert.deepEqual(hits('a.test.js', 'sleep(1)'), [], 'a Ruby name is not a wait in a JS file');
  assert.deepEqual(hits('notes.txt', 'setTimeout'), [], 'a file no ecosystem claims is not scanned');
});

test('a clock read is its own kind; both kinds by default; a name in a string is still a candidate (the reviewer clears it)', () => {
  assert.deepEqual(hits('a.test.js', 'const t = Date.now();\nconst s = "setTimeout";', ['clock_read']), ['1:Date.now']);
  assert.deepEqual(scanText('a.test.js', 'const t = Date.now();\nconst s = "setTimeout";', rules).map((c) => `${c.line}:${c.kind}`), ['1:clock_read', '2:wait']);
  assert.deepEqual(hits('a.test.js', 'new   Date(2020, 1, 1)', ['clock_read']), ['1:new Date(']);
});

test('adding an ecosystem is data only: a made-up ecosystem row set is scanned with the same code', () => {
  const extra = [...rows, ['zigx', 'fast_tests.files', '*.zigx'], ['zigx', 'fast_tests.sleep', 'std.time.sleep'], ['zigx', 'fast_tests.clock_reads', 'std.time.now']];
  const r = scanRules(extra);
  assert.deepEqual(scanText('t.zigx', 'std.time.sleep(5);\nstd.time.now();', r, ['wait']).map((c) => `${c.line}:${c.source}`), ['1:zigx']);
  assert.deepEqual(scanText('t.zigx', 'std.time.sleep(5);', rules), [], 'without the rows the file is not claimed');
});

test('the allowlist needs a written reason; a listed candidate moves to allowed with it; a stale entry is reported', () => {
  const bad = parseAllowlist('# c\n\ntests/a.test.js\tsetTimeout\t\ntests/b.js\tsetTimeout\tshort\nonly two\tfields\n');
  assert.equal(bad.errors.length, 3);
  assert.match(bad.errors[0], /line 3: tests\/a\.test\.js setTimeout has no written reason/);
  const ok = parseAllowlist('tests/a.test.js\tsetTimeout\tthe test awaits a real socket close\ntests/gone/*\t*\tleft over from a removed folder\n');
  assert.deepEqual(ok.errors, []);
  const cands = scanText('tests/a.test.js', 'setTimeout(f, 1); Date.now();', rules);
  const r = applyAllowlist(cands, ok.entries);
  assert.deepEqual(r.open.map((c) => c.pattern), ['Date.now']);
  assert.equal(r.allowed[0].reason, 'the test awaits a real socket close');
  assert.deepEqual(r.unused.map((e) => e.glob), ['tests/gone/*']);
});

test('the report is deterministic: equal input, equal bytes, sorted; the JSON has a fixed key order', () => {
  const text = 'Date.now();\nsetTimeout(f, 1);\nsetTimeout(g, 2);';
  const a = scanText('tests/b.test.js', text, rules).concat(scanText('tests/a.test.js', text, rules));
  const rep = { scanned: ['tests/b.test.js', 'tests/a.test.js'], skipped: [], candidates: a.sort((x, y) => (x.file < y.file ? -1 : 1)), allowed: [], unused: [] };
  assert.equal(reportJson(rep), reportJson(structuredClone(rep)));
  const j = JSON.parse(reportJson(rep));
  assert.deepEqual(Object.keys(j), ['version', 'summary', 'candidates', 'allowed', 'unused_allowlist_entries', 'skipped']);
  assert.deepEqual(Object.keys(j.candidates[0]), ['file', 'line', 'kind', 'pattern', 'source', 'text']);
});

/** @param {string[]} args @param {string} cwd */
const cli = (args, cwd) => spawnSync(process.execPath, [core, 'cli', 'test-scan', ...args], { cwd, encoding: 'utf8', input: '' });

test('cli test-scan over a directory: exit 1 with candidates, 0 when the allowlist covers them, 2 on a bad allowlist or a path outside the root', () => {
  const d = tmp();
  mkdirSync(path.join(d, 'tests/sub'), { recursive: true });
  mkdirSync(path.join(d, 'node_modules/x'), { recursive: true });
  writeFileSync(path.join(d, 'tests/b.test.js'), 'setTimeout(f, 1);\n');
  writeFileSync(path.join(d, 'tests/sub/a.test.js'), 'setInterval(f, 1);\n');
  writeFileSync(path.join(d, 'node_modules/x/c.test.js'), 'setTimeout(f, 1);\n');
  const r = cli(['tests'], d);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.stdout.split('\n').filter((l) => l.startsWith('candidate:')).map((l) => l.split(' | ')[0]), ['candidate: tests/b.test.js:1 wait setTimeout', 'candidate: tests/sub/a.test.js:1 wait setInterval']);
  assert.equal(cli(['tests'], d).stdout, r.stdout, 'the same bytes twice');
  assert.equal(cli(['.'], d).stdout.includes('node_modules'), false, 'pruned folders are not walked');
  writeFileSync(path.join(d, 'allow.tsv'), 'tests/*\t*\tlegacy tests, listed for issue 266 to fix\n');
  const ok = cli(['--allowlist', 'allow.tsv', '--json', 'tests'], d);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).allowed.length, 2);
  writeFileSync(path.join(d, 'bad.tsv'), 'tests/*\t*\t\n');
  assert.equal(cli(['--allowlist', 'bad.tsv', 'tests'], d).status, 2);
  assert.equal(cli(['..'], path.join(d, 'tests')).status, 2, 'a path outside the root is refused');
  assert.equal(cli([], d).status, 2);
});

// ---- AC-7: the finding kinds and their validators ------------------------------------------------------------------------------------------

const F = (/** @type {Record<string, unknown>} */ o) => ({ id: 'F001', kind: 'real_wait', verdict: 'confirmed', test: { file: 't.js', name: 'x' }, evidence: [], source_commit: null, ...o });
const C = { file: 't.js', line: 2, pattern: 'setTimeout' };

test('a confirmed real wait, clock read, over-budget or unmeasured test blocks the gate; cleared and slow do not', () => {
  for (const kind of ['real_wait', 'clock_not_injected', 'over_budget', 'not_measured']) assert.deepEqual(computeGate([F({ kind })]), { result: 'FAIL', failing: ['F001'] }, kind);
  assert.equal(computeGate([F({ verdict: 'cleared' }), F({ id: 'F002', kind: 'slow' })]).result, 'PASS');
});

test('an untraced candidate stays a confirmed finding; only a false positive with a reason or a plan line clears it', () => {
  const v = (/** @type {Record<string, unknown>} */ o) => checkFast({ findings: [F(o)] });
  assert.deepEqual(v({ observed: { candidate: C, outcome: 'untraced' } }), []);
  assert.match(v({ verdict: 'cleared', observed: { candidate: C, outcome: 'untraced' } })[0], /untraced candidate stays a confirmed finding/);
  assert.match(v({ observed: { candidate: C, outcome: 'traced' } })[0], /needs "trace"/);
  assert.match(v({ verdict: 'cleared', observed: { candidate: C, outcome: 'false_positive' } })[0], /needs "reason"/);
  assert.deepEqual(v({ verdict: 'cleared', observed: { candidate: C, outcome: 'false_positive', reason: 'the name is inside a string' } }), []);
  assert.match(v({ verdict: 'cleared', observed: { candidate: C, outcome: 'plan_justified' } })[0], /needs "plan_exception"/);
  assert.match(v({ kind: 'clock_not_injected', verdict: 'cleared', observed: { candidate: C, outcome: 'plan_justified', plan_exception: '- wait: x -- y' } })[0], /real_wait only/);
});

test('over_budget: the measured duration must exceed the budget, and only a plan line justifies it', () => {
  const v = (/** @type {Record<string, unknown>} */ o) => checkFast({ findings: [F({ kind: 'over_budget', ...o })] });
  assert.deepEqual(v({ observed: { measured_ms: 3500, budget_ms: 200, budget_source: 'plan', outcome: 'over' } }), []);
  assert.match(v({ observed: { measured_ms: 100, budget_ms: 200, budget_source: 'plan', outcome: 'over' } })[0], /not above budget_ms/);
  assert.match(v({ verdict: 'cleared', observed: { measured_ms: 3500, budget_ms: 200, budget_source: 'plan', outcome: 'over' } })[0], /does not match verdict/);
});

test('with the plan: a quoted plan_exception must be a line of ## Test exceptions of the matching kind', () => {
  const plan = '## Tests\n\n- regression: `t.js`\n\n## Test exceptions\n\n- wait: `t.js` -- a real signal is awaited, no clock can fake it\n';
  const f = (/** @type {string} */ e, kind = 'real_wait') => ({ findings: [F({ kind, verdict: 'cleared', observed: { candidate: C, outcome: 'plan_justified', plan_exception: e } })] });
  assert.deepEqual(checkPlanExceptions(f('- wait: `t.js` -- a real signal is awaited, no clock can fake it'), plan), []);
  assert.match(checkPlanExceptions(f('- wait: `t.js` -- invented after the freeze, not in the plan'), plan)[0], /is not a "- wait: \.\.\." line of PLAN/);
  assert.match(checkPlanExceptions(f('- wait: `t.js` -- a real signal is awaited, no clock can fake it', 'over_budget'), plan)[0], /"- budget: \.\.\."/);
});

test('plan-contract: ## Test exceptions lines need wait|budget, a target and a reason of 20 or more characters', () => {
  assert.deepEqual(testExceptionProblems(['- wait: `tests/a.js` -- a real child process signal is awaited here', '- budget: "slow one" — a real database migration runs in this test', '']), []);
  assert.equal(testExceptionProblems(['- wait: `tests/a.js` -- too short']).length, 1);
  assert.equal(testExceptionProblems(['- sleep: `tests/a.js` -- a real child process signal is awaited here']).length, 1);
  assert.equal(testExceptionProblems(['wait without a dash and no reason']).length, 1);
});

// ---- AC-9: the fixture ------------------------------------------------------------------------------------------------------------------------

test('the fast-tests fixture builds and its selfcheck proves the four cases, twice with the same result', () => {
  const d = tmp();
  const target = path.join(d, 'ft');
  const fx = path.join(root, 'fixtures/fast-tests');
  assert.equal(spawnSync(process.execPath, [path.join(fx, 'setup.mjs'), target], { encoding: 'utf8', input: '' }).status, 0);
  const run = () => spawnSync(process.execPath, [path.join(fx, 'selfcheck.mjs'), target], { encoding: 'utf8', input: '' });
  const a = run(); const b = run();
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, 'selfcheck: fast-tests ok\n');
  assert.deepEqual([b.status, b.stdout], [a.status, a.stdout]);
  assert.match(readFileSync(path.join(target, 'sleepy/tests/retry.test.js'), 'utf8'), /setTimeout/);
});
