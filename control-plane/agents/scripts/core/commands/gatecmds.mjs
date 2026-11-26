// @ts-check
// Stage 4, package 4C: `secret-scan`, `worker-evidence`, `raise-budget`, `waive`, `knowledge-done`, `run-language` (and `gate`, in gatecmd.mjs).
import { requireLead, runLanguage } from '../approve.mjs';
import { advisoryCheckCommand } from '../advisory.mjs';
import { fail } from '../errors.mjs';
import { revokeStanding, standingList } from '../standing.mjs';
import { knowledgeDoneCommand } from '../knowledge.mjs';
import { gateCommand, raiseBudgetCommand, secretScanCommand, waiveCommand, workerEvidenceCommand } from '../gatecmd.mjs';

/** @typedef {import('../context.mjs').Context} Context */

/** A command that writes: it hashes and refreshes the big-file cache (A202 item 28). @param {(ctx: Context, args: string[]) => number} fn */
const writing = (fn) => (/** @type {Context} */ ctx, /** @type {string[]} */ args) => { ctx.fpMode = 'refresh'; return fn(ctx, args); };

/** `run-language [ID]`: `tr` or `en`. @param {Context} ctx @param {string[]} args */
function runLanguageCommand(ctx, args) {
  ctx.out(`${runLanguage(ctx, args[0] === undefined || args[0] === '' ? '-' : args[0])}\n`);
  return 0;
}

/**
 * `standing [list | revoke RULE [SURFACE]]` (A361): the approvals the project carries across tasks, batches and runs, and the revocation of one. Revoking works only on the user's own
 * captured message ("revoke RULE"); nothing here creates a standing approval (`approve` and `waive` do, from the user's message).
 * @param {Context} ctx @param {string[]} args
 */
function standingCommand(ctx, args) {
  const sub = args[0] ?? 'list';
  requireLead(ctx);
  if (sub === 'list' && args.length <= 1) { ctx.out(standingList(ctx)); return 0; }
  if (sub === 'revoke' && args.length >= 2 && args.length <= 3 && args[1] !== '') {
    const gone = revokeStanding(ctx, args[1], args[2] ?? '');
    ctx.out(`revoked ${gone.length} standing approval(s) of ${args[1]}: ${gone.map((r) => `${r.scope} on ${r.surface}`).join('; ')}\n`);
    return 0;
  }
  return fail('usage: agent.sh standing [list | revoke <rule> [<surface>]]');
}

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const GATECMD_HANDLERS = {
  gate: writing(gateCommand),
  'secret-scan': writing(secretScanCommand),
  'worker-evidence': writing(workerEvidenceCommand),
  'raise-budget': writing(raiseBudgetCommand),
  waive: writing(waiveCommand),
  'knowledge-done': writing(knowledgeDoneCommand),
  'run-language': runLanguageCommand,
  standing: standingCommand,
  'advisory-check': writing(advisoryCheckCommand),
};
