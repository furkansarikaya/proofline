// @ts-check
// Stage 4, package 4C: `secret-scan`, `worker-evidence`, `raise-budget`, `waive`, `knowledge-done`, `run-language` (and `gate`, in gatecmd.mjs).
import { runLanguage } from '../approve.mjs';
import { knowledgeDoneCommand } from '../knowledge.mjs';
import { raiseBudgetCommand, secretScanCommand, waiveCommand, workerEvidenceCommand } from '../gatecmd.mjs';

/** @typedef {import('../context.mjs').Context} Context */

/** A command that writes: it hashes and refreshes the big-file cache (A202 item 28). @param {(ctx: Context, args: string[]) => number} fn */
const writing = (fn) => (/** @type {Context} */ ctx, /** @type {string[]} */ args) => { ctx.fpMode = 'refresh'; return fn(ctx, args); };

/** `run-language [ID]`: `tr` or `en`. @param {Context} ctx @param {string[]} args */
function runLanguageCommand(ctx, args) {
  ctx.out(`${runLanguage(ctx, args[0] === undefined || args[0] === '' ? '-' : args[0])}\n`);
  return 0;
}

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const GATECMD_HANDLERS = {
  'secret-scan': writing(secretScanCommand),
  'worker-evidence': writing(workerEvidenceCommand),
  'raise-budget': writing(raiseBudgetCommand),
  waive: writing(waiveCommand),
  'knowledge-done': writing(knowledgeDoneCommand),
  'run-language': runLanguageCommand,
};
