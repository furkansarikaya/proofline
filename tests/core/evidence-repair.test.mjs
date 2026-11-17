// @ts-check
// A325: the evidence-only repair of a fix round (`worker-evidence ID GREEN rerun`). Real attempts against the real control plane; the abuse cases are the point. No test waits or
// reads a clock; the "test runner" the control plane re-runs is a fixed script that prints fixed lines (evidence-repair-lib.mjs).
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { matchPlanDurations, parseRunnerDurations } from '../../control-plane/agents/scripts/core/evidencerepair.mjs';
import { A, gateStatus, refused } from '../lib/harness.mjs';
import { accepted, count, gpass, ledger, must, passAllButTests, rec, reopened, rerun, setMode, stripDuration, writeFindings } from './evidence-repair-lib.mjs';

const NOTREE = { source: 'no application/test change since the finding' };
const greens = (/** @type {string} */ d) => readdirSync(path.join(d, '.agents/runs/LC/worker-evidence')).filter((n) => n.startsWith('GREEN-')).length;
const finding = (/** @type {string} */ kind, /** @type {string} */ reason) => ({ findings: [
  { id: 'F001', kind: 'not_measured', verdict: 'confirmed', test: { file: 'impl_test.txt', name: 'fast one' }, observed: { reason: 'no_recorded_duration', subject: 'fast one', detail: 'x' } },
  { id: 'F002', kind, verdict: 'confirmed', test: { file: 'impl_test.txt', name: 'fast one' }, observed: { reason, subject: 'node --test x', detail: 'x' } },
] });

test('parseRunnerDurations reads the line shapes of runners, leaves out what cannot be recorded, and matchPlanDurations prefers the exact name', () => {
  const out = '\u001b[32m✔ first test (12.5ms)\u001b[0m\n  ✓ second test (3 ms)\n--- PASS: TestThird (0.25s)\nok 4 - fourth test\n  ---\n  duration_ms: 7.25\n  ...\n✔ has = sign (1ms)\n✔ has; semi (1ms)\nnot ok 5 - broken\n  duration_ms: 99\n✔ first test (99ms)\n';
  assert.deepEqual(parseRunnerDurations(out), [{ name: 'first test', ms: 12.5 }, { name: 'second test', ms: 3 }, { name: 'TestThird', ms: 250 }, { name: 'fourth test', ms: 7.25 }]);
  const m = matchPlanDurations(['first test', 'third'], parseRunnerDurations(out));
  assert.deepEqual([...m.found.values()].map((e) => e.name), ['first test', 'TestThird']);
  assert.deepEqual(matchPlanDurations(['absent'], parseRunnerDurations(out)).missing, ['absent']);
  assert.deepEqual(matchPlanDurations(['test'], parseRunnerDurations(out)).missing, ['test'], 'two entries contain the name: ambiguous, attributed to none');
  assert.deepEqual([...matchPlanDurations(['first test'], [{ name: 'first test', ms: 1 }, { name: 'first test again', ms: 2 }]).found.values()], [{ name: 'first test', ms: 1 }], 'the exact name wins');
});

test('the repair: an unchanged tree and an evidence finding; the control plane records the durations itself, it is a fix round, and it passes nothing', () => {
  const d = reopened();
  const gatesBefore = count(d, 'gates');
  const r = accepted(rerun(d), 'the repair');
  const name = r.out.match(/(GREEN-\d+)\)/)?.[1];
  assert.match(r.out, /evidence-only repair recorded: LC \(1 GREEN record\(s\): GREEN-\d+\)/);
  const ev = readFileSync(path.join(d, '.agents/runs/LC/worker-evidence', `${name}.yaml`), 'utf8');
  assert.match(ev, /^test_durations: fast one=0\.75$/m, 'the durations are the ones the control plane read from the output');
  assert.match(ev, /^role: "implementer"$/m);
  assert.match(ledger(d), /event=evidence-repair role=implementer .* detail=finding=\d+-REVIEW_TESTS\.yaml patch=[0-9a-f]{64} commands=1 records=GREEN-\d+ tests=fast one$/m);
  assert.equal(count(d, 'gates'), gatesBefore, 'no gate record was written');
  assert.equal(count(d, 'approvals'), 0, 'no approval');
  assert.equal(count(d, 'waivers'), 0, 'no waiver');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED on the unchanged tree after the repair');
  assert.notEqual(gateStatus(d, 'REVIEW_TESTS'), 'pass', 'the repair is no pass');
  assert.notEqual(gateStatus(d, 'REVIEW_TESTS'), 'fail', 'the old failing record does not stand in the way of the re-review');
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE before the reviewer judged the new evidence', 'CODE_DONE blocked');
  gpass(d, 'REVIEW_TESTS'); gpass(d, 'VERIFY');
  accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE after the reviewer passed');
});

