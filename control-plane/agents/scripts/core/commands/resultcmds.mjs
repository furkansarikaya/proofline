// @ts-check
// Stage 4, package 4C: the result protocol (`record`, `submit`), agent.sh 0.0.47 arms `record)` and `submit)`.
import { unsupported } from '../errors.mjs';
import { need, readStdin } from '../lifeutil.mjs';
import { recordResult } from '../record.mjs';
import { submitResult } from '../submit.mjs';

/** @typedef {import('../context.mjs').Context} Context */

/** `record ID [--file F]`: the result from the file, else from stdin. @param {Context} ctx @param {string[]} args */
function record(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = need(args, 0);
  let file = '';
  if (args[1] === '--file') { if (args[2] === undefined || args[2] === '') throw unsupported('usage'); file = args[2]; }
  const r = recordResult(ctx, id, file, file === '' ? readStdin() : '');
  for (const l of r.risk) ctx.out(`${l}\n`);
  ctx.out(`${r.line}\n`);
  return 0;
}

/** `submit ID OPTIONS...` @param {Context} ctx @param {string[]} args */
function submit(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = need(args, 0);
  return submitResult(ctx, id, args.slice(1));
}

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const RESULTCMD_HANDLERS = { record, submit };
