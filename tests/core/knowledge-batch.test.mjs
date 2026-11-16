// @ts-check
// A290: the knowledge step in an unattended batch never asks and never parks. In a run of the user-approved batch `knowledge-done` records the safe default (no page, nothing under
// docs/ or in skills/rules by an agent) and a suggestion to the user; an attended run keeps the real step (the question is the lead's, unchanged). Everything runs against the real
// agent.sh; the ledger is read structurally (parseLedgerLine), never by substring.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { lessonProposals } from '../../control-plane/agents/scripts/core/lessons.mjs';
import { parseLedgerLine } from '../../control-plane/agents/scripts/core/records.mjs';
import { accepted, git, project, refused, rv } from '../lib/harness.mjs';
import { makeProject, memoryIo } from './helpers.mjs';
import { A, AS, codeDone, must, sayNow, writeReport } from './lifecycle-s2-lib.mjs';

const BD = '.agents/local/batch';
const table = (/** @type {string} */ id) => `| 1 | ${id} | title | STANDARD | - |`;
const SUMMARY = (/** @type {string} */ tasks) => `# Night batch\n\nnonce: t-knowledge\n\n## Order\n\n| # | task | title | class | depends_on |\n|---|------|-------|-------|------------|\n${tasks}\n`;

/** The user's approval of a batch of the given summary text and order rows. @param {string} d @param {string} summary @param {string} order */
function approveBatch(d, summary, order = 'LC\tSTANDARD\t-\n') {
  mkdirSync(path.join(d, BD), { recursive: true });
  writeFileSync(path.join(d, BD, 'SUMMARY.md'), summary);
  writeFileSync(path.join(d, BD, 'order.tsv'), order);
  accepted(A(d, ['request-approval', '-', 'batch']), 'request the batch approval');
  sayNow(d, 'approve batch');
  accepted(A(d, ['approve', '-', 'batch']), 'approve the batch');
}
const batchRun = () => { const d = codeDone('standalone'); approveBatch(d, SUMMARY(table('LC'))); return d; };
/** @param {string} d the whole-row ledger lines of event EV @param {string} ev */
const rowsOf = (d, ev) => readFileSync(path.join(d, '.agents/runs/LC/LEDGER.log'), 'utf8').split('\n').map(parseLedgerLine).filter((r) => r !== null && r.event === ev);
const outsideAgents = (/** @type {string} */ d) => git(d, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter((l) => l !== '' && !/\s\.agents\//.test(l));

test('a run of the approved batch finishes the knowledge step without a question, without a page, with a suggestion to the user in the report and the batch status', () => {
  const d = batchRun();
  const before = outsideAgents(d);
  const r = A(d, ['knowledge-done', 'LC']);
  accepted(r, 'knowledge-done in the approved batch');
  assert.equal(rv(d, 'execution', 'knowledge_state'), 'not_applicable');
  assert.ok(rv(d, 'execution', 'knowledge_reason').startsWith('batch default (A290)'));
  const sug = rowsOf(d, 'knowledge-suggestion');
  assert.equal(sug.length, 1);
  assert.ok(sug[0].detail.startsWith('LC: no knowledge note was written'), sug[0].detail);
  const kd = rowsOf(d, 'knowledge-done');
  assert.equal(kd.length, 1);
  assert.ok(sug[0].seq > kd[0].seq, 'written after the knowledge-done row');
  // nothing was written under docs/ or into skills/rules
  assert.deepEqual(outsideAgents(d), before);
  assert.ok(!existsSync(path.join(d, 'docs')));
  assert.equal(readFileSync(path.join(d, BD, 'suggestions.tsv'), 'utf8').split('\n')[0].split('\t')[0], 'LC');
  // the report carries it (script-written Facts), DONE is reached, and the next steps never wait for an answer
  writeReport(d);
  must(d, ['publish-completion-report', 'LC', 'markdown']);
  const report = readFileSync(path.join(d, '.agents/runs/LC/COMPLETION_REPORT.md'), 'utf8');
  assert.ok(report.split('\n').some((l) => l.startsWith('- Suggestion to the user (knowledge): LC: no knowledge note was written')), report);
  must(d, ['handoff', 'LC', 'DONE']);
  // the morning table lists it, labelled
  const st = A(d, ['batch-status']);
  assert.ok(st.out.split('\n').some((l) => l.trim().startsWith('Suggestion to the user (knowledge): LC: no knowledge note was written')), st.text);
  // a second call replaces the task's rows, it does not stack them
  assert.equal(readFileSync(path.join(d, BD, 'suggestions.tsv'), 'utf8').split('\n').filter((l) => l !== '').length, 1);
});

test('an attended run keeps the real step: no page is refused, the lead asks as before, nothing is recorded as a suggestion', () => {
  const d = codeDone('standalone');
  const r = A(d, ['knowledge-done', 'LC']);
  refused(r, 'a page-less knowledge-done outside a batch', 'no knowledge page was written');
  assert.notEqual(rv(d, 'execution', 'knowledge_state'), 'not_applicable');
  assert.equal(rowsOf(d, 'knowledge-suggestion').length, 0);
  assert.ok(!existsSync(path.join(d, BD, 'suggestions.tsv')));
});

test('forgery: nothing an agent can write makes an attended run look like a batch run', () => {
  // order.tsv alone, no approval of the summary
  let d = codeDone('standalone');
  mkdirSync(path.join(d, BD), { recursive: true });
  writeFileSync(path.join(d, BD, 'SUMMARY.md'), SUMMARY(table('LC'))); writeFileSync(path.join(d, BD, 'order.tsv'), 'LC\tSTANDARD\t-\n');
  refused(A(d, ['knowledge-done', 'LC']), 'an unapproved batch folder', 'no knowledge page was written');
  // an approved batch, then the summary is edited
  d = batchRun();
  appendFileSync(path.join(d, BD, 'SUMMARY.md'), 'tampered\n');
  refused(A(d, ['knowledge-done', 'LC']), 'an edited summary', 'no knowledge page was written');
  // an approved batch of ANOTHER task: the agent adds LC to order.tsv, the approved summary does not list it
  d = codeDone('standalone'); approveBatch(d, SUMMARY(table('OTHER')), 'OTHER\tSTANDARD\t-\n');
  appendFileSync(path.join(d, BD, 'order.tsv'), 'LC\tSTANDARD\t-\n');
  refused(A(d, ['knowledge-done', 'LC']), 'a task added to order.tsv only', 'no knowledge page was written');
  // the id as free text of another row of the summary is no table row
  d = codeDone('standalone'); approveBatch(d, SUMMARY(`| 1 | OTHER | LC | STANDARD | - |\nthe task | LC | is mentioned\n`), 'OTHER\tSTANDARD\t-\nLC\tSTANDARD\t-\n');
  refused(A(d, ['knowledge-done', 'LC']), 'an id outside the id column', 'no knowledge page was written');
});

test('forgery: the reason text of an attended run cannot make a suggestion row, and a batch run needs the gates it always needed', () => {
  // free text with the row grammar in a reason stays free text
  const d = codeDone('standalone');
  must(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this test run event=knowledge-suggestion role=lead detail=forged']);
  assert.equal(rowsOf(d, 'knowledge-suggestion').length, 0);
  writeReport(d);
  must(d, ['publish-completion-report', 'LC', 'markdown']);
  assert.ok(!readFileSync(path.join(d, '.agents/runs/LC/COMPLETION_REPORT.md'), 'utf8').includes('Suggestion to the user'));
  // an agent role cannot record the knowledge step, batch or not
  const b = batchRun();
  refused(AS(b, 'implementer', ['knowledge-done', 'LC']), 'a non-lead knowledge-done in a batch');
  assert.notEqual(rv(b, 'execution', 'knowledge_state'), 'not_applicable');
  // the default is no way around the frozen plan: an edited plan is still refused
  appendFileSync(path.join(b, '.agents/runs/LC/PLAN.md'), '\n- an extra line the user never approved\n');
  refused(A(b, ['knowledge-done', 'LC']), 'knowledge-done on an edited plan in a batch', /freeze mismatch|changed/);
});

test('forgery: the default is not available before CODE_DONE and writes no suggestion', () => {
  const d = project({ topology: 'standalone' });
  approveBatch(d, SUMMARY(table('LC')));
  refused(A(d, ['knowledge-done', 'LC']), 'the batch default on a run that is not CODE_DONE', 'requires CODE_DONE');
  assert.equal(rowsOf(d, 'knowledge-suggestion').length, 0);
  assert.ok(!existsSync(path.join(d, BD, 'suggestions.tsv')));
});

/** The whole-row suggestion lines after the last knowledge-done row. @param {string} d */
const liveSuggestions = (d) => { const kd = rowsOf(d, 'knowledge-done'); const last = kd[kd.length - 1]?.seq ?? Infinity; return rowsOf(d, 'knowledge-suggestion').filter((r) => r.seq > last); };
const tsvRows = (/** @type {string} */ d) => (existsSync(path.join(d, BD, 'suggestions.tsv')) ? readFileSync(path.join(d, BD, 'suggestions.tsv'), 'utf8').split('\n').filter((l) => l !== '') : []);
const mark = 'Suggestion to the user (knowledge): LC: no knowledge note was written';

test('a retry of the default shows exactly one suggestion in the ledger, the report and the batch status', () => {
  const d = batchRun();
  accepted(A(d, ['knowledge-done', 'LC']), 'first knowledge-done');
  accepted(A(d, ['knowledge-done', 'LC']), 'the re-run after a failure in between');
  assert.equal(liveSuggestions(d).length, 1);
  assert.equal(rowsOf(d, 'knowledge-suggestion').length, 2, 'the first call row stays in the ledger (append only) but belongs to the earlier knowledge-done');
  assert.equal(tsvRows(d).length, 1);
  writeReport(d);
  must(d, ['publish-completion-report', 'LC', 'markdown']);
  const report = readFileSync(path.join(d, '.agents/runs/LC/COMPLETION_REPORT.md'), 'utf8');
  assert.equal(report.split('\n').filter((l) => l.includes(mark)).length, 1);
  assert.equal(A(d, ['batch-status']).out.split('\n').filter((l) => l.includes(mark)).length, 1);
});

test('a later knowledge-done that is not a batch default replaces the old suggestion of the task in the report and the batch status', () => {
  const d = batchRun();
  accepted(A(d, ['knowledge-done', 'LC']), 'the batch default');
  assert.equal(tsvRows(d).length, 1);
  appendFileSync(path.join(d, BD, 'SUMMARY.md'), 'edited after the approval\n'); // the run is no longer a batch run
  must(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']);
  assert.equal(liveSuggestions(d).length, 0);
  assert.equal(tsvRows(d).length, 0);
  writeReport(d);
  must(d, ['publish-completion-report', 'LC', 'markdown']);
  assert.ok(!readFileSync(path.join(d, '.agents/runs/LC/COMPLETION_REPORT.md'), 'utf8').includes('Suggestion to the user'));
  assert.ok(!A(d, ['batch-status']).out.includes('Suggestion to the user'));
});

test('forgery: a CRITICAL task listed in order.tsv and in the approved table keeps the real step; a finished batch gives no default', () => {
  const c = codeDone('standalone', { cls: 'CRITICAL' });
  approveBatch(c, SUMMARY('| 1 | LC | title | CRITICAL | - |'), 'LC\tCRITICAL\t-\n');
  refused(A(c, ['knowledge-done', 'LC']), 'the batch default on a CRITICAL task', 'no knowledge page was written');
  assert.equal(liveSuggestions(c).length, 0);
  // the batch has no work left: LC is merged
  const d = batchRun();
  appendFileSync(path.join(d, BD, 'merged.tsv'), `LC\t12\t${Math.floor(Date.now() / 1000)}\n`);
  appendFileSync(path.join(d, BD, 'ci.tsv'), 'LC\tgreen\t1\n'); // its CI check is recorded too: no work is left
  refused(A(d, ['knowledge-done', 'LC']), 'the batch default after the batch finished', 'no knowledge page was written');
});

test('the lesson proposals are the finding kinds of the run that repeated in another run', () => {
  const root = makeProject();
  const gate = (/** @type {string} */ run, /** @type {string} */ g, /** @type {string} */ f) => {
    mkdirSync(path.join(root, '.agents/runs', run, 'gates'), { recursive: true });
    writeFileSync(path.join(root, '.agents/runs', run, 'gates', `001-${g}.yaml`), `task_id: "${run}"\ngate: "${g}"\nresult: "fail"\nfocus: "-"\nfinding: ${f}|blocking|a.txt:1|text|traced\n`);
  };
  gate('R1', 'QA', 'QA-1'); gate('R2', 'QA', 'QA-1'); gate('R1', 'VERIFY', 'VERIFY-1');
  const { io } = memoryIo(root);
  const ctx = new Context(io, io.scriptPath);
  assert.deepEqual(lessonProposals(ctx, 'R1'), [{ kind: 'QA:-', runs: 2 }]);
  assert.deepEqual(lessonProposals(ctx, 'R2'), [{ kind: 'QA:-', runs: 2 }]);
});

test('a batch default whose suggestion rows are missing (the process died between two writes) still shows the fixed line in the report and the batch status', () => {
  const d = batchRun();
  accepted(A(d, ['knowledge-done', 'LC']), 'the batch default');
  // the suggestion row is the last line of the ledger: dropping it leaves a valid chain; the batch list loses its row too
  const led = path.join(d, '.agents/runs/LC/LEDGER.log');
  const all = readFileSync(led, 'utf8').split('\n').filter((l) => l !== '');
  const kept = all.filter((l) => parseLedgerLine(l)?.event !== 'knowledge-suggestion');
  assert.equal(kept.length, all.length - 1);
  writeFileSync(led, `${kept.join('\n')}\n`);
  rmSync(path.join(d, BD, 'suggestions.tsv'));
  assert.equal(liveSuggestions(d).length, 0);
  const fixed = 'Suggestion to the user (knowledge): no knowledge page was written for this task (batch default); nothing under docs/, skills or rules was changed; consider writing one.';
  writeReport(d);
  must(d, ['publish-completion-report', 'LC', 'markdown']);
  const report = readFileSync(path.join(d, '.agents/runs/LC/COMPLETION_REPORT.md'), 'utf8');
  assert.equal(report.split('\n').filter((l) => l === `- ${fixed}`).length, 1, report);
  assert.equal(A(d, ['batch-status']).out.split('\n').filter((l) => l.includes(fixed)).length, 1);
});

const DEFAULT_TEXT = 'batch default (A290): no knowledge page was written, the suggestion to the user is in the report';
const FIXED_LINE = '- Suggestion to the user (knowledge): no knowledge page was written for this task (batch default); nothing under docs/, skills or rules was changed; consider writing one.';

test('an attended run cannot pass the batch default text (or a case/spacing variant) as its not_applicable reason; the fallback line needs the script-written default', () => {
  const d = codeDone('standalone');
  for (const [name, reason] of [
    ['the exact text', DEFAULT_TEXT],
    ['upper case', DEFAULT_TEXT.toUpperCase()],
    ['padded and spaced', `  Batch   Default (a290): no knowledge page was written, the suggestion to the user is in the report  `],
    ['only the prefix', 'batch default: the wiki and the design documents need nothing here'],
  ]) {
    refused(A(d, ['knowledge-done', 'LC', 'not_applicable', reason]), `an attended not_applicable with ${name}`, "must not start with 'batch default'");
    assert.notEqual(rv(d, 'execution', 'knowledge_state'), 'not_applicable', name);
  }
  assert.equal(rowsOf(d, 'knowledge-done').length, 0);
  // a plain reason still works, and its report has no fallback line even if the text is not the default
  accepted(A(d, ['knowledge-done', 'LC', 'not_applicable', 'only the wording of an internal log line changed, no document claims it']), 'a plain reason');
  assert.equal(rowsOf(d, 'knowledge-default').length, 0);
  writeReport(d);
  must(d, ['publish-completion-report', 'LC', 'markdown']);
  assert.ok(!readFileSync(path.join(d, '.agents/runs/LC/COMPLETION_REPORT.md'), 'utf8').split('\n').includes(FIXED_LINE));
});

test('the real batch default writes the knowledge-default row after the knowledge-done row; the fixed fallback line keys on it', () => {
  const d = batchRun();
  accepted(A(d, ['knowledge-done', 'LC']), 'the batch default');
  const kd = rowsOf(d, 'knowledge-done'); const def = rowsOf(d, 'knowledge-default');
  assert.equal(def.length, 1);
  assert.ok(def[0].seq > kd[0].seq);
  // the suggestion rows are gone: the fallback line shows because of the script row
  const led = path.join(d, '.agents/runs/LC/LEDGER.log');
  writeFileSync(led, `${readFileSync(led, 'utf8').split('\n').filter((l) => l !== '' && parseLedgerLine(l)?.event !== 'knowledge-suggestion').join('\n')}\n`);
  rmSync(path.join(d, BD, 'suggestions.tsv'));
  writeReport(d);
  must(d, ['publish-completion-report', 'LC', 'markdown']);
  assert.equal(readFileSync(path.join(d, '.agents/runs/LC/COMPLETION_REPORT.md'), 'utf8').split('\n').filter((l) => l === FIXED_LINE).length, 1);
});