test('without the repair the unchanged tree is refused: at IMPLEMENTED (early check) while a plan test has no duration, and as "no tree change" once hand-recorded durations cover every test', () => {
  const d = reopened();
  const early = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(early, 'a plan test without a duration', 'the plan names "fast one" and no recorded GREEN duration matches');
  assert.match(early.text, /worker-evidence LC GREEN rerun/);
  must(d, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: 'command: node .git/er-run.mjs\ntarget: impl.txt,impl_test.txt\ntest_durations: slow one=5.5; fast one=0.75\n' });
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(r, 'hand-recorded durations on an unchanged tree', NOTREE.source);
  assert.match(r.text, /worker-evidence LC GREEN rerun/);
});

test('hand-supplied input on the rerun is refused and nothing is recorded', () => {
  const d = reopened();
  const before = greens(d);
  refused(rerun(d, { input: 'test_durations: fast one=1\n' }), 'a duration of the agent', 'takes no input');
  refused(rerun(d, { input: 'command: node -e 0\ntarget: impl.txt\n' }), 'a command of the agent', 'takes no input');
  assert.doesNotMatch(ledger(d), /event=evidence-repair/);
  assert.equal(greens(d), before);
});

test('only the implementer repairs: the lead, the reviewer, QA, the verifier and the security reviewer are refused', () => {
  const d = reopened();
  for (const role of ['lead', 'reviewer', 'qa', 'verifier', 'security_reviewer']) {
    refused(rerun(d, { role }), `${role} rerun`, /AGENT_ROLE|denied/);
  }
  assert.doesNotMatch(ledger(d), /event=evidence-repair/);
});

test('a changed tree is a normal fix, not a repair: an application file or a test file changed since the review refuses the repair', () => {
  for (const f of ['impl.txt', 'impl_test.txt']) {
    const d = reopened();
    appendFileSync(path.join(d, f), 'changed after the review\n');
    refused(rerun(d), `${f} changed`, 'not the one that was reviewed');
    assert.doesNotMatch(ledger(d), /event=evidence-repair/);
  }
});

test('an unrelated blocking finding keeps the rule: another failing gate (security, correctness, verifier) refuses the repair', () => {
  for (const [what, also, msg] of /** @type {Array<[string, string[], string]>} */ ([
    ['a SECURITY finding on the same content', ['SECURITY'], 'SECURITY has an open finding'],
    ['a correctness finding of REVIEW_RULES', ['REVIEW_RULES'], 'REVIEW_RULES has an open finding'],
    ['a VERIFY finding', ['VERIFY'], 'VERIFY has an open finding'],
  ])) {
    const d = reopened(also);
    refused(rerun(d), what, msg);
    assert.doesNotMatch(ledger(d), /event=evidence-repair/, what);
    must(d, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: 'command: node .git/er-run.mjs\ntarget: impl.txt,impl_test.txt\ntest_durations: slow one=5.5; fast one=0.75\n' });
    refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), `${what}: IMPLEMENTED on the unchanged tree`, NOTREE.source);
  }
});

test('a finding of another class next to the missing duration keeps the rule: a real wait, command_not_double_run, another not_measured reason, an unreadable or empty findings.json', () => {
  for (const [what, doc, msg] of /** @type {Array<[string, unknown, string]>} */ ([
    ['a real wait', finding('real_wait', 'x'), 'not of the evidence class'],
    ['command_not_double_run', finding('not_measured', 'command_not_double_run'), 'not of the evidence class'],
    ['not_double_run', finding('not_measured', 'not_double_run'), 'not of the evidence class'],
    ['an unreadable findings.json', '{', 'cannot be read'],
    ['no confirmed finding', { findings: [] }, 'no confirmed finding'],
  ])) {
    const d = reopened();
    writeFindings(d, typeof doc === 'string' ? null : doc);
    if (typeof doc === 'string') writeFileSync(path.join(d, '.agents/runs/LC/reviews/test-trust/tests/findings.json'), doc);
    refused(rerun(d), what, msg);
    assert.doesNotMatch(ledger(d), /event=evidence-repair/, what);
  }
});

