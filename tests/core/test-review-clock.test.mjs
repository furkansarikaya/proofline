// @ts-check
// A379 (issue 338 C1, the deferred part of A359): the minutes cap of the tests review loop is enforced by the control plane's clock, and the units are scanned security-relevant
// first. The clock is the `epoch=` of sealed ledger rows: the pure part takes NOW as an argument, the real control plane is moved by backdating the dispatch row of the fixture
// (the ledger re-chained, as a run that started earlier would have written it). No test reads a clock or waits.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { reviewLoopClock, reviewMinutesUsed } from '../../control-plane/agents/scripts/core/testreviewbudget.mjs';
import { summarize } from '../../control-plane/agents/scripts/core/testreviewresults.mjs';
import { securityOrder } from '../../control-plane/agents/scripts/core/testreview.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { A, gateStatus, must, project, refused } from '../lib/harness.mjs';
import { accepted, rec, reopened, rerun, stripDuration, warm } from './evidence-repair-lib.mjs';

before(() => warm([[]]));

const T0 = 1_800_000_000;
/** @param {number} seq @param {string} event @param {string} role @param {string} epoch @param {string} detail */
const row = (seq, event, role, epoch, detail) => ({ seq, event, role, epoch, detail });
const DISPATCH = (/** @type {number} */ seq, /** @type {number} */ e) => row(seq, 'decide', 'lead', String(e), '004-reviewer-tests.decision runtime=claude model=sonnet effort=high signals=');

test('the loop clock: what starts it, what never starts it, and that nothing moves the start later (table)', () => {
  /** @type {Array<[string, ReturnType<typeof row>[], number | null]>} */
  const cases = [
    ['no row: not recorded', [], null],
    ['the tests reviewer dispatch starts it', [DISPATCH(1, T0)], T0],
    ['a reviewer mutant result starts it', [row(1, 'mutant-result', 'reviewer', String(T0), 'key=x id=m1 unit=u result=killed class=base')], T0],
    ['a mutant result of another role is not a start', [row(1, 'mutant-result', 'implementer', String(T0), 'key=x')], null],
    ['the implementer dispatch is not a start', [row(1, 'decide', 'lead', String(T0), '001-implementer.decision runtime=claude')], null],
    ['the rules reviewer dispatch is not a start', [row(1, 'decide', 'lead', String(T0), '002-reviewer-rules.decision runtime=claude')], null],
    ['the small-tier reviewer (REVIEW_SMALL) is not a start', [row(1, 'decide', 'lead', String(T0), '002-reviewer-rules-tests.decision runtime=claude')], null],
    ['a look-alike decision name is not a start', [row(1, 'decide', 'lead', String(T0), '002-reviewer-testsx.decision runtime=claude')], null],
    ['the name inside free text of another event is not a start', [row(1, 'note', 'lead', String(T0), 'see 004-reviewer-tests.decision runtime=claude')], null],
    ['the name later in a decide detail is not a start', [row(1, 'decide', 'lead', String(T0), '003-qa.decision note=004-reviewer-tests.decision')], null],
    ['the earliest start counts: a later dispatch does not move it', [DISPATCH(1, T0), DISPATCH(2, T0 + 5000)], T0],
    ['the earliest by epoch, also out of order', [DISPATCH(1, T0 + 5000), DISPATCH(2, T0)], T0],
    ['a row with a malformed epoch is skipped', [DISPATCH(1, T0), row(2, 'decide', 'lead', '-1', '005-reviewer-tests.decision')], T0],
    ['only a malformed epoch: not recorded', [row(1, 'decide', 'lead', 'x', '005-reviewer-tests.decision')], null],
    ['a reopen restarts the clock', [DISPATCH(1, T0), row(2, 'REOPEN', 'lead', String(T0 + 10), 'gates/009-REOPEN.yaml@h'), DISPATCH(3, T0 + 900)], T0 + 900],
    ['after a reopen without a new dispatch: not recorded', [DISPATCH(1, T0), row(2, 'REOPEN', 'lead', String(T0 + 10), 'gates/009-REOPEN.yaml@h')], null],
  ];
  for (const [name, rows, start] of cases) assert.equal(reviewLoopClock(rows, T0 + 99999).start, start, name);
  assert.equal(reviewLoopClock([DISPATCH(7, T0)], T0 + 60).seq, 7);
  assert.equal(reviewLoopClock([DISPATCH(1, T0 + 100)], T0).seconds, 0, 'a start after NOW counts as no time, never as negative');
});

