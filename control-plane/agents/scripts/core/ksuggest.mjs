// @ts-check
// A290: the knowledge step in an unattended batch never asks and never parks. In a run of the approved batch `knowledge-done` records the safe default (no page written, nothing
// under docs/ or in skills/rules by an agent) and a `knowledge-suggestion` ledger row per proposal for the user; this module decides whether a run is such a run and reads the rows back.
import { deriveState } from './batch.mjs';
import { batchMember } from './next.mjs';
import { fileText, ledgerRows } from './records.mjs';
import { runDir } from './runs.mjs';
import { asciiLower } from './shellglob.mjs';
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
  if (!(pipelineClassValid(cls) && cls !== 'CRITICAL')) return false;
  // the batch must still have work left (a finished batch gives no default); a batch whose session stopped with work left is not told apart (no such record exists)
  const mode = ctx.fpMode;
  try { ctx.fpMode = 'yes'; return deriveState(ctx) === 'approved'; } finally { ctx.fpMode = mode; }
}

/**
 * The suggestions of the last `knowledge-done` of a run, read structurally (whole ledger rows only, A284): the `knowledge-suggestion` rows written after the last
 * `knowledge-done` row (written after it, so a retry that fails in between cannot leave a duplicate: the last knowledge-done row starts the list again).
 * @param {Context} ctx @param {string} dir @returns {string[]}
 */
export function knowledgeSuggestions(ctx, dir) {
  const done = ledgerRows(ctx, dir, 'knowledge-done');
  if (done.length === 0) return [];
  const last = done[done.length - 1].seq;
  return ledgerRows(ctx, dir, 'knowledge-suggestion').filter((r) => r.seq > last).map((r) => r.detail);
}

/** The `knowledge_reason` that marks the batch default. */
export const DEFAULT_REASON = 'batch default (A290): no knowledge page was written, the suggestion to the user is in the report';

/** The line shown when a batch default has no suggestion row (the process died between the knowledge-done row and the suggestion rows): what was skipped never depends on the second write. */
export const DEFAULT_FALLBACK = 'Suggestion to the user (knowledge): no knowledge page was written for this task (batch default); nothing under docs/, skills or rules was changed; consider writing one.';

/** The batch default was taken by the script in the last `knowledge-done` of the run: a `knowledge-default` ledger row written only by that path after the last `knowledge-done` row (whole rows, A284); the reason text alone proves nothing. @param {Context} ctx @param {string} dir */
export function knowledgeDefaultTaken(ctx, dir) {
  const done = ledgerRows(ctx, dir, 'knowledge-done');
  if (done.length === 0) return false;
  const last = done[done.length - 1].seq;
  return ledgerRows(ctx, dir, 'knowledge-default').some((r) => r.seq > last);
}

/** The normalised text an agent-given reason is compared on: ASCII-folded, blanks collapsed and trimmed. @param {string} s */
export function foldReason(s) {
  return asciiLower(s).replace(/[ \t\n\v\f\r]+/g, ' ').replace(/^ /, '').replace(/ $/, '');
}

/** A reason that equals the batch default's text or starts with its fixed prefix: only the script writes it. @param {string} reason */
export function imitatesBatchDefault(reason) {
  const f = foldReason(reason);
  return f === foldReason(DEFAULT_REASON) || f.startsWith('batch default');
}