test('the control plane measures and the run must really pass: a failing command, a runner that prints no duration for a plan test, and a missing plan command record nothing', () => {
  let d = reopened();
  setMode(d, 'fail');
  refused(rerun(d), 'a failing run', 'exited 1');
  d = reopened();
  setMode(d, 'nodur');
  const before = greens(d);
  refused(rerun(d), 'no duration printed', 'shows no duration for "fast one"');
  assert.equal(greens(d), before, 'nothing recorded');
  assert.doesNotMatch(ledger(d), /event=evidence-repair/);
});

test('one repair per fix round, and the rounds are bounded: the second repair of a round is refused, and after max_fix_rounds the gate cannot be reopened', () => {
  const d = reopened();
  accepted(rerun(d), 'repair 1');
  refused(rerun(d), 'a second repair in the same round', 'already ran in this fix round');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED');
  // the reviewer fails the same content again (the same missing duration), the lead reopens, the implementer repairs once more
  stripDuration(d, 'fast one');
  rec(d, 'REVIEW_TESTS', 'FAIL', ['REVIEW_TESTS-1|blocking|impl_test.txt:1|the plan test fast one has no recorded duration|NOT MEASURED']);
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  accepted(rerun(d), 'repair 2 (second fix round)');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED 2');
  stripDuration(d, 'fast one');
  rec(d, 'REVIEW_TESTS', 'FAIL', ['REVIEW_TESTS-1|blocking|impl_test.txt:1|the plan test fast one has no recorded duration|NOT MEASURED']);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'a third round', 'fix rounds exhausted');
  assert.equal((ledger(d).match(/event=evidence-repair /g) ?? []).length, 2);
});

test('a repair row serves its own finding only: another gate failing afterwards on the same content still needs a tree change', () => {
  const d = reopened();
  accepted(rerun(d), 'repair');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED');
  gpass(d, 'REVIEW_TESTS');
  rec(d, 'SECURITY', 'FAIL', ['SECURITY-1|blocking|impl.txt:1|an exploitable path|traced: input -> sink']);
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(rerun(d), 'a repair for a security finding', /no failing REVIEW_TESTS record/);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'the old repair row carried over', NOTREE.source);
});

test('IMPLEMENTED refuses a plan-named test with no recorded duration before any reviewer is spent (early check)', () => {
  const d = reopened();
  // a fresh round: strip the duration while the state is IMPLEMENTING, then try to hand off with a changed tree so only the early check is in the way
  appendFileSync(path.join(d, 'impl.txt'), 'impl: a real change\n');
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(r, 'a plan test without a duration', 'the plan names "fast one" and no recorded GREEN duration matches');
  assert.match(r.text, /Back to the implementer: re-run the plan-listed Verification command/);
});

test('the failing record is bound to findings.json: a record with an extra blocking row (a hollow test) that findings.json does not show is not repaired by evidence', () => {
  const d = reopened(['ROW']);
  refused(rerun(d), 'a record with two blocking rows and one confirmed finding', 'carries 2 blocking row(s) and findings.json 1 confirmed finding(s)');
  assert.doesNotMatch(ledger(d), /event=evidence-repair/);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED on the unchanged tree', 'IMPLEMENTED blocked');
});

test('a plan-listed command that changes the tree while it runs records nothing (the tree is read again after the run)', () => {
  const d = reopened();
  setMode(d, 'dirty');
  const before = greens(d);
  refused(rerun(d), 'a command that edits the tree', 'changed the application/test tree while it ran; nothing was recorded');
  assert.equal(greens(d), before);
  assert.doesNotMatch(ledger(d), /event=evidence-repair/);
});

test('only the tests without a duration that no approved measure exception excuses must be shown by the runner: an approved exception excuses one, an unapproved line does not', () => {
  const ok = reopened([], 'approved');
  setMode(ok, 'nodur');   // the runner prints a duration for "slow one" only
  const r = accepted(rerun(ok), 'repair with an approved exception for "fast one"');
  const name = r.out.match(/(GREEN-\d+)\)/)?.[1];
  assert.match(readFileSync(path.join(ok, '.agents/runs/LC/worker-evidence', `${name}.yaml`), 'utf8'), /^test_durations: slow one=5\.5$/m);
  const no = reopened([], 'unapproved');
  setMode(no, 'nodur');
  refused(rerun(no), 'the same runner with an exception nobody approved', 'shows no duration for "fast one"');
  assert.doesNotMatch(ledger(no), /event=evidence-repair/);
});
