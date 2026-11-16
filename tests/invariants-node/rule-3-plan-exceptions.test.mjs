// @ts-check
// Core invariant 3 for the plan's `## Test exceptions` (A285): a line the LEAD wrote into PLAN.md clears a finding of the tests review only when the USER approved that exact line.
// Interactive run: the user's `scope` approval for the plan (recorded from the prompt hook, consumed by the freeze, named in the ledger row). Night batch: the line is listed, with the
// sha256 of its exact bytes, in the batch summary the user approved. Every attempt below runs against the real agent.sh; a clearing nobody approved leaves the finding blocking
// ("exception not approved: stays blocking"); a legitimate one works as before (A276). No waits, no clock reads.
// Not yet mechanical (said here instead of faked): one user reply that approves a batch and a scope together while exceptions are listed (the shared approve path is covered by A202
// item 31); a findings.json edited between the submit and a real CODE_DONE (the gate re-run is exercised through the skill validator, pe-14, not through a full run to CODE_DONE); a task
// file written by an agent is only as honest as the summary the user reads: the lines are shown there, and the user's "approve batch" is what accepts them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { A, AS, accepted, approveAsUser, must, refused, repo, say, scaffold, tsha } from '../lib/harness.mjs';
import { implemented } from '../core/gates-s4-lib.mjs';
import { AB, batchApprove, coverProject, fakes, summaryOf } from '../core/batch-lib.mjs';

const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
const RUN = '.agents/runs/LC';
const LINE = '- wait: `tests/sleepy.test.js` -- a real child process signal is awaited here, nothing fakes it';
const OTHER = '- wait: `tests/other.test.js` -- a real child process signal is awaited here, nothing fakes it';
const TESTS = '\n## Tests\n\n- AC-1: `impl_test.txt` "lookup returns the stored value"';
const SECTION = (/** @type {string} */ ...ls) => `\n## Test exceptions\n\n${ls.join('\n')}\n`;
const wr = (/** @type {string} */ dir, /** @type {string} */ f, /** @type {string} */ t) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), t); };
const rd = (/** @type {string} */ dir, /** @type {string} */ f) => readFileSync(path.join(dir, f), 'utf8');
const plan = (/** @type {string} */ d) => path.join(d, RUN, 'PLAN.md');
const ledger = (/** @type {string} */ d) => rd(d, `${RUN}/LEDGER.log`);

