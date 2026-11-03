// @ts-check
// Stage 4, package 4C: `publish-completion-report` and `verify-completion-report` (agent.sh 0.0.47 arms, A214).
import { publishCompletionReport, verifyCompletionReport } from '../complreport.mjs';
import { need } from '../lifeutil.mjs';

/** @typedef {import('../context.mjs').Context} Context */

/** @param {Context} ctx @param {string[]} args */
function publish(ctx, args) {
  ctx.fpMode = 'refresh';
  return publishCompletionReport(ctx, need(args, 0), args[1] ?? '');
}

/** @param {Context} ctx @param {string[]} args */
function verify(ctx, args) { return verifyCompletionReport(ctx, need(args, 0)); }

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const COMPLETION_HANDLERS = { 'publish-completion-report': publish, 'verify-completion-report': verify };
