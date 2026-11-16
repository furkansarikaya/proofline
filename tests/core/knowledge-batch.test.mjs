// @ts-check
// A290: the knowledge step in an unattended batch never asks and never parks. In a run of the user-approved batch `knowledge-done` records the safe default (no page, nothing under
// docs/ or in skills/rules by an agent) and a suggestion to the user; an attended run keeps the real step (the question is the lead's, unchanged). Everything runs against the real
// agent.sh; the ledger is read structurally (parseLedgerLine), never by substring.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseLedgerLine } from '../../control-plane/agents/scripts/core/records.mjs';
import { accepted, git, project, refused, rv } from '../lib/harness.mjs';
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
  assert.ok(sug[0].seq < kd[0].seq);
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
