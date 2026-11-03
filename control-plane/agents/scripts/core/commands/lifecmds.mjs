// @ts-check
// Stage 4, package 4B: start, freeze, refreeze, handoff, terminate, amend, reopen, cleanup (agent.sh 0.0.47 arms and functions, A213).
import { realpathSync } from 'node:fs';
import { fail } from '../errors.mjs';
import { freezeRun } from '../freeze.mjs';
import { git } from '../git.mjs';
import { recordHandoff } from '../handoff.mjs';
import { need, shellChild } from '../lifeutil.mjs';
import { requireLead } from '../approve.mjs';
import { isDir } from '../paths.mjs';
import { amendRun, reopenRun } from '../reopen.mjs';
import { fileText, textLines, validTaskId } from '../records.mjs';
import { cleanupRun, terminateRun } from '../runend.mjs';
import { runDir } from '../runs.mjs';
import { startRun } from '../runstart.mjs';
import { wtLinked } from './runcmds.mjs';

/** @typedef {import('../context.mjs').Context} Context */

/** @param {Context} ctx @param {string[]} args */
function start(ctx, args) { ctx.fpMode = 'refresh'; return startRun(ctx, args); }

/** @param {Context} ctx @param {string[]} args */
function freeze(ctx, args) { ctx.fpMode = 'refresh'; requireLead(ctx); return freezeRun(ctx, need(args, 0), '', ''); }

/** @param {Context} ctx @param {string[]} args */
function refreeze(ctx, args) { ctx.fpMode = 'refresh'; requireLead(ctx); const id = need(args, 0); return freezeRun(ctx, id, 'refreeze', need(args, 1)); }

/** @param {Context} ctx @param {string[]} args */
function handoff(ctx, args) {
  ctx.fpMode = 'refresh';
  if (ctx.role !== 'lead' && args[1] !== 'IMPLEMENTING') fail(`handoff phase denied for ${ctx.role}`);
  return recordHandoff(ctx, need(args, 0), need(args, 1));
}

/** @param {Context} ctx @param {string[]} args */
function terminate(ctx, args) { ctx.fpMode = 'refresh'; requireLead(ctx); const id = need(args, 0); return terminateRun(ctx, id, need(args, 1)); }

/** @param {Context} ctx @param {string[]} args */
function amend(ctx, args) { ctx.fpMode = 'refresh'; requireLead(ctx); return amendRun(ctx, need(args, 0)); }

/** @param {Context} ctx @param {string[]} args */
function reopen(ctx, args) { ctx.fpMode = 'refresh'; requireLead(ctx); return reopenRun(ctx, need(args, 0)); }
/**
 * `cleanup ID`. There is no flag that says "merged": the worktree of a delivered run is removed only when the merge is on record (a merged.tsv row of this run), or when
 * the delivery code (deliver-step cleanup, deliver-merged) proved the merge in this very process and called the cleanup itself (A215); a typed claim gains nothing.
 * @param {Context} ctx @param {string[]} args
 */
function cleanup(ctx, args) {
  ctx.fpMode = 'refresh';
  requireLead(ctx);
  const raw = args[0] ?? '';
  // round 3: the run is already cleaned up but its worktree was left behind: from the main working tree it is removed once the merge is on record
  if (raw !== '' && validTaskId(raw) && !/^[^A-Za-z0-9]/.test(raw) && !raw.includes('..') && !isDir(runDir(ctx, raw)) && !wtLinked(ctx)) {
    const merged = fileText(ctx, `${ctx.sharedMain()}/.agents/local/batch/merged.tsv`);
    if (merged !== null && textLines(merged).some((l) => l.startsWith(`${raw}\t`))) {
      let main = ctx.root;
      try { main = realpathSync(ctx.root); } catch { /* keep */ }
      const dir = `${main}/.agents/local/worktrees/${raw}`;
      if (git(ctx, ['worktree', 'list', '--porcelain']).out.split('\n').some((l) => l === `worktree ${dir}`)) {
        const r = shellChild(ctx, ['worktree-remove', raw]);
        ctx.out(r.out); if (r.err !== '') ctx.err(r.err);
        return r.status;
      }
    }
  }
  const id = need(args, 0);
  return cleanupRun(ctx, id);
}

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const LIFECMD_HANDLERS = { start, freeze, refreeze, handoff, terminate, amend, reopen, cleanup };
