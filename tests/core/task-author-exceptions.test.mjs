// @ts-check
// A294 (package 2d): the task author may PROPOSE test exceptions in the task file (`## Test exceptions`, the A276 line grammar). Two halves. (1) The task validator: the section is
// optional; when present every non-empty line must be one the batch would list (the validator is compared with core/testreview.mjs `parseException` over a corpus, so the
// two grammars cannot drift). (2) A proposal is only a proposal: against the real agent.sh, the batch summary lists it with the sha256 of its exact line and says it is an agent's
// proposal; the plan's identical line clears a finding only under the approved summary; nothing else does. Real agent.sh, no waits, no clock reads.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, AS, accepted, must, refused, repo, scaffold } from '../lib/harness.mjs';
import { tempDir } from '../lib/tempdir.mjs';
import { implemented } from './gates-s4-lib.mjs';
import { AB, batchApprove, coverProject, fakes, summaryOf } from './batch-lib.mjs';
import { parseException, exceptionLines } from '../../control-plane/agents/scripts/core/testreview.mjs';
import { BATCH_EXC_MAX_LINE, BATCH_EXC_MAX_LINES } from '../../control-plane/agents/scripts/core/exceptionsapproval.mjs';
import { validate, testExceptionErrors, BATCH_LIMITS } from '../../skills/task-author/scripts/validate-task.mjs';

const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
const LINE = '- wait: `tests/sleepy.test.js` -- a real child process signal is awaited here, nothing fakes it';
const OTHER = '- wait: `tests/other.test.js` -- a real child process signal is awaited here, nothing fakes it';
const SECTION = (/** @type {string[]} */ ...ls) => `\n## Test exceptions\n\n${ls.join('\n')}\n`;
const GOOD = `# Task: T-1 — Rate limit login

## Goal
Limit failed logins per account.

## Context
Login lives in the auth module.

## Acceptance criteria
- AC-1: The sixth failed login within 10 minutes returns HTTP 429.

## Out of scope
Password reset flow.

## Constraints
None stated by the user.

## Risks
Shared IPs behind a proxy.

## Suggested class
STANDARD — one component

## Verification commands
- npm test
`;

// ---- (1) the validator ---------------------------------------------------------------------------------------------------------------------

test('ta-1: the section is optional; a well-formed proposal validates, the file is otherwise unchanged', () => {
  assert.equal(validate(GOOD).valid, true, JSON.stringify(validate(GOOD).errors));
  const r = validate(GOOD + SECTION(LINE, '- budget: "slow one" -- the runner needs a real database here, nothing else measures it'));
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
});

test('ta-2: a malformed line is a validation error with a clear message, never silently accepted (kind, separator, target, short reason, long line, blank-only)', () => {
  const bad = ['- sleep: `a.js` -- a real child process signal is awaited here', '- wait: `a.js` - a real child process signal is awaited here', '- wait: -- a real child process signal is awaited here',
    '- wait: `a.js` -- too short', 'wait: `a.js` -- a real child process signal is awaited here, nothing fakes it'.replace('wait:', 'waits'), 'free text about a browser', '   ', `${LINE}${'x'.repeat(4100)}`];
  for (const l of bad) {
    const r = validate(GOOD + SECTION(l));
    assert.equal(r.valid, false, `accepted: ${JSON.stringify(l.slice(0, 40))}`);
    assert.ok(r.errors.some((e) => e.startsWith('section "## Test exceptions"')), r.errors.join('\n'));
  }
  assert.match(validate(GOOD + SECTION(LINE.replace(' -- ', ' — '))).errors.join('\n'), /use `--` as the separator, not an em dash/);
  assert.match(validate(GOOD + SECTION('- wait: `a.js` -- too short')).errors.join('\n'), /expected "- wait\|budget\|measure: .* -- <reason of at least 20 characters>".*the batch would not list this line/);
});

