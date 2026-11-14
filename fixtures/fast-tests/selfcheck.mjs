// Proves the four cases of AC-9 on the fixture built in <dir>. usage: node selfcheck.mjs <built-dir>
// (a) a test that sleeps is reported by the scan and blocked at REVIEW_TESTS; (b) the same test with a fake clock is not reported and passes; (c) a test over its budget is
// reported with its measured duration; (d) a test that fails in one of the two runs stops the run. Nothing waits: the sleepy test is only read, never run, and the double run
// takes an injected runner.
import path from 'node:path';
import { enter, fail, repoRootOf, run } from '../selfcheck-lib.mjs';

const dir = enter();
const root = repoRootOf(import.meta.url);
const core = path.join(root, 'control-plane/agents/scripts/proofline-core.mjs');
const tt = path.join(root, 'skills/test-trust/scripts');
const scan = (/** @type {string[]} */ ...a) => run(process.execPath, [core, 'cli', 'test-scan', '--root', dir, ...a]);

// (a) the scan reports the wait of the sleeping test, the same bytes twice
const a1 = scan('sleepy/tests'); const a2 = scan('sleepy/tests');
if (a1.status !== 1 || !/^candidate: sleepy\/tests\/retry\.test\.js:8 wait setTimeout \|/m.test(a1.out)) fail(`the scan must report the setTimeout of the sleeping test (exit 1): ${a1.text}`);
if (a1.out !== a2.out) fail('the scan output differs between two runs');
// ... and REVIEW_TESTS blocks it: the findings validate and the gate is FAIL; a wrong gate (PASS for a confirmed wait) is refused
const val = (/** @type {string} */ f, /** @type {string[]} */ ...x) => run(process.execPath, [path.join(tt, 'validate-findings.mjs'), path.join(dir, 'findings', f), ...x]);
const gate = (/** @type {string} */ f) => run(process.execPath, [path.join(tt, 'gate.mjs'), 'gate', path.join(dir, 'findings', f)]);
if (val('sleepy.json').status !== 0) fail(`sleepy.json must validate: ${val('sleepy.json').text}`);
if (gate('sleepy.json').status !== 1 || !/^FAIL F001/.test(gate('sleepy.json').out)) fail(`the sleeping test must fail the gate: ${gate('sleepy.json').text}`);
if (val('wrong-gate.json').status !== 1 || !/gate\.result is PASS but the rule computes FAIL/.test(val('wrong-gate.json').text)) fail('a confirmed real wait with gate PASS must be refused');

// (b) the same test with a fake clock: no candidate, gate PASS
const b = scan('fake-clock/tests');
if (b.status !== 0 || !/^test-scan: 0 candidate\(s\)/m.test(b.out)) fail(`the fake-clock test must have no candidate: ${b.text}`);
if (val('fake-clock.json').status !== 0 || gate('fake-clock.json').out.trim() !== 'PASS') fail('the fake-clock test must pass the gate');
// the plan's own exception clears the sleeping test, and only a line of the plan does
const plan = path.join(dir, 'plan/PLAN.md');
if (val('justified.json', '--plan', plan).status !== 0 || gate('justified.json').out.trim() !== 'PASS') fail(`the plan-justified wait must pass: ${val('justified.json', '--plan', plan).text}`);

// (c) a test over its budget is reported with its measured duration, through the real budget maths of the control plane
const tm = await import(path.join(root, 'control-plane/agents/scripts/core/testmeasure.mjs'));
const cfg = await import(path.join(root, 'control-plane/agents/scripts/core/config.mjs'));
const pk = tm.planKinds('## Tests\n\n- AC-1: `t` "retries after the delay" — x (test_kind: unit)\n\n## Test budgets\n\n- unit: test 200 ms; suite 2000 ms\n');
const bc = tm.budgetCheck([{ name: 'retries after the delay', ms: 3500 }], pk.names, new cfg.Config('x', cfg.configLines('')), pk.budgets);
if (!bc.findings.some((x) => /^BUDGET test "retries after the delay" \(unit\) took 3500 ms, over its 200 ms test budget \(plan\)$/.test(x))) fail(`the budget finding must name the test and its duration: ${JSON.stringify(bc.findings)}`);
if (val('over-budget.json').status !== 0 || !/^FAIL F001/.test(gate('over-budget.json').out)) fail('an over-budget test must fail the gate');

// (d) a test that passes in one of two runs and fails in the other stops the run: the loop ends at the first command with a finding and nothing is retried
const results = [{ status: 0, ms: 10 }, { status: 1, ms: 10 }]; const calls = [];
const dr = tm.doubleRun(['test-a', 'test-b'], (c) => { calls.push(c); return results[calls.length - 1] ?? { status: 0, ms: 10 }; }, { ratio: 4, floorMs: 2000 });
if (dr.findings.length !== 1 || !/exited 0 on run 1 and 1 on run 2 of the same commit/.test(dr.findings[0])) fail(`the unstable test must be a STABILITY finding: ${JSON.stringify(dr.findings)}`);
if (calls.join() !== 'test-a,test-a') fail(`the run must stop at the first unstable command, with no retry: ${calls.join()}`);
console.log('selfcheck: fast-tests ok');
