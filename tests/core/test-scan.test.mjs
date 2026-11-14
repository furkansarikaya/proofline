// @ts-check
// Issue 265 package C (A276): `agent.sh build-record <ID> scan` hands the REVIEW_TESTS reviewer the scan candidates of the files the task changed, the plan's
// `## Test exceptions` and the measurement facts of package B. No test here waits or reads a clock; the files are tiny text, the GREEN durations are fixed strings.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, project } from '../lib/harness.mjs';

const PLAN = '\n## Tests\n\n- AC-1: `impl_test.txt` "retries after the delay" — it retries (test_kind: unit)\n\n## Test budgets\n\n- unit: test 100 ms; suite 1000 ms\n\n## Test exceptions\n\n- wait: `tests/sleepy.test.js` -- a real child process signal is awaited here, no clock can fake it\n';
const SLEEPY = 'test("retries after the delay", async () => {\n  await new Promise((r) => setTimeout(r, 500));\n  const started = Date.now();\n});\n';

/** A run whose scope names tests/sleepy.test.js and src/clock.js, with the files written after the scaffold (so the task changed them). @param {string} text */
function run(text = SLEEPY) {
  const d = project({ topology: 'orchestrated', scopeNamed: 'tests/sleepy.test.js', scopeExtra: 'AC-1', planExtra: PLAN });
  mkdirSync(path.join(d, 'tests'), { recursive: true });
  writeFileSync(path.join(d, 'tests/sleepy.test.js'), text);
  return d;
}

test('scan lists the wait and the clock read of a changed test file with file:line and the pattern, sorted, exit 1', () => {
  const d = run();
  const r = A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.equal(r.status, 1, r.text);
  assert.match(r.out, /^candidate: tests\/sleepy\.test\.js:2 wait setTimeout \| /m);
  assert.match(r.out, /^candidate: tests\/sleepy\.test\.js:3 clock_read Date\.now \| /m);
  assert.ok(r.out.indexOf(':2 wait') < r.out.indexOf(':3 clock_read'), 'sorted by line');
  assert.match(r.out, /^task-test-files: tests\/sleepy\.test\.js$/m);
  assert.match(r.out, /^plan-exception: wait `tests\/sleepy\.test\.js` -- a real child process signal/m);
  assert.equal(A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' }).out, r.out, 'the same bytes twice');
});

test('scan of a test that takes a fake clock lists no candidate and exits 0', () => {
  const d = run('test("retries after the delay", () => {\n  const clock = fakeClock(1000);\n  retry(clock);\n  clock.advance(500);\n});\n');
  const r = A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /^test-scan: 0 candidate\(s\) in 1 scanned file\(s\)$/m);
});

test('scan prints the measurement facts: a run nothing was measured for says NOT MEASURED, and the plan test with no recorded duration is named', () => {
  const d = run();
  const r = A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.match(r.out, /^ {2}test-measure-row: none/m);
  assert.match(r.out, /^ {2}NOT MEASURED: no GREEN command was run twice/m);
  assert.match(r.out, /^ {2}NOT MEASURED: the plan names the test "retries after the delay" and no recorded duration matches it$/m);
});

test('scan --json has the same facts as JSON; a bad argument is a usage error', () => {
  const d = run();
  const r = A(d, ['build-record', 'LC', 'scan', '--json'], { role: 'reviewer' });
  const j = JSON.parse(r.out);
  assert.deepEqual(j.candidates.map((/** @type {any} */ c) => `${c.line}:${c.kind}:${c.pattern}`), ['2:wait:setTimeout', '3:clock_read:Date.now']);
  assert.equal(j.measurement.not_measured, true);
  assert.equal(j.plan_exceptions[0].kind, 'wait');
  assert.equal(A(d, ['build-record', 'LC', 'scan', '--bogus'], { role: 'reviewer' }).status, 2);
  assert.equal(A(d, ['build-record', 'LC', 'show'], { role: 'reviewer' }).status, 3, 'show is untouched: no record yet');
});