test('ta-3: the validator and core/testreview.mjs parseException agree on every line of a corpus, including the one-byte mimics (the same grammar, not a second one)', () => {
  const corpus = [LINE, OTHER, `${LINE} `, `${LINE}​`, LINE.replace('wait: ', 'wait: '), ` ${LINE}`, `\t${LINE}`, LINE.replace(' -- ', ' — '), LINE.replace(' -- ', ' -- '), LINE.replace(' -- ', ' --'),
    LINE.replace('- wait', '* budget'), '- measure:  "x"   --   exactly twenty chars!!', '- measure: "x" -- exactly nineteen chr', '- wait:', '-wait: a -- ' + 'r'.repeat(25), '+ wait: a -- ' + 'r'.repeat(25),
    `- wait: ${'t'.repeat(4096)} -- ${'r'.repeat(25)}`, '- wait: a  -- b -- ' + 'r'.repeat(25), '- wait: a -- ' + ' '.repeat(30), '- wait: ' + ' '.repeat(30) + ' -- ' + 'r'.repeat(25)];
  for (const l of corpus) {
    const text = GOOD + SECTION(l);
    // the batch reads the task file as bytes (latin1): an em dash is then three characters and no separator
    const batchSees = exceptionLines(Buffer.from(text, 'utf8').toString('latin1')).some((x) => parseException(x) !== null);
    assert.equal(testExceptionErrors(text).length === 0, batchSees, `drift on ${JSON.stringify(l.slice(0, 50))}`);
  }
  // CRLF is the one normalisation the batch applies; the validator applies the same one
  assert.deepEqual(testExceptionErrors(GOOD.replace(/\n/g, '\r\n') + SECTION(LINE).replace(/\n/g, '\r\n')), []);
  // the file as BYTES (latin1) is what the batch reads: a multi-byte character inside the reason counts as its bytes, in both
  const utf = `- wait: \`a.js\` -- ${'ş'.repeat(10)}`;
  assert.equal(testExceptionErrors(GOOD + SECTION(utf)).length === 0, exceptionLines(Buffer.from(GOOD + SECTION(utf), 'utf8').toString('latin1')).every((x) => parseException(x) !== null));
});

test('ta-3b: the validator refuses what the batch would not list: a line over the batch byte limit and more lines than the batch shows, same unit and same constants', () => {
  assert.deepEqual(BATCH_LIMITS, { lines: BATCH_EXC_MAX_LINES, bytes: BATCH_EXC_MAX_LINE });
  const head = '- wait: `a.js` -- ';
  const pad = (/** @type {number} */ bytes, ch = 'r') => head + ch.repeat(bytes - Buffer.byteLength(head));
  const batchLists = (/** @type {string[]} */ ls) => {
    const lines = exceptionLines(Buffer.from(GOOD + SECTION(...ls), 'utf8').toString('latin1')).filter((l) => parseException(l) !== null);
    return lines.length > 0 && lines.length <= BATCH_EXC_MAX_LINES && !lines.some((l) => l.length > BATCH_EXC_MAX_LINE);
  };
  const ok = (/** @type {string[]} */ ls) => testExceptionErrors(GOOD + SECTION(...ls)).length === 0;
  // 1000 / 1001 bytes; multi-byte characters count as bytes (two bytes each), in the batch and in the validator
  const rows = [[pad(1000)], [pad(1001)], [pad(1000, 'ş').slice(0, -1) + 'r'], [head + 'ş'.repeat(490)], [head + 'ş'.repeat(491)]];
  for (const ls of rows) assert.equal(ok(ls), batchLists(ls), `bytes: ${Buffer.byteLength(ls[0])}`);
  assert.equal(ok([pad(1000)]), true); assert.equal(ok([pad(1001)]), false);
  assert.match(testExceptionErrors(GOOD + SECTION(pad(1001))).join('\n'), /the batch would not list it \(limit 1000 bytes per line\)/);
  // 50 / 51 lines
  const many = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => `${head}reason number ${i} of a long list`);
  for (const n of [49, 50, 51]) assert.equal(ok(many(n)), batchLists(many(n)), `lines: ${n}`);
  assert.equal(ok(many(50)), true); assert.equal(ok(many(51)), false);
  assert.match(testExceptionErrors(GOOD + SECTION(...many(51))).join('\n'), /the batch would not list any of them \(limit 50 lines per task\)/);
});

test('ta-4: a line inside an HTML comment is validated too (the batch would list it), and the command line validator exits 1 with the message', () => {
  assert.equal(validate(GOOD + `\n<!--\n## Test exceptions\n\n- sleep: x\n-->\n`).valid, false);
  const T = tempDir('pl-ta-');
  const f = path.join(T, 'T-1-rate-limit-login.md');
  writeFileSync(f, GOOD + SECTION('- wait: `a.js` -- short'));
  const r = spawnSync('node', [path.join(repo, 'skills/task-author/scripts/validate-task.mjs'), f], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: section "## Test exceptions": expected/);
  writeFileSync(f, GOOD + SECTION(LINE));
  assert.equal(spawnSync('node', [path.join(repo, 'skills/task-author/scripts/validate-task.mjs'), f], { encoding: 'utf8' }).status, 0);
});

