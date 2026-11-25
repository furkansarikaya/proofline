// @ts-check
// A359 (issue 338 C1): the test review loop is bounded by the plan. Pure parts of the plan's `## Test review budget`, the round cap on the real control plane (the gate
// stays failed, the user is asked once, nothing passes), and the approved mutation budget applied by the control plane at handoff.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { A, expectMsg, gateStatus, must, refused, say, scaffold } from '../lib/harness.mjs';
import { accepted, rec, reopened, rerun, stripDuration, warm } from './evidence-repair-lib.mjs';

// the cold build of the project variant is paid here, not inside the first test that uses it
before(() => warm([[]]));
import { mutantNeed, parseReviewBudget } from '../../control-plane/agents/scripts/core/testreviewbudget.mjs';
import { planMutantNeed, reviewBudget } from '../../skills/test-trust/scripts/gate.mjs';

const PLAN = '# Plan\n\n## Tests\n- AC-1: a\n- AC-2: b\n\n## Test review budget\n- rounds: 3\n- minutes: 90\n- units: 6\n- lines: 400\n';

test('the plan field: rounds, minutes and the mutants derived from units and lines, not from the criteria count', () => {
  const b = parseReviewBudget(PLAN);
  assert.deepEqual([b.rounds, b.minutes, b.units, b.lines, b.errors], [3, 90, 6, 400, []]);
  assert.equal(mutantNeed(PLAN, 2), 24, 'units x 4 beats lines / 25 (16) and the 2 criteria');
  assert.equal(mutantNeed('## Tests\n- AC-1: a\n', 1), 1, 'no field: the criteria floor');
  assert.equal(mutantNeed('## Test review budget\n- lines: 1000\n', 2), 40);
  assert.equal(mutantNeed('## Test review budget\n- mutants: 7\n', 2), 7);
  assert.ok(parseReviewBudget('## Test review budget\n- rounds: 0\n- speed: 3\n').errors.length === 2, 'out of range and unknown lines are named');
});

test('the skill script and the control plane read the same plan the same way', () => {
  for (const p of [PLAN, '## Tests\n- AC-1: a\n', '## Test review budget\n- mutants: 7\n- rounds: 2\n']) {
    const acs = new Set([...p.matchAll(/^\s*[-*]\s+(AC-\d+):/gim)].map((x) => x[1])).size;
    assert.equal(planMutantNeed(p), mutantNeed(p, acs));
    const [a, b] = [reviewBudget(p), parseReviewBudget(p)];
    assert.deepEqual([a.rounds, a.minutes, a.mutants, a.units, a.lines], [b.rounds, b.minutes, b.mutants, b.units, b.lines]);
  }
});

const q = (/** @type {string} */ d) => { try { return readdirSync(path.join(d, '.agents/runs/LC/questions')); } catch { return []; } };
const FAILING = ['REVIEW_TESTS-1|blocking|impl_test.txt:1|the plan test fast one has no recorded duration|NOT MEASURED'];

test('the round cap: a failing REVIEW_TESTS at the cap does not pass, stops with one line, and the user is asked once', () => {
  const d = reopened();                                       // round 1 failed, the run is IMPLEMENTING
  const cfg = path.join(d, '.agents/config.yaml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^test_trust:\n/m, 'test_trust:\n  review_rounds: 2\n'));
  accepted(rerun(d), 'repair'); accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED');
  stripDuration(d, 'fast one');
  rec(d, 'REVIEW_TESTS', 'FAIL', FAILING);                    // round 2 fails: the cap of 2 is reached
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(r, 'a fix round after the cap', 'test review cap reached');
  assert.equal(q(d).length, 1, 'one question');
  const text = readFileSync(path.join(d, '.agents/runs/LC/questions', q(d)[0]), 'utf8');
  assert.match(text, /larger cap/); assert.match(text, /accept the residual survivors/); assert.match(text, /SECURITY and SECRETS are never waived/);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'the second attempt', 'test review cap reached');
  assert.equal(q(d).length, 1, 'the same state asks once');
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'the failed gate passed through the cap');
  assert.equal(gateStatus(d, 'REVIEW_TESTS'), 'fail', 'the cap is not a pass');
});

test('under the cap the loop goes on as before', () => {
  const d = reopened();
  accepted(rerun(d), 'repair'); accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED');
  stripDuration(d, 'fast one');
  rec(d, 'REVIEW_TESTS', 'FAIL', FAILING);                    // 2 records, default cap 4
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  assert.equal(q(d).length, 0);
});

test('the budget comes from the units of the plan, not the criteria; the approved budget is applied by the freeze, and the plan field alone raises nothing', () => {
  const planExtra = '\n## Tests\n\n- AC-1: `impl_test.txt` "case 1"\n- AC-2: `impl_test.txt` "case 2"\n\n## Test review budget\n\n- units: 10\n- rounds: 5\n';
  const d = scaffold({ topology: 'standalone', cls: 'STANDARD', autonomy: 'manual', planExtra });
  expectMsg('a freeze for 10 units (40 mutants) over budget 20', 'mutation budget is 20', A(d, ['freeze', 'LC'], { bind: true }));
  assert.ok(!readdirSync(path.join(d, '.agents/runs/LC')).includes('mutation_budget'), 'the plan field raised the budget without the user');
  say(d, 'approve the mutation budget'); must(d, ['approve', 'LC', 'mutation_budget']);
  const fr = A(d, ['freeze', 'LC'], { bind: true });
  assert.equal(fr.status, 0, `the freeze did not apply the approved budget: ${fr.text}`);
  assert.equal(readFileSync(path.join(d, '.agents/runs/LC/mutation_budget'), 'utf8').trim(), '40');
  assert.match(readFileSync(path.join(d, '.agents/runs/LC/LEDGER.log'), 'utf8'), /event=raise-budget .*test_trust\.mutation_budget 40 for this run, approval /);
});
