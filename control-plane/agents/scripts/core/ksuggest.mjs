// @ts-check
// A290: the knowledge step in an unattended batch never asks and never parks. In a run of the approved batch `knowledge-done` records the safe default (no page written, nothing
// under docs/ or in skills/rules by an agent) and a `knowledge-suggestion` ledger row per proposal for the user; this module decides whether a run is such a run and reads the rows back.
import { batchApproval } from './approvals.mjs';
import { batchMember } from './next.mjs';
import { fileText, ledgerRows } from './records.mjs';
import { runDir } from './runs.mjs';
import { pipelineClass, pipelineClassValid } from './signals.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The suggestion text is one plain line of printable characters, at most this long. */
export const SUGGESTION_MAX = 400;

/** One plain line: control characters and the blanks around them become one blank, the length is bounded. @param {string} s */
export function plainLine(s) {
  const t = s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return t.length > SUGGESTION_MAX ? `${t.slice(0, SUGGESTION_MAX - 3)}...` : t;
}

/**
 * The run belongs to the batch the USER approved (a valid `batch` approval of the current SUMMARY.md, answered by the user from a captured message or the terminal), is listed in that approved
 * summary's own task table (order.tsv alone, which is not part of the approved bytes, is not enough) and is not CRITICAL (a CRITICAL task is not covered by the batch: it keeps the real step).
 * @param {Context} ctx @param {string} id
 */
export function batchKnowledgeRun(ctx, id) {
  if (!batchMember(ctx, id)) return false;
  const summary = fileText(ctx, `${ctx.sharedMain()}/.agents/local/batch/SUMMARY.md`) ?? '';
  if (!summary.split('\n').some((l) => new RegExp(`^\\| [0-9]+ \\| ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`).test(l))) return false;
  const cls = pipelineClass(ctx, runDir(ctx, id));
  return pipelineClassValid(cls) && cls !== 'CRITICAL';
}

/**
 * The suggestions of the last `knowledge-done` of a run, read structurally (whole ledger rows only, A284): the `knowledge-suggestion` rows written between the previous
 * `knowledge-done` row and the last one.
 * @param {Context} ctx @param {string} dir @returns {string[]}
 */
export function knowledgeSuggestions(ctx, dir) {
  const done = ledgerRows(ctx, dir, 'knowledge-done');
  if (done.length === 0) return [];
  const last = done[done.length - 1].seq;
  const prev = done.length > 1 ? done[done.length - 2].seq : 0;
  return ledgerRows(ctx, dir, 'knowledge-suggestion').filter((r) => r.seq > prev && r.seq < last).map((r) => r.detail);
}

/** The `knowledge_reason` that marks the batch default. */
export const DEFAULT_REASON = 'batch default (A290): no knowledge page was written, the suggestion to the user is in the report';
