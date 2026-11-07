// @ts-check
// CLI-only core subcommands: `node proofline-core.mjs cli <name> ...`. They are NOT agent.sh commands (no entry in the command table, no
// role gate of agent.sh, no preamble delegation); the shell front ends of bin/proofline call them until stage 9. The set is closed and tested:
//   - exactly the names of CLI_COMMANDS run; any other name is refused with status 2 and nothing is run, never handed to the shell;
//   - leftover-worktrees only reads (it proposes a command, nothing is removed); worktree-deps copies dependency folders into the folder it is given;
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
import { slug as slugOf } from '../slug.mjs';
import { runTaskAdapter } from '../adapters/index.mjs';
import { mergeCommand } from '../merge.mjs';
import { bytes } from '../config.mjs';
import { policyCommand } from '../execpolicy.mjs';
import { runtimeDetect } from '../runtimedetect.mjs';
import { leftoverCommand } from '../leftover.mjs';
import { prepareWorktree } from '../worktree.mjs';
import { detectPlatform, detectText, droppedNetVars, fieldOf, linkText, platformEnv, warnText } from '../platform.mjs';

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

/**
 * `cli platform-info detect|field KEY|link BRANCH BASE|env|warn|net-dropped [-C DIR] [--url URL]` (the former scripts/platform.sh, for bin/lib/merge.sh): the hosting platform of
 * the origin remote of DIR (default the working directory). Prints what platform.sh printed; status 2 for a usage error. `net-dropped` (for the doctor) lists the
 * proxy and certificate variables the platform tools do not get: name and reason, never a value.
 * @param {Context} ctx @param {string[]} args
 */
function platformCli(ctx, args) {
  const usage = () => new ProoflineError('usage: proofline-core cli platform-info detect|field KEY|link BRANCH BASE|env|warn [-C DIR] [--url URL]', 2, 'USAGE');
  const op = args[0] ?? '';
  let rest = args.slice(1);
  let key = ''; let br = ''; let base = '';
  if (op === 'field') { key = rest[0] ?? ''; rest = rest.slice(1); }
  if (op === 'link') { br = rest[0] ?? ''; base = rest[1] ?? ''; rest = rest.slice(2); }
  let dir = ctx.cwd; let url = '';
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === '-C') dir = rest[i + 1] ?? '.';
    else if (rest[i] === '--url') url = rest[i + 1] ?? '';
    else throw new ProoflineError(`platform: unknown argument ${rest[i]}`, 2, 'USAGE');
  }
  if (!['detect', 'field', 'link', 'env', 'warn', 'net-dropped'].includes(op)) throw usage();
  // A220 (user decision of 2026-11-07), for `proofline doctor`: one line `NAME TAB reason` per proxy or certificate variable the tools do not get; never a value
  if (op === 'net-dropped') { for (const d of droppedNetVars(ctx)) ctx.out(`${d.name}\t${d.reason}\n`); return 0; }
  const info = detectPlatform(ctx, { dir, url });
  switch (op) {
    case 'detect': ctx.out(detectText(info)); return 0;
    case 'field': {
      const v = fieldOf(info, key);
      if (v === null) throw new ProoflineError(`platform: unknown field ${key}`, 2, 'USAGE');
      ctx.out(`${v}\n`); return 0;
    }
    case 'warn': ctx.out(warnText(info)); return 0;
    case 'env': ctx.out(Object.entries(platformEnv(info)).map(([k, v]) => `${k}=${v}\n`).join('')); return 0;
    default:
      if (br === '' || base === '') throw new ProoflineError('usage: proofline-core cli platform-info link BRANCH BASE', 2, 'USAGE');
      ctx.out(`${linkText(info, br, base)}\n`); return 0;
  }
}

/** `cli slug <title>` (the former task-integrations/slug.sh): the file and branch slug of a title; nothing for a title without a usable letter or digit. @param {Context} ctx @param {string[]} args */
function slugCli(ctx, args) {
  if (args.length !== 1) throw new ProoflineError('usage: proofline-core cli slug <title>', 2, 'USAGE');
  const s = slugOf(Buffer.from(args[0], 'utf8').toString('latin1'));
  if (s !== '') ctx.out(`${s}\n`);
  return 0;
}