/** A manual-autonomy run LC with the exceptions in its plan, NOT frozen. @param {string} [section] */
function unfrozen(section = SECTION(LINE)) { return scaffold({ autonomy: 'manual', cls: 'STANDARD', planExtra: section + TESTS }); }
/** Freeze (the qa binding is done by A), IMPLEMENTING, RED, GREEN, IMPLEMENTED. @param {string} d */
function toImplemented(d) { accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze'); must(d, ['handoff', 'LC', 'IMPLEMENTING']); implemented(d); }
/** The tests review of the run: the skill copy, the report, and a findings.json holding a real wait that the reviewer CLEARS with `quote`. @param {string} d @param {string} quote @param {((q: string) => object) | undefined} [make] another finding built from the quote */
function tests(d, quote, make = undefined) {
  mkdirSync(path.join(d, '.agents/skills'), { recursive: true });
  spawnSync('cp', ['-R', path.join(repo, 'skills/test-trust'), path.join(d, '.agents/skills/test-trust')]);
  appendFileSync(path.join(d, '.git/info/exclude'), '.agents/skills/\n');
  const t = `${RUN}/reviews/test-trust/tests`;
  wr(d, `${t}/REPORT.md`, 'tests review of the whole current tree\n');
  const finding = { id: 'F001', kind: 'real_wait', verdict: 'cleared', test: { file: 'tests/sleepy.test.js', name: 'waits for the signal' }, evidence: [], source_commit: null,
    observed: { candidate: { file: 'tests/sleepy.test.js', line: 2, pattern: 'set\x54imeout' }, outcome: 'plan_justified', plan_exception: quote } };
  const used = make === undefined ? finding : make(quote);
  const doc = { mode: 'diff', fingerprint: 'a'.repeat(40), evidence_pruned: true, gate: { result: 'PASS', failing: [] },
    scope: { slug: 'diff', paths: ['.'], commit: 'abc1234', diff: { base: 'abc1234', thresholds: { repeat: 5, mutation_budget: 20, slow_ratio: 3 }, changed_units: ['impl.txt:lookup'], tests: ['lookup returns the stored value'], mutants_run: 1, not_examined: [],
      claims: [{ ac: 'AC-1', test: 'lookup returns the stored value', mutant: 'lookup returns undefined for a stored key without throwing', outcome: 'killed', failure: 'assertion', killed_by: ['lookup returns the stored value'] }] } },
    findings: [used] };
  wr(d, `${t}/findings.json`, `${JSON.stringify(doc, null, 1)}\n`);
}
let agentN = 0;
const submit = (/** @type {string} */ d) => AS(d, 'reviewer', ['submit', 'LC', '--focus', 'tests', '--confidence', 'high', '--agent', `pe${++agentN}`]);
const NOT_APPROVED = /exception not approved: stays blocking/;
/** The findings check passes: the only remaining refusal is the one of this fixture (the gate is not required in the small tier). @param {{ status: number|null, text: string }} r @param {string} what */
const clears = (r, what) => { assert.doesNotMatch(r.text, NOT_APPROVED, `${what}: ${r.text}`); assert.doesNotMatch(r.text, /findings\.json of the tests review is not valid/, `${what}: ${r.text}`); };
/** The clearing is refused and the finding stays blocking; by default it is the approval check that refuses (the validator accepted the quote), `byValidator` when the quote is no plan line at all. @param {{ status: number|null, text: string }} r @param {string} what @param {boolean} [byValidator] */
const blocks = (r, what, byValidator = false) => { refused(r, what, ''); assert.match(r.text, /findings\.json of the tests review is not valid/, `${what}: ${r.text}`); if (!byValidator) assert.match(r.text, NOT_APPROVED, `${what}: ${r.text}`); };

// ---- (a) interactive ------------------------------------------------------------------------------------------------------------------------------

test('pe-1 (a): the lead\'s exception in the plan, frozen with no approval of the user, clears nothing; the freeze says so and the finding stays blocking', () => {
  const d = unfrozen();
  const f = A(d, ['freeze', 'LC'], { bind: true }); accepted(f, 'freeze');
  assert.match(f.text, /has 1 line\(s\) the user has not approved: they clear NO finding/);
  assert.match(ledger(d), / event=test-exceptions [^\n]* detail=sha=[0-9a-f]{64}\n/, 'the row names no approval');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); implemented(d);
  tests(d, LINE);
  const r = submit(d); blocks(r, 'an unapproved exception cleared a finding'); assert.match(r.text, NOT_APPROVED);
});

test('pe-2 (d): the user\'s scope approval, asked before the freeze and shown the line, makes the exception clear the finding as before (A276)', () => {
  const d = unfrozen();
  const q = accepted(A(d, ['request-approval', 'LC', 'scope']), 'request');
  assert.ok(q.out.includes('tests/sleepy.test.js'), `the request does not show the exception line: ${q.out}`);
  say(d, 'approve scope'); accepted(A(d, ['approve', 'LC', 'scope']), 'approve');
  const f = A(d, ['freeze', 'LC'], { bind: true }); accepted(f, 'freeze');
  assert.doesNotMatch(f.text, /has not approved/);
  assert.match(ledger(d), / event=test-exceptions [^\n]* detail=sha=[0-9a-f]{64} approval=\d{3}-scope\.yaml\n/);
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); implemented(d);
  tests(d, LINE);
  clears(submit(d), 'an approved exception');
  // the approved line is the line the finding must quote, byte for byte
  tests(d, `${LINE} `); blocks(submit(d), 'the approved line plus a blank');
});