// ---- (2) a proposal is only a proposal: the batch, end to end --------------------------------------------------------------------------------

const RUN = '.agents/runs/LC';
const wr = (/** @type {string} */ dir, /** @type {string} */ f, /** @type {string} */ t) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), t); };
const planOf = (/** @type {string} */ d) => path.join(d, RUN, 'PLAN.md');
const TESTS = '\n## Tests\n\n- AC-1: `impl_test.txt` "lookup returns the stored value"';
let agentN = 0;
const submit = (/** @type {string} */ d) => AS(d, 'reviewer', ['submit', 'LC', '--focus', 'tests', '--confidence', 'high', '--agent', `ta${++agentN}`]);
const NOT_APPROVED = /exception not approved: stays blocking/;
const clears = (/** @type {{ text: string }} */ r, /** @type {string} */ what) => { assert.doesNotMatch(r.text, NOT_APPROVED, `${what}: ${r.text}`); assert.doesNotMatch(r.text, /findings\.json of the tests review is not valid/, `${what}: ${r.text}`); };
const blocks = (/** @type {any} */ r, /** @type {string} */ what) => { refused(r, what, ''); assert.match(r.text, /findings\.json of the tests review is not valid/, `${what}: ${r.text}`); assert.match(r.text, NOT_APPROVED, `${what}: ${r.text}`); };

/** The tests review of run LC: a real_wait the reviewer clears by quoting `quote`. @param {string} d @param {string} quote */
function tests(d, quote) {
  mkdirSync(path.join(d, '.agents/skills'), { recursive: true });
  spawnSync('cp', ['-R', path.join(repo, 'skills/test-trust'), path.join(d, '.agents/skills/test-trust')]);
  appendFileSync(path.join(d, '.git/info/exclude'), '.agents/skills/\n');
  const t = `${RUN}/reviews/test-trust/tests`;
  wr(d, `${t}/REPORT.md`, 'tests review of the whole current tree\n');
  const finding = { id: 'F001', kind: 'real_wait', verdict: 'cleared', test: { file: 'tests/sleepy.test.js', name: 'waits for the signal' }, evidence: [], source_commit: null,
    observed: { candidate: { file: 'tests/sleepy.test.js', line: 2, pattern: 'set\x54imeout' }, outcome: 'plan_justified', plan_exception: quote } };
  const doc = { mode: 'diff', fingerprint: 'a'.repeat(40), evidence_pruned: true, gate: { result: 'PASS', failing: [] },
    scope: { slug: 'diff', paths: ['.'], commit: 'abc1234', diff: { base: 'abc1234', thresholds: { repeat: 5, mutation_budget: 20, slow_ratio: 3 }, changed_units: ['impl.txt:lookup'], tests: ['lookup returns the stored value'], mutants_run: 1, not_examined: [],
      claims: [{ ac: 'AC-1', test: 'lookup returns the stored value', mutant: 'lookup returns undefined for a stored key without throwing', outcome: 'killed', failure: 'assertion', killed_by: ['lookup returns the stored value'] }] } },
    findings: [finding] };
  wr(d, `${t}/findings.json`, `${JSON.stringify(doc, null, 1)}\n`);
}

/** A batch of LC whose task file carries `proposed` (appended), planned; approved or not. Then the lead's plan carries `planLine`, frozen and implemented. */
function batchRun(/** @type {string} */ proposed, /** @type {string} */ planLine, approve = true) {
  const F = fakes();
  const dir = coverProject('', 'orchestrated no STANDARD manual');
  if (proposed !== '') appendFileSync(path.join(dir, '.agents/tasks/LC.md'), proposed);
  const p = AB(F, dir, ['batch-plan', 'all']);
  assert.equal(p.status, 0, `batch-plan: ${p.text}`);
  if (approve) batchApprove(dir);
  appendFileSync(planOf(dir), SECTION(planLine) + TESTS);
  accepted(A(dir, ['freeze', 'LC'], { bind: true }), 'freeze');
  must(dir, ['handoff', 'LC', 'IMPLEMENTING']); implemented(dir);
  return { F, dir };
}

