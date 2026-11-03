// @ts-check
// CLI-only core subcommands: `node proofline-core.mjs cli <name> ...`. They are NOT agent.sh commands (no entry in the command table, no
// role gate of agent.sh, no preamble delegation); the shell front ends of bin/proofline call them until stage 9. The set is closed and tested:
//   - exactly the names of CLI_COMMANDS run; any other name is refused with status 2 and nothing is run, never handed to the shell;
//   - insights and queue are read-only: no lock, no file written, no program other than `agent.sh status|next`; pre-commit and pre-push (stage 3) are the
//     logic of the git hooks: they run git, the run commands the hooks asked (in process) and `delivery-check` (the shell, until stage 4);
//   - scan-secrets writes nothing; it runs the `commands.secret_scan` of `<--root>/.agents/config.yaml` through /bin/sh when the project sets one (the project's own
//     command, as secret-scan.sh did), so it is not an agent.sh command and does not run for a model (the bash guard owns that);
//   - AGENT_ROLE does not gate them (the CLI is the user's terminal and the report holds nothing a role may not read through `agent.sh`);
//   - no name may equal a command of agent.sh, so `cli` can never become a second front door to a moved or unmoved agent.sh command.
import { readFileSync } from 'node:fs';
import { ProoflineError } from '../errors.mjs';
import { insightsReport, insightsStream } from '../insights.mjs';
import { nextUser } from '../nextuser.mjs';
import { queue } from '../queue.mjs';
import { preCommit, prePush } from '../githooks.mjs';
import { builtinScan } from '../secretscan.mjs';

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

/** `cli pre-commit` (githooks/pre-commit): stderr and the exit code are the hook's. @param {Context} ctx @param {string[]} args */
function preCommitCommand(ctx, args) {
  if (args.length > 0) throw new ProoflineError('proofline-core cli pre-commit: no arguments', 2, 'USAGE');
  return preCommit(ctx);
}

/** `cli pre-push` (githooks/pre-push): the lines git gives the hook arrive on stdin. @param {Context} ctx @param {string[]} args */
function prePushCommand(ctx, args) {
  if (args.length > 0) throw new ProoflineError('proofline-core cli pre-push: no arguments', 2, 'USAGE');
  let text = '';
  try { text = readFileSync(0, 'latin1'); } catch { text = ''; }
  return prePush(ctx, text);
}

/** `cli next-line [<command> [<ID>]] [--error[=<kind>]]`: the user's next step that ends a `proofline` command (the table of next-user); the project is PROOFLINE_ROOT. @param {Context} ctx @param {string[]} args */
function nextLine(ctx, args) {
  return nextUser(ctx, args);
}

/**
 * `cli scan-secrets [--root DIR] <path>...` (the former scripts/secret-scan.sh): prints one `path:line:rule` per finding, never a value; status 0 clean, 1 found,
 * 2 error. build-record.sh (shell until stage 7) scans the env files of a build record with it.
 * @param {Context} ctx @param {string[]} args
 */
function secretScanCli(ctx, args) {
  let root = ctx.root;
  let rest = args;
  if (rest[0] === '--root') { if (rest[1] === undefined || rest[1] === '') throw new ProoflineError('proofline-core cli scan-secrets: --root needs a directory', 2, 'USAGE'); root = rest[1]; rest = rest.slice(2); }
  if (rest.length === 0) throw new ProoflineError('proofline-core cli scan-secrets: [--root DIR] <path>...', 2, 'USAGE');
  const r = builtinScan(ctx, root, rest);
  ctx.out(r.stdout); ctx.err(r.stderr);
  return r.status;
}

/** The closed set. @type {Readonly<Record<string, (ctx: Context, args: string[]) => number>>} */
export const CLI_COMMANDS = Object.freeze({ insights, queue: queueCommand, 'next-line': nextLine, 'pre-commit': preCommitCommand, 'pre-push': prePushCommand, 'scan-secrets': secretScanCli });

/** @param {Context} ctx @param {string[]} args the arguments after `cli` */
export function runCli(ctx, args) {
  const name = args[0] ?? '';
  if (!Object.hasOwn(CLI_COMMANDS, name)) throw new ProoflineError(`proofline-core: ${name === '' ? '(no name)' : name} is not a CLI subcommand of the Node core`, 2, 'NOT_MOVED');
  const code = CLI_COMMANDS[name](ctx, args.slice(1));
  ctx.flush();
  return code;
}