test('the minutes cap boundary: reached at exactly the cap, not a second before; an unrecorded start never reaches it', () => {
  const at = (/** @type {number} */ s) => reviewMinutesUsed(reviewLoopClock([DISPATCH(1, T0)], T0 + s), 120);
  assert.deepEqual([at(0), at(120 * 60 - 1), at(120 * 60), at(120 * 60 + 1), at(10 ** 7)], [false, false, true, true, true]);
  assert.equal(reviewMinutesUsed(reviewLoopClock([], T0 + 10 ** 7), 1), false, 'not recorded: the round cap alone bounds the loop');
  assert.equal(reviewMinutesUsed(reviewLoopClock([DISPATCH(1, T0)], T0 + 60), 1), true, 'a cap of one minute');
});

test('the summary lists the units of security-relevant files first and marks them', () => {
  const rows = [{ unit: 'alpha', result: 'killed', cls: 'base', key: 'k1' }, { unit: 'zeta', result: 'survived', cls: 'base', key: 'k2' }, { unit: 'beta', result: 'killed', cls: 'base', key: 'k3' }];
  const lines = summarize(rows, new Set(['k2']));
  assert.deepEqual(lines.slice(0, 3).map((l) => l.split(':')[0]), ['unit zeta (security-relevant)', 'unit alpha', 'unit beta']);
  assert.deepEqual(summarize(rows).slice(0, 3).map((l) => l.split(':')[0]), ['unit alpha', 'unit beta', 'unit zeta'], 'no security file: byte order as before');
});

const LEDGER = (/** @type {string} */ d) => path.join(d, '.agents/runs/LC/LEDGER.log');
/** Move the rows that match back by SECONDS and re-chain the ledger (prev = sha256 of the line before), as a run that started that much earlier would have written it. @param {string} d @param {RegExp} which @param {number} seconds */
function backdate(d, which, seconds) {
  const lines = readFileSync(LEDGER(d), 'latin1').replace(/\n+$/, '').split('\n');
  let prev = 'genesis';
  const out = lines.map((l) => {
    let x = which.test(l) ? l.replace(/ epoch=([0-9]+) /, (_, e) => ` epoch=${Number(e) - seconds} `) : l;
    x = x.replace(/^(seq=[0-9]+) prev=\S+ /, `$1 prev=${prev} `);
    prev = createHash('sha256').update(Buffer.from(x, 'latin1')).digest('hex');
    return x;
  });
  writeFileSync(LEDGER(d), Buffer.from(`${out.join('\n')}\n`, 'latin1'));
}
const questions = (/** @type {string} */ d) => { try { return readdirSync(path.join(d, '.agents/runs/LC/questions')); } catch { return []; } };
const FAILING = ['REVIEW_TESTS-1|blocking|impl_test.txt:1|the plan test fast one has no recorded duration|NOT MEASURED'];
const summary = (/** @type {string} */ d) => must(d, ['build-record', 'LC', 'mutant-summary']).out;

/** Round 2 of a failing tests review, with the reviewer dispatch recorded in the ledger by `decide`. @returns {string} */
function roundTwo() {
  const d = reopened();
  assert.match(summary(d), /^TIME: not recorded .*round cap still holds/m, 'no dispatch yet: not recorded, never counted as elapsed');
  accepted(rerun(d), 'repair'); accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED');
  stripDuration(d, 'fast one');
  accepted(A(d, ['decide', 'LC', 'reviewer', '--focus', 'tests', '--agent-path']), 'the tests reviewer dispatch');
  rec(d, 'REVIEW_TESTS', 'FAIL', FAILING);                    // 2 rounds of the default 4
  return d;
}

