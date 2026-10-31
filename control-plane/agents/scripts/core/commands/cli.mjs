// @ts-check
// CLI-only core subcommands: `node proofline-core.mjs cli <name> ...`. They are NOT agent.sh commands (no entry in the command table, no
// role gate of agent.sh, no preamble delegation); the shell front ends of bin/proofline call them until stage 9. The set is closed and tested:
//   - exactly the names of CLI_COMMANDS run; any other name is refused with status 2 and nothing is run, never handed to the shell;
//   - every one is read-only: it takes no lock, writes no file and starts no program other than `agent.sh status|next` (read-only commands);
//   - AGENT_ROLE does not gate them (the CLI is the user's terminal and the report holds nothing a role may not read through `agent.sh`);
//   - no name may equal a command of agent.sh, so `cli` can never become a second front door to a moved or unmoved agent.sh command.
import { ProoflineError } from '../errors.mjs';
import { insightsReport, insightsStream } from '../insights.mjs';
import { queue } from '../queue.mjs';

/** @typedef {import('../context.mjs').Context} Context */

/** `cli insights [--run ID] [--json]`: the report only; the front end validated the arguments and appends the context-size tail. @param {Context} ctx @param {string[]} args */
function insights(ctx, args) {
  let json = false; let only = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--run' && i + 1 < args.length) only = args[++i];
    else throw new ProoflineError('proofline-core cli insights: [--run <ID>] [--json]', 2, 'USAGE');
  }
  if (!/^[A-Za-z0-9_-]*$/.test(only)) throw new ProoflineError('proofline-core cli insights: invalid run id', 2, 'USAGE');
  const off = ctx.config().get('metrics', 'on') === 'off';
  ctx.out(insightsReport(insightsStream(ctx.root, only), { json, only, off }));
  return 0;
}

/** `cli queue`. @param {Context} ctx @param {string[]} args */
function queueCommand(ctx, args) {
  if (args.length > 0) throw new ProoflineError('proofline-core cli queue: no arguments', 2, 'USAGE');
  return queue(ctx);
}

/** The closed set. @type {Readonly<Record<string, (ctx: Context, args: string[]) => number>>} */
export const CLI_COMMANDS = Object.freeze({ insights, queue: queueCommand });

/** @param {Context} ctx @param {string[]} args the arguments after `cli` */
export function runCli(ctx, args) {
  const name = args[0] ?? '';
  if (!Object.hasOwn(CLI_COMMANDS, name)) throw new ProoflineError(`proofline-core: ${name === '' ? '(no name)' : name} is not a CLI subcommand of the Node core`, 2, 'NOT_MOVED');
  const code = CLI_COMMANDS[name](ctx, args.slice(1));
  ctx.flush();
  return code;
}
