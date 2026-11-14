// Builds the fast-tests fixture (issue 265 package C, AC-9) in <target-dir>: two tiny projects that differ in one thing, a test that really waits (`sleepy`) and the
// same test with an injected fake clock (`fake-clock`), plus the review findings a REVIEW_TESTS reviewer writes for them (`findings/`) and a plan (`plan/PLAN.md`)
// whose `## Test exceptions` justifies one wait. Plain files: no runner, no network, no install, no git, nothing waits (the sleepy test is never run).
// usage: node setup.mjs <target-dir>
import { Fx, cli } from '../../tests/lib/fixture.mjs';

const SRC = `// retries an operation after a delay; the clock is taken by injection
export function retryAfter(clock, delayMs, op) {
  const due = clock.now() + delayMs;
  return { due, run: () => (clock.now() >= due ? op() : null) };
}
`;
const SLEEPY = `import { test } from "node:test";
import assert from "node:assert/strict";
import { retryAfter } from "../src/retry.js";

test("retries after the delay", async () => {
  const clock = { now: () => Date.now() };
  const r = retryAfter(clock, 500, () => "done");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(r.run(), "done");
});
`;
const FAKE = `import { test } from "node:test";
import assert from "node:assert/strict";
import { retryAfter } from "../src/retry.js";

test("retries after the delay", () => {
  let t = 1000;
  const clock = { now: () => t };
  const r = retryAfter(clock, 500, () => "done");
  assert.equal(r.run(), null);
  t += 500;
  assert.equal(r.run(), "done");
});
`;
const FP = 'a'.repeat(40);
const doc = (/** @type {unknown[]} */ findings, /** @type {'PASS'|'FAIL'} */ result, /** @type {string[]} */ failing, /** @type {string[]} */ tests) => ({
  mode: 'diff', fingerprint: FP, evidence_pruned: true, gate: { result, failing },
  scope: { slug: 'diff', paths: ['tests/retry.test.js'], commit: null, diff: { base: 'b'.repeat(40), thresholds: { repeat: 5, mutation_budget: 20, slow_ratio: 3 }, changed_units: [], tests, mutants_run: 0, not_examined: [] } },
  findings,
});
const cand = { file: 'tests/retry.test.js', line: 8, pattern: 'setTimeout' };
const ev = [{ path: 'evidence/test-scan.txt', command: 'agent.sh build-record FIX-1 scan' }];
const PLAN = `---
scope:
  - path: tests/retry.test.js
    criteria: [AC-1]
---

## Tests

- regression: \`tests/retry.test.js\`

## Test budgets

- unit: test 200 ms; suite 2000 ms

## Test exceptions

- wait: \`tests/retry.test.js\` -- the test awaits a real child process signal that no fake clock can produce
`;

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  for (const [dir, test] of [['sleepy', SLEEPY], ['fake-clock', FAKE]]) {
    f.w(`${dir}/src/retry.js`, SRC);
    f.w(`${dir}/tests/retry.test.js`, test);
  }
  // (a) the sleeping test: the scan reports it, the reviewer traced it, the gate is FAIL
  f.w('findings/sleepy.json', JSON.stringify(doc([{ id: 'F001', kind: 'real_wait', verdict: 'confirmed', test: { file: 'tests/retry.test.js', name: 'retries after the delay' }, evidence: ev, observed: { candidate: cand, outcome: 'traced', trace: 'the test awaits a 600 ms timer before the assertion' }, source_commit: null }], 'FAIL', ['F001'], ['retries after the delay']), null, 2) + '\n');
  // (b) the same test with a fake clock: no candidate, nothing to report, the gate is PASS
  f.w('findings/fake-clock.json', JSON.stringify(doc([], 'PASS', [], ['retries after the delay']), null, 2) + '\n');
  // (c) a test over its budget: the finding carries the measured duration
  f.w('findings/over-budget.json', JSON.stringify(doc([{ id: 'F001', kind: 'over_budget', verdict: 'confirmed', test: { file: 'tests/retry.test.js', name: 'retries after the delay' }, evidence: ev, observed: { measured_ms: 3500, budget_ms: 200, budget_source: 'plan', outcome: 'over' }, source_commit: null }], 'FAIL', ['F001'], ['retries after the delay']), null, 2) + '\n');
  // the sleepy test with the plan's justification: cleared, PASS
  f.w('findings/justified.json', JSON.stringify(doc([{ id: 'F001', kind: 'real_wait', verdict: 'cleared', test: { file: 'tests/retry.test.js', name: 'retries after the delay' }, evidence: ev, observed: { candidate: cand, outcome: 'plan_justified', plan_exception: '- wait: `tests/retry.test.js` -- the test awaits a real child process signal that no fake clock can produce' }, source_commit: null }], 'PASS', [], ['retries after the delay']), null, 2) + '\n');
  // a wrong gate: a confirmed real wait with gate PASS must be refused
  f.w('findings/wrong-gate.json', JSON.stringify(doc([{ id: 'F001', kind: 'real_wait', verdict: 'confirmed', test: { file: 'tests/retry.test.js', name: 'retries after the delay' }, evidence: ev, observed: { candidate: cand, outcome: 'untraced' }, source_commit: null }], 'PASS', [], ['retries after the delay']), null, 2) + '\n');
  f.w('plan/PLAN.md', PLAN);
  console.log(`fixture ready: ${target}`);
}

await cli(import.meta.url, (target) => build(target), { usage: 'node setup.mjs <target-dir>', argc: 1 });
