// @ts-check
// Who approved the lines of a plan's `## Test exceptions` (A285; Core invariants 3 and 6). A line the lead wrote into PLAN.md clears a finding only when the USER approved that exact line:
//  - interactive: the user's `scope` approval for the PLAN.md the freeze consumed (named by `approval=` in the `test-exceptions` ledger row the freeze wrote), or
//  - night batch: the line is listed, with the sha256 of its exact bytes, under "Test exceptions declared by the tasks" in the batch SUMMARY.md the user approved ("approve batch" is
//    bound to the sha256 of that file), for this task.
// Everything else is unapproved and clears nothing. Nothing here writes a record; every input is a record the control plane wrote (the ledger, parsed structurally, the approval files, the
// approved summary), never a statement of an agent.
import { batchApproval, sharedDirOf } from './approvals.mjs';
import { exceptionLineHash, exceptionLines, exceptionsHash, exceptionsRow } from './testreview.mjs';
import { fileText, gateField, ledgerRows, readBytes, textLines } from './records.mjs';
import { isFile } from './paths.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The heading of the summary section that lists the exceptions the tasks declare (batch-plan writes it, the check reads it). */
export const BATCH_EXC_HEADING = '## Test exceptions declared by the tasks (the approval of this summary accepts exactly these lines, A285)';
const LINE_ROW = /^- test exception ([A-Za-z0-9_-]+) ([0-9a-f]{64}): /;

/** The most lines and the longest line one task may declare in a batch: a line that could not be shown in full is not listed (so it is not approved). */
export const BATCH_EXC_MAX_LINES = 50;
export const BATCH_EXC_MAX_LINE = 1000;

/**
 * The line hashes the APPROVED batch summary lists for a task; empty when there is no valid batch approval for the current summary or the task is not in the batch.
 * @param {Context} ctx @param {string} id @returns {Set<string>}
 */
export function batchListed(ctx, id) {
  /** @type {Set<string>} */ const out = new Set();
  const bd = sharedDirOf(ctx, 'batch');
  if (!isFile(`${bd}/SUMMARY.md`) || !isFile(`${bd}/order.tsv`)) return out;
  if (batchApproval(ctx) === null) return out;
  if (!textLines(readBytes(`${bd}/order.tsv`) ?? '').some((l) => l.split('\t')[0] === id)) return out;
  let inside = false;
  for (const l of textLines(readBytes(`${bd}/SUMMARY.md`) ?? '')) {
    if (l.startsWith('## ')) { inside = l === BATCH_EXC_HEADING; continue; }
    if (!inside) continue;
    const m = LINE_ROW.exec(l);
    if (m !== null && m[1] === id) out.add(m[2]);
  }
  return out;
}

/**
 * Whether the `approval=` file a `test-exceptions` row names is a scope approval the user gave and the control plane consumed: the ledger names it (an `approval` row written when it was
 * recorded, an `approval-consumed` row written when the freeze used it) and the file says scope, user, from the prompt hook or the terminal. A hand-written file is in no ledger row.
 * @param {Context} ctx @param {string} dir @param {string} name
 */
function userScopeApproval(ctx, dir, name) {
  if (!/^[0-9]{3}-scope\.yaml$/.test(name)) return false;
  const f = `${dir}/approvals/${name}`;
  if (!isFile(f)) return false;
  if (gateField(ctx, f, 'kind') !== 'scope' || gateField(ctx, f, 'answered_by') !== 'user') return false;
  const src = gateField(ctx, f, 'source');
  if (src !== 'prompt_capture' && src !== 'tty') return false;
  if (!ledgerRows(ctx, dir, 'approval').some((r) => r.detail.startsWith(`approvals/${name}@`))) return false;
  return ledgerRows(ctx, dir, 'approval-consumed').some((r) => r.detail === `${name} scope`);
}

/**
 * The approval state of the lines of a run's PLAN.md `## Test exceptions`.
 * `lines`: the section's lines (byte for byte); `approved(line)`: whether that exact line clears findings; `by`: `none`, `user` or `batch`.
 * Safe side: a section whose hash is not the one the freeze recorded (an edit after the freeze) approves nothing.
 * @param {Context} ctx @param {string} dir @param {string} id
 * @returns {{ lines: string[], by: 'none' | 'user' | 'batch', approved: (line: string) => boolean }}
 */
export function exceptionApproval(ctx, dir, id) {
  const plan = fileText(ctx, `${dir}/PLAN.md`) ?? '';
  const lines = exceptionLines(plan);
  const none = { lines, by: /** @type {'none'} */ ('none'), approved: (/** @type {string} */ _l) => false };
  if (lines.length === 0) return none;
  const row = exceptionsRow(ctx, dir);
  if (row === null || row.sha !== exceptionsHash(plan)) return none;
  if (row.approval !== '' && userScopeApproval(ctx, dir, row.approval)) return { lines, by: 'user', approved: () => true };
  const listed = batchListed(ctx, id);
  if (listed.size > 0) return { lines, by: 'batch', approved: (l) => listed.has(exceptionLineHash(l)) };
  return none;
}

/** The lines of a run's section that are not approved (empty when there are none or all are). @param {Context} ctx @param {string} dir @param {string} id */
export function unapprovedExceptions(ctx, dir, id) {
  const a = exceptionApproval(ctx, dir, id);
  return a.lines.filter((l) => !a.approved(l));
}

/**
 * The line the batch reports for a frozen run whose plan has exception lines nobody approved ('' when there are none): the finding they would have cleared stays blocking.
 * @param {Context} ctx @param {string} dir @param {string} id
 */
export function unapprovedNote(ctx, dir, id) {
  if (exceptionsRow(ctx, dir) === null) return '';
  const n = unapprovedExceptions(ctx, dir, id).length;
  return n === 0 ? '' : `${id}: exception not approved: stays blocking (${n} line(s) of PLAN.md ## Test exceptions are not in the approved batch summary and have no scope approval of yours)`;
}