test('pe-3 (a): the user\'s approval given after an unapproved first freeze is recorded at the next freeze (a change outside the plan text); the request shows the lines it covers', () => {
  const d = unfrozen();
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze');
  const q = accepted(A(d, ['request-approval', 'LC', 'scope']), 'request');
  assert.ok(q.out.includes('frozen without your approval') && q.out.includes('tests/sleepy.test.js'), q.out);
  say(d, 'approve scope'); accepted(A(d, ['approve', 'LC', 'scope']), 'approve');
  // the approval is bound to this PLAN.md; a refreeze that leaves the plan text alone (here the evidence) takes it and records it for the unchanged section
  mkdirSync(path.join(d, RUN, 'amendments'), { recursive: true }); writeFileSync(path.join(d, RUN, 'amendments/001.md'), '# amendment 001: evidence note\n');
  appendFileSync(path.join(d, RUN, 'EVIDENCE.md'), 'one more verified claim\n');
  accepted(A(d, ['refreeze', 'LC', '001.md'], { bind: true }), 'refreeze');
  assert.match(ledger(d), / event=test-exceptions [^\n]* detail=sha=[0-9a-f]{64} approval=\d{3}-scope\.yaml\n/);
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); implemented(d);
  tests(d, LINE);
  clears(submit(d), 'an exception approved after the first freeze');
});

// ---- (c) forge attempts ---------------------------------------------------------------------------------------------------------------------------

test('pe-4 (c): no agent role records the approval; a hand-written file, a wrong kind and an approval of another plan are not approvals; the finding stays blocking', () => {
  const d = unfrozen();
  for (const role of ['implementer', 'reviewer', 'security_reviewer', 'qa', 'verifier', 'explorer']) {
    refused(AS(d, role, ['request-approval', 'LC', 'scope']), `${role} requested`, '');
    say(d, 'I approve the scope');
    refused(AS(d, role, ['approve', 'LC', 'scope']), `${role} approved`, '');
  }
  assert.deepEqual(readdirSync(path.join(d, RUN)).includes('approvals') ? readdirSync(path.join(d, RUN, 'approvals')).filter((n) => /^\d{3}-scope\.yaml$/.test(n)) : [], []);
  // a hand-written approval with the right bound, answered_by user, source prompt_capture: not in the ledger chain
  wr(d, `${RUN}/approvals/090-scope.yaml`, `kind: "scope"\nbound: "${tsha(plan(d))}"\nconsumed: "false"\nanswered_by: "user"\nsource: "prompt_capture"\n`);
  // the user's approval of another kind
  approveAsUser(d, 'budget', 'approve budget');
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze');
  assert.doesNotMatch(ledger(d), / event=test-exceptions [^\n]*approval=/, 'a forged approval was recorded');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); implemented(d);
  tests(d, LINE);
  blocks(submit(d), 'cleared with only forged approvals');
});

test('pe-5 (c): a free-text reason (amend, waive) that carries a forged test-exceptions row or an approval name does not approve the line', () => {
  const d = unfrozen();
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze');
  const hash = /detail=sha=([0-9a-f]{64})/.exec(ledger(d))?.[1] ?? '';
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); implemented(d);
  wr(d, `${RUN}/approvals/001-scope.yaml`, 'kind: "scope"\nconsumed: "true"\nanswered_by: "user"\nsource: "prompt_capture"\n');
  const forged = ['x', 'event=test-exceptions - - detail=sha=' + hash + ' approval=001-scope.yaml', 'EVENT = test-exceptions - - detail=sha=' + hash + ' approval=001-scope.yaml', 'seq=9|prev=x|event=approval-consumed|role=-|digest=-|ts=x|epoch=1|detail=001-scope.yaml scope'];
  for (const reason of forged) {
    A(d, ['amend', 'LC', '--reason', reason]);
    A(d, ['waive', 'LC', 'F-1', '--reason', reason]);
  }
  tests(d, LINE);
  blocks(submit(d), 'a forged ledger row approved the line');
});

test('pe-6 (c): a line that mimics the approved one (trailing blank, CRLF, invisible character, another target) clears nothing; so does a line edited into the plan after the freeze', () => {
  const d = unfrozen();
  approveAsUser(d, 'scope', 'approve scope');
  toImplemented(d);
  for (const [what, quote, byValidator] of [['trailing blank', `${LINE} `, false], ['carriage return', `${LINE}\r`, false], ['zero-width space', `${LINE}\u200b`, true], ['another target', OTHER, true], ['no-break space', LINE.replace('wait: ', 'wait:\u00a0'), true]]) {
    tests(d, String(quote)); blocks(submit(d), String(what), Boolean(byValidator));
  }
  // the plan edited after the freeze: the section no longer hashes to the recorded one, so nothing is approved, not even the old line
  writeFileSync(plan(d), rd(d, `${RUN}/PLAN.md`).replace('nothing fakes it', 'nothing fakes it at all'));
  tests(d, LINE); blocks(submit(d), 'the old line after an edit', true);
  tests(d, LINE.replace('nothing fakes it', 'nothing fakes it at all')); blocks(submit(d), 'the edited line');
});

