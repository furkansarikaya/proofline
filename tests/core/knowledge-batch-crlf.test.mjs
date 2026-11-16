// @ts-check
// A303: the knowledge default (A291) reads the Order table of the approved summary. A title row that carries a CR (a task file with Windows line endings, or a lone CR in a title) is still the
// row of its task: the default is taken; a forged id with the same CRLF summary is not.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { accepted, refused, rv } from '../lib/harness.mjs';
import { A, codeDone, sayNow } from './lifecycle-s2-lib.mjs';

const BD = '.agents/local/batch';
const SUMMARY = (/** @type {string} */ row) => `# Night batch\n\nnonce: t-crlf\n\n## Order\n\n| # | task | title | class | depends_on |\n|---|------|-------|-------|------------|\n${row}\n`;
/** @param {string} d @param {string} summary @param {string} order */
function approveBatch(d, summary, order) {
  mkdirSync(path.join(d, BD), { recursive: true });
  writeFileSync(path.join(d, BD, 'SUMMARY.md'), summary);
  writeFileSync(path.join(d, BD, 'order.tsv'), order);
  accepted(A(d, ['request-approval', '-', 'batch']), 'request the batch approval');
  sayNow(d, 'approve batch');
  accepted(A(d, ['approve', '-', 'batch']), 'approve the batch');
}

for (const title of ['title\r', 'ti\rtle', 'title\r\r']) {
  test(`a title row with CR (${JSON.stringify(title)}) is the task's row: the knowledge default is taken`, () => {
    const d = codeDone('standalone');
    approveBatch(d, SUMMARY(`| 1 | LC | ${title} | STANDARD | - |`), 'LC\tSTANDARD\t-\n');
    accepted(A(d, ['knowledge-done', 'LC']), 'knowledge-done in the approved CRLF batch');
    assert.ok(rv(d, 'execution', 'knowledge_reason').startsWith('batch default (A291)'));
  });
}

test('with a CR in the summary a task that is not in its table keeps the real step', () => {
  const d = codeDone('standalone');
  approveBatch(d, SUMMARY('| 1 | OTHER | title\r | STANDARD | - |'), 'OTHER\tSTANDARD\t-\nLC\tSTANDARD\t-\n');
  refused(A(d, ['knowledge-done', 'LC']), 'a forged id next to a CRLF row', 'no knowledge page was written');
});