test('the minutes cap: past it a failing REVIEW_TESTS stops the loop as the round cap does, asks the user once, and passes nothing', () => {
  const d = roundTwo();
  backdate(d, /event=decide .*detail=[0-9]{3}-reviewer-tests\.decision /, 121 * 60);
  assert.match(summary(d), /^TIME: 121 of 120 minutes since the first test review dispatch of this loop .*the minutes cap is used/m);
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(r, 'a fix round after the minutes cap', 'test review cap reached');
  assert.match(r.text, /121 minutes, cap 120 minutes/);
  assert.equal(questions(d).length, 1, 'one question');
  const q = readFileSync(path.join(d, '.agents/runs/LC/questions', questions(d)[0]), 'utf8');
  assert.match(q, /after 121 minutes since the first test review dispatch of this loop \(cap 120 minutes; 2 of 4 rounds\)/);
  assert.match(q, /larger cap \(amend PLAN ## Test review budget minutes/); assert.match(q, /SECURITY and SECRETS are never waived/);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'the second attempt', 'test review cap reached');
  assert.equal(questions(d).length, 1, 'the same state asks once');
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'the failed gate passed through the minutes cap');
  assert.equal(gateStatus(d, 'REVIEW_TESTS'), 'fail', 'the cap is not a pass');
});

test('under the minutes cap, and a minute short of it, the loop goes on', () => {
  const d = roundTwo();
  assert.match(summary(d), /^TIME: 0 of 120 minutes since the first test review dispatch of this loop \(ledger row [0-9]+\)$/m);
  backdate(d, /event=decide .*detail=[0-9]{3}-reviewer-tests\.decision /, 119 * 60);
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  assert.equal(questions(d).length, 0);
});

test('a lower minutes cap in the config is applied; the summary counts the minutes from the control plane only', () => {
  const d = roundTwo();
  const cfg = path.join(d, '.agents/config.yaml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^(\s+)review_minutes: 120$/m, '$1review_minutes: 30'));
  backdate(d, /event=decide .*detail=[0-9]{3}-reviewer-tests\.decision /, 31 * 60);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'past a 30-minute cap', 'test review cap reached');
});

test('an invalid minutes value in the config is the default, never no cap', () => {
  const d = roundTwo();
  const cfg = path.join(d, '.agents/config.yaml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^(\s+)review_minutes: 120$/m, '$1review_minutes: 0'));
  backdate(d, /event=decide .*detail=[0-9]{3}-reviewer-tests\.decision /, 121 * 60);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'a zero cap read as no cap', 'test review cap reached');
});

// PATH only: the Windows resolver finds git through it
/** A context in the project, as the control plane builds it. @param {string} d */
const ctxOf = (d) => new Context({ env: { PATH: process.env.PATH ?? '' }, cwd: d, stdout: { write: () => true }, stderr: { write: () => true }, scriptPath: `${d}/.agents/scripts/agent.sh` }, `${d}/.agents/scripts/agent.sh`);
const PLAN_JS = (/** @type {string} */ f) => `\n## Tests\n\n- AC-1: \`${f}\` "adds" — it adds (test_kind: unit)\n`;

test('the order: security-relevant files first, from the config (review.risky_paths) and the ecosystem data (global.security_paths), then the rest', () => {
  const d = project({ topology: 'orchestrated', scopeNamed: 'src/util.js', scopeExtra: 'AC-1', planExtra: PLAN_JS('src/util.js') });
  const order = securityOrder(ctxOf(d), ['src/util.js', 'src/auth/login.js', 'src/approval.js', 'lib/run-exec.ts', 'docs/readme.js']);
  assert.deepEqual(order, [
    { file: 'lib/run-exec.ts', glob: '**/*exec*.*' }, { file: 'src/approval.js', glob: '**/*approv*.*' }, { file: 'src/auth/login.js', glob: '**/auth/**' },
    { file: 'docs/readme.js', glob: '' }, { file: 'src/util.js', glob: '' },
  ]);
});

test('scan prints the mutation order of the task\'s production files, the security-relevant one marked (text and JSON)', () => {
  const d = project({ topology: 'orchestrated', scopeNamed: 'src/session.js', scopeExtra: 'AC-1', planExtra: PLAN_JS('src/session.js') });
  writeFileSync(path.join(d, 'src/session.js'), 'export const open = (u) => u !== "";\n');
  const r = A(d, ['build-record', 'LC', 'scan'], { role: 'reviewer' });
  assert.match(r.out, /^mutation-order: src\/session\.js \(security-relevant: \*\*\/\*session\*\.\*\)$/m, r.text);
  const j = JSON.parse(A(d, ['build-record', 'LC', 'scan', '--json'], { role: 'reviewer' }).out);
  assert.deepEqual(j.mutation_order, [{ file: 'src/session.js', security_relevant: true, matched: '**/*session*.*' }]);
});