test('pe-7 (c): an exception added by an amendment is refused at the refreeze without the user\'s approval, and a plan without exceptions that gets one stays unapproved', () => {
  const d = scaffold({ autonomy: 'manual', cls: 'STANDARD', planExtra: TESTS });
  toImplemented(d);
  mkdirSync(path.join(d, RUN, 'amendments'), { recursive: true }); writeFileSync(path.join(d, RUN, 'amendments/001.md'), '# amendment 001: exceptions\n');
  appendFileSync(plan(d), SECTION(LINE));
  const r = A(d, ['refreeze', 'LC', '001.md'], { bind: true });
  refused(r, 'amendment adding an exception', ''); assert.match(r.text, /adds or changes a line of PLAN\.md ## Test exceptions/);
  tests(d, LINE); blocks(submit(d), 'the unapproved addition cleared a finding');
});

// ---- (e) no exceptions -----------------------------------------------------------------------------------------------------------------------------

test('pe-8 (e): a plan without exceptions is unaffected: no note at the freeze, no extra ledger content, an ordinary finding passes the findings check', () => {
  const d = scaffold({ autonomy: 'manual', cls: 'STANDARD', planExtra: TESTS });
  const f = A(d, ['freeze', 'LC'], { bind: true }); accepted(f, 'freeze');
  assert.doesNotMatch(f.text, /Test exceptions/);
  assert.match(ledger(d), / event=test-exceptions [^\n]* detail=sha=\n/);
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); implemented(d);
  tests(d, LINE);
  // the reviewer quotes a line that is in no plan: the validator already refuses it (nothing to approve)
  blocks(submit(d), 'a quote of a line that is in no plan', true);
});

// ---- (b) the night batch ---------------------------------------------------------------------------------------------------------------------------

const TASK_SECTION = `\n## Test exceptions\n\n${LINE}\n`;
/** A batch of LC whose task file declares LINE (or not), planned and approved. @param {string} declared */
function batch(declared) {
  const F = fakes();
  const dir = coverProject('', 'orchestrated no STANDARD manual');
  if (declared !== '') appendFileSync(path.join(dir, '.agents/tasks/LC.md'), declared);
  const p = AB(F, dir, ['batch-plan', 'all']);
  assert.equal(p.status, 0, `batch-plan: ${p.text}`);
  return { F, dir, plan: p };
}
const hashOfLine = sha;

test('pe-9 (b): the pre-flight summary lists every declared exception of every task (task, hash of the exact bytes, escaped line); the approval is bound to that listing', () => {
  const { dir } = batch(TASK_SECTION);
  const s = summaryOf(dir);
  assert.ok(s.includes(`- test exception LC ${hashOfLine(LINE)}: ${LINE}\n`), s);
  const none = batch('');
  assert.ok(!summaryOf(none.dir).includes('Test exceptions declared'), 'no declared exception: no section at all (the summary is the pre-A285 one)');
  assert.ok(!summaryOf(none.dir).includes('test exception '), 'no row');
  // a line with invisible characters is shown escaped, never as it is
  const odd = batch(`\n## Test exceptions\n\n${LINE}\u200b\n- budget: "slow one" -- the runner needs a real database here, nothing else\u00a0measures it\n`);
  assert.match(summaryOf(odd.dir), /\\u\{200b\}/);
  assert.match(summaryOf(odd.dir), /\\u\{a0\}/);
});