test('ta-5: the summary lists a proposal with the hash of its exact line and says it is an agent\'s proposal the approval accepts; a batch with none has no such text', () => {
  const { dir } = batchRun(SECTION(LINE), LINE, false);
  const s = summaryOf(dir);
  assert.ok(s.includes(`- test exception LC ${sha(LINE)}: ${LINE}\n`), s);
  assert.match(s, /These lines are PROPOSALS, normally written by the task author \(an agent, not you\)/);
  assert.match(s, /Your approval of this batch accepts exactly the listed lines\./);
  const none = summaryOf(batchRun('', LINE, false).dir);
  assert.ok(!none.includes('PROPOSALS') && !none.includes('Test exceptions declared'), 'a batch without a proposal keeps its old bytes');
});

test('ta-6: a proposal clears nothing without the batch approval; after "approve batch" the plan\'s identical line clears the finding', () => {
  const { dir } = batchRun(SECTION(LINE), LINE, false);
  tests(dir, LINE);
  blocks(submit(dir), 'a proposal with no approval cleared a finding');
  batchApprove(dir);
  clears(submit(dir), 'the proposal under the approved batch');
});

test('ta-7: an approval of a different summary, a hand-edited summary and an approval that is only the agent\'s own call accept nothing', () => {
  const { F, dir } = batchRun(SECTION(LINE), LINE);
  const sum = path.join(dir, '.agents/local/batch/SUMMARY.md');
  const old = readFileSync(sum, 'utf8');
  tests(dir, LINE);
  clears(submit(dir), 'the untouched approved summary');
  writeFileSync(sum, `${old}\n- test exception LC ${sha(OTHER)}: x\n`);
  blocks(submit(dir), 'a hand-edited summary');
  writeFileSync(sum, old);
  const again = AB(F, dir, ['batch-plan', '--replace', 'all']);
  assert.equal(again.status, 0, again.text);
  blocks(submit(dir), 'the approval of the previous summary');
  // an agent role calling approve-pending with no user message behind it records nothing
  AS(dir, 'lead', ['approve-pending']); AS(dir, 'task_author', ['approve-pending']);
  blocks(submit(dir), 'approve-pending called by an agent');
});

test('ta-8: a plan exception nobody proposed still parks (stays blocking, batch-status says so); a different proposed line does not clear it', () => {
  let r = batchRun('', LINE); tests(r.dir, LINE);
  blocks(submit(r.dir), 'an undeclared exception cleared a finding');
  assert.match(AB(r.F, r.dir, ['batch-status']).text, /LC: exception not approved: stays blocking \(1 line\(s\)/);
  r = batchRun(SECTION(OTHER), LINE); tests(r.dir, LINE);
  blocks(submit(r.dir), 'a different line cleared a finding');
});

test('ta-9: a task-file edit AFTER the batch approval changes nothing: the approved summary decides, in both directions', () => {
  let r = batchRun(SECTION(OTHER), LINE);
  appendFileSync(path.join(r.dir, '.agents/tasks/LC.md'), SECTION(LINE));
  tests(r.dir, LINE);
  blocks(submit(r.dir), 'a task-file edit after the approval added an accepted line');
  r = batchRun(SECTION(LINE), LINE);
  writeFileSync(path.join(r.dir, '.agents/tasks/LC.md'), readFileSync(path.join(r.dir, '.agents/tasks/LC.md'), 'utf8').replace(SECTION(LINE), '\n'));
  tests(r.dir, LINE);
  clears(submit(r.dir), 'the approved summary decides, not the later task file');
});

test('ta-10: a plan line that differs from the proposed one by one byte (trailing blank, interior CR, no-break space, zero-width space, em dash) does not match', () => {
  const mimics = [`${LINE} `, LINE.replace('wait:', 'wait:\r'), LINE.replace('wait: ', 'wait:\u00a0'), `${LINE}\u200b`, LINE.replace(' -- ', ' — ')];
  const { dir } = batchRun(SECTION(LINE), mimics.join('\n'));
  for (const mimic of mimics) {
    tests(dir, mimic);
    const x = submit(dir);
    refused(x, `mimic ${JSON.stringify(mimic.slice(-3))}`, '');
    assert.match(x.text, /exception not approved|findings\.json of the tests review is not valid/);
  }
  tests(dir, LINE);
  blocks(submit(dir), 'the proposed line is not in the plan at all');
});