/**
 * `cli task-adapter <adapter> <operation> <args...>` (the former `sh .agents/task-integrations/<adapter>.sh <operation> ...`): one operation of a task adapter of the
 * project (markdown, github, jira, linear, or a script of the project's own). Its output and exit code are the adapter's (0 ok, 1 failure, 2 usage, 3 import incomplete).
 * @param {Context} ctx @param {string[]} args
 */
function taskAdapterCli(ctx, args) {
  if (args.length < 2) throw new ProoflineError('usage: proofline-core cli task-adapter <adapter> <import|publish|verify|followup|status|statusblock|create> <args...>', 2, 'USAGE');
  const r = runTaskAdapter(ctx, args[0], args.slice(1));
  if (r === null) throw new ProoflineError(`unknown task-integration adapter: ${args[0]}`, 1);
  ctx.out(r.stdout.toString('latin1'));
  ctx.err(r.stderr.toString('latin1'));
  return r.status;
}

/** `cli merge <PR> [--merge|--squash|--rebase] [--delete-branch] [-R OWNER/REPO]` (bin/lib/merge.sh is a launcher of it): the only allowed way to merge a pull request, A136. @param {Context} ctx @param {string[]} args */
function mergeCli(ctx, args) { return mergeCommand(ctx, args); }

/**
 * `cli exec-policy [--config F] [--roles F] resolve|explain|check-capabilities|check-lead|lead-base|runtime ...` (the former scripts/exec-policy.sh; `agent.sh decide`,
 * the step records, doctor and the end-to-end harness call it). The resolver reads the project's .agents/config.yaml and .agents/roles.conf; `--config` names another
 * pair for a check outside a project (no environment value does). While the project holds .agents/scripts/exec-policy.sh (a fixture stub) that file is run instead.
 * Output and status are the resolver's: 0 resolved | 2 usage or invalid config | 3 invalid override | 4 unresolvable.
 * @param {Context} ctx @param {string[]} args
 */
function execPolicyCli(ctx, args) {
  const a = args.map(bytes);
  let i = 0;
  while (i + 1 < a.length && (a[i] === '--config' || a[i] === '--roles')) i += 2;
  let input = '';
  if (a[i] === 'explain') { try { input = readFileSync(0, 'latin1'); } catch { input = ''; } }
  const r = policyCommand(ctx, a, input);
  ctx.out(r.out); ctx.err(r.err);
  return r.status;
}

/** `cli runtime-detect [has|bin <runtime>]` (the former scripts/runtime-detect.sh; dispatch.sh asks it before a failover). @param {Context} ctx @param {string[]} args */
function runtimeDetectCli(ctx, args) {
  const r = runtimeDetect(ctx, args.map(bytes));
  ctx.out(r.out); ctx.err(r.err);
  return r.status;
}

/**
 * `cli worktree-deps <MAIN-ROOT> <DIR>` (the former `worktree-prep.sh --deps`, for build-record.sh): the ignored dependency folders of the project are COPIED into DIR
 * (the throwaway export of a build record), never linked. Writes nothing outside DIR; status 0, 1 when a copy failed, 2 for a missing folder.
 * @param {Context} ctx @param {string[]} args
 */
function worktreeDepsCli(ctx, args) {
  if (args.length !== 2) throw new ProoflineError('proofline-core cli worktree-deps: <MAIN-ROOT> <DIR>', 2, 'USAGE');
  return prepareWorktree(ctx, args[0], args[1], '', true);
}

/** The closed set. @type {Readonly<Record<string, (ctx: Context, args: string[]) => number>>} */
export const CLI_COMMANDS = Object.freeze({ 'leftover-worktrees': leftoverCommand, 'worktree-deps': worktreeDepsCli, insights, queue: queueCommand, 'next-line': nextLine, 'pre-commit': preCommitCommand, 'pre-push': prePushCommand, 'scan-secrets': secretScanCli, 'platform-info': platformCli, slug: slugCli, 'task-adapter': taskAdapterCli, merge: mergeCli, 'exec-policy': execPolicyCli, 'runtime-detect': runtimeDetectCli });

/** @param {Context} ctx @param {string[]} args the arguments after `cli` */
export function runCli(ctx, args) {
  const name = args[0] ?? '';
  if (!Object.hasOwn(CLI_COMMANDS, name)) throw new ProoflineError(`proofline-core: ${name === '' ? '(no name)' : name} is not a CLI subcommand of the Node core`, 2, 'NOT_MOVED');
  const code = CLI_COMMANDS[name](ctx, args.slice(1));
  ctx.flush();
  return code;
}