test('pe-9c (b): a batch in which no task declares an exception has no section, an appended section by hand breaks the approval, an undeclared plan line clears nothing', () => {
  const { dir } = batchRun('', LINE);
  const s = summaryOf(dir);
  assert.equal(s.split('\n').filter((l) => l.startsWith('## ')).some((l) => l.startsWith('## Test exceptions')), false);
  tests(dir, LINE);
  blocks(submit(dir), 'a plan exception in a batch whose summary lists none');
  // a section appended by hand after the approval: the approval is bound to the old hash
  const sum = path.join(dir, '.agents/local/batch/SUMMARY.md');
  writeFileSync(sum, `${s}\n## Test exceptions declared by the tasks (the approval of this summary accepts exactly these lines, A285)\n\n- test exception LC ${sha(LINE)}: x\n`);
  blocks(submit(dir), 'a section appended by hand');
});

/** A batch whose task declares `declared`, approved or not, and the run LC with `planLine` in its frozen plan, implemented, with the tests review quoting `quote`. @param {string} declared @param {string} planLine @param {boolean} [approve] */
function batchRun(declared, planLine, approve = true) {
  const b = batch(declared);
  if (approve) batchApprove(b.dir);
  appendFileSync(plan(b.dir), SECTION(planLine));
  accepted(A(b.dir, ['freeze', 'LC'], { bind: true }), 'freeze');
  must(b.dir, ['handoff', 'LC', 'IMPLEMENTING']); implemented(b.dir);
  return b;
}

test('pe-10 (b,d): a listed exception, accepted by the batch approval, clears the finding as before; before that approval it clears nothing', () => {
  const { F, dir } = batchRun(TASK_SECTION, LINE, false);
  tests(dir, LINE);
  blocks(submit(dir), 'cleared before the batch was approved');
  batchApprove(dir);
  clears(submit(dir), 'a listed exception under the approved batch');
  assert.doesNotMatch(AB(F, dir, ['batch-status']).text, /exception not approved/);
});

test('pe-11 (b,c): an exception the summary did not list, a changed one and a byte-different mimic of a listed one clear nothing, and the batch reports it', () => {
  // the task declared nothing: the lead\'s plan line is not in the approved summary
  let { F, dir } = batchRun('', LINE);
  tests(dir, LINE);
  blocks(submit(dir), 'an exception that was not shown cleared a finding');
  assert.match(AB(F, dir, ['batch-status']).text, /LC: exception not approved: stays blocking \(1 line\(s\)/);
  // the task declared another line: the lead\'s line differs from the listed one
  ({ F, dir } = batchRun(`\n## Test exceptions\n\n${OTHER}\n`, LINE));
  tests(dir, LINE); blocks(submit(dir), 'a changed exception cleared a finding');
  assert.match(AB(F, dir, ['batch-status']).text, /exception not approved/);
  // the plan carries a mimic of the listed LINE: a trailing blank, a zero-width space, a no-break space
  for (const mimic of [`${LINE} `, `${LINE}\u200b`, LINE.replace('wait: ', 'wait:\u00a0')]) {
    ({ dir } = batchRun(TASK_SECTION, mimic));
    tests(dir, mimic);
    const r = submit(dir);
    refused(r, `mimic ${JSON.stringify(mimic.slice(-2))}`, '');
    assert.match(r.text, /exception not approved|findings\.json of the tests review is not valid/);
  }
});

test('pe-12 (b,c): a stale approval of a previous batch, a summary edited by hand and a task that is not in the batch approve nothing', () => {
  const { F, dir } = batchRun(TASK_SECTION, LINE);
  const sum = path.join(dir, '.agents/local/batch/SUMMARY.md');
  const old = rd(dir, '.agents/local/batch/SUMMARY.md');
  tests(dir, LINE);
  clears(submit(dir), 'the untouched approved summary');
  // the summary edited by hand to list a second line: the approval is bound to the old hash and no longer counts
  writeFileSync(sum, `${old}\n## Test exceptions declared by the tasks (the approval of this summary accepts exactly these lines, A285)\n\n- test exception LC ${sha(LINE)}: x\n`);
  blocks(submit(dir), 'a hand-edited summary');
  writeFileSync(sum, old);
  clears(submit(dir), 'the restored summary');
  // a NEW batch plan (new nonce, new summary, no approval yet): the approval of the previous batch is stale
  const again = AB(F, dir, ['batch-plan', '--replace', 'all']);
  assert.equal(again.status, 0, again.text);
  blocks(submit(dir), 'a stale approval of the previous batch');
  batchApprove(dir);
  clears(submit(dir), 'the new approved batch');
  // the task is not in the batch
  writeFileSync(path.join(dir, '.agents/local/batch/order.tsv'), '');
  blocks(submit(dir), 'a task that is not in the batch');
});

// ---- round 1: every verdict, every kind, the gate re-run, an unreadable file --------------------------------------------------------------------------

const BLINE = '- budget: "slow one" -- the runner needs a real database here, nothing else measures it';
/** An over_budget finding for the test "slow one" that quotes `q`. @param {string} verdict */
const overBudget = (verdict) => (/** @type {string} */ q) => ({ id: 'F001', kind: 'over_budget', verdict, ...(verdict === 'needs_validation' ? { missing: 'not validated' } : {}), test: { file: 'tests/slow.test.js', name: 'slow one' }, evidence: [], source_commit: null,
  observed: { measured_ms: 900, budget_ms: 100, budget_source: 'plan', outcome: verdict === 'confirmed' ? 'over' : 'plan_justified', plan_exception: q } });

test('pe-13 (c): a finding that quotes an unapproved plan line is refused WHATEVER its verdict (needs_validation, cleared, confirmed) and kind; an approved one still clears (budget)', () => {
  const d = unfrozen(SECTION(BLINE));
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); implemented(d);
  for (const v of ['needs_validation', 'cleared', 'confirmed']) { tests(d, BLINE, overBudget(v)); blocks(submit(d), `over_budget ${v} quoting an unapproved line`); }
  const e = unfrozen(SECTION(BLINE));
  approveAsUser(e, 'scope', 'approve scope');
  toImplemented(e);
  tests(e, BLINE, overBudget('cleared')); clears(submit(e), 'an approved budget line');
  // the validator itself: needs_validation is no clearing even for an approved line (it does not block, so the gate would pass)
  tests(e, BLINE, overBudget('needs_validation'));
  const r = submit(e); refused(r, 'needs_validation with plan_justified', ''); assert.match(r.text, /does not match verdict needs_validation/);
});

test('pe-14 (c): the gate re-run (the validator of the skill behind the tests review) fails a findings.json that quotes an unapproved line, however it came to say so', () => {
  const unapproved = unfrozen();
  accepted(A(unapproved, ['freeze', 'LC'], { bind: true }), 'freeze');
  must(unapproved, ['handoff', 'LC', 'IMPLEMENTING']); implemented(unapproved);
  const approvedRun = unfrozen();
  approveAsUser(approvedRun, 'scope', 'approve scope');
  toImplemented(approvedRun);
  /** @param {string} d */
  const rerun = async (d) => {
    const { Context } = await import('../../control-plane/agents/scripts/core/context.mjs');
    const { skillValidator } = await import('../../control-plane/agents/scripts/core/resultutil.mjs');
    const ctx = new Context({ env: { ...process.env }, cwd: d, stdout: { write() {} }, stderr: { write() {} } }, `${d}/.agents/scripts/agent.sh`);
    return skillValidator(ctx, 'LC', 'reviewer', 'tests', 'reviews/test-trust/tests/REPORT.md').text;
  };
  return (async () => {
    tests(approvedRun, LINE);
    assert.match(await rerun(approvedRun), /^PASS /, 'the approved clearing passes the re-run');
    tests(unapproved, LINE); // written by hand after (or instead of) a submit: nothing checked it
    assert.match(await rerun(unapproved), /^FAIL /, 'the unapproved clearing passed the gate re-run');
    tests(unapproved, LINE, overBudget('needs_validation'));
    assert.match(await rerun(unapproved), /^FAIL /);
  })();
});

test('pe-15 (c): fail closed: an unreadable findings.json, or a project without the findings validator, cannot carry an unapproved clearing through submit', () => {
  const d = unfrozen();
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); implemented(d);
  tests(d, LINE);
  rmSync(path.join(d, '.agents/skills/test-trust/scripts/validate-findings.mjs'));
  const r = submit(d); refused(r, 'no validator', ''); assert.match(r.text, NOT_APPROVED);
  tests(d, LINE);
  writeFileSync(path.join(d, RUN, 'reviews/test-trust/tests/findings.json'), '{ "findings": [ ');
  const u = submit(d); refused(u, 'unparseable findings', ''); assert.match(u.text, NOT_APPROVED);
});
