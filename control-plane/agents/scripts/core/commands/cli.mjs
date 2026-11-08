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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { applyCommands, emptyKinds, proposeCommands } from '../commandsprop.mjs';
import { checkBudget, contextRows, reportText, rootExists, tsvText } from '../contextsize.mjs';
import { KINDS, ambigNotes, discoverCommands, joinCommands, runWithTimeout, verifyCommands } from '../discover.mjs';
import { applyHookTimeouts, applyScale, proposeScale } from '../scale.mjs';
import { configCommand } from '../cfgcli.mjs';
import { doctorCommand, globalHookspathMessage } from '../doctor.mjs';
import { insightsFront } from '../insightsfront.mjs';
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
 * 2 error. The build record (core/buildrecord.mjs) scans the env files of a record with the same scanner in process.
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
 * `cli platform-info detect|field KEY|link BRANCH BASE|env|warn|net-dropped [-C DIR] [--url URL]` (the former scripts/platform.sh, for `proofline merge`): the hosting platform of
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

/** `cli merge <PR> [--merge|--squash|--rebase] [--delete-branch] [-R OWNER/REPO]` (bin/proofline calls it): the only allowed way to merge a pull request, A136. @param {Context} ctx @param {string[]} args */
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
 * `cli worktree-deps <MAIN-ROOT> <DIR>` (the former `worktree-prep.sh --deps`, for the build record): the ignored dependency folders of the project are COPIED into DIR
 * (the throwaway export of a build record), never linked. Writes nothing outside DIR; status 0, 1 when a copy failed, 2 for a missing folder.
 * @param {Context} ctx @param {string[]} args
 */
function worktreeDepsCli(ctx, args) {
  if (args.length !== 2) throw new ProoflineError('proofline-core cli worktree-deps: <MAIN-ROOT> <DIR>', 2, 'USAGE');
  return prepareWorktree(ctx, args[0], args[1], '', true);
}


/**
 * `cli discover <ROOT> [--verify] [--quiet] [--out FILE]` (the former bin/lib/discover.sh, for `proofline init` and `doctor`): the build, test and lint commands the project's own
 * files give. Prints what `init` says (the commands found, the ecosystems that got none because their target is ambiguous, and with `--verify` the trial runs; `--quiet`
 * prints nothing); `--out FILE` writes one `kind TAB command` row per command (after the trial runs). Nothing but command text is read from the project; no secret is printed.
 * @param {Context} ctx @param {string[]} args
 */
function discoverCli(ctx, args) {
  const usage = () => new ProoflineError('proofline-core cli discover: <ROOT> [--verify] [--quiet] [--out FILE]', 2, 'USAGE');
  let root = ''; let verify = false; let quiet = false; let out = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verify') verify = true;
    else if (args[i] === '--quiet') quiet = true;
    else if (args[i] === '--out' && i + 1 < args.length) out = args[++i];
    else if (!args[i].startsWith('--') && root === '') root = args[i];
    else throw usage();
  }
  if (root === '') throw usage();
  const found = discoverCommands(path.resolve(ctx.cwd, root));
  const say = (/** @type {string} */ l) => { if (!quiet) { ctx.out(`${l}\n`); ctx.flush(); } };
  say(`discovered commands: build='${joinCommands(found.build)}' test='${joinCommands(found.test)}' lint='${joinCommands(found.lint)}'`);
  for (const n of ambigNotes(found.ambig)) say(`  ${n}`);
  let cmds = { build: found.build, test: found.test, lint: found.lint };
  if (verify) { say('verifying commands (trial runs)...'); cmds = verifyCommands(path.resolve(ctx.cwd, root), cmds, say, { env: ctx.env }); }
  if (out !== '') writeFileSync(out, KINDS.flatMap((k) => cmds[k].map((c) => `${k}\t${c}\n`)).join(''));
  return 0;
}

/**
 * `cli run-timeout <SECONDS> <program> [args...]` (the former `run_with_timeout`, for `proofline doctor`): runs the program with a time limit and prints its output (standard
 * output and error together). The program leads a process group of its own and the whole group is killed when the time is up; the status is the program's, or 124 on a timeout.
 * @param {Context} ctx @param {string[]} args
 */
function runTimeoutCli(ctx, args) {
  if (args.length < 2 || !/^[0-9]+$/.test(args[0])) throw new ProoflineError('proofline-core cli run-timeout: <SECONDS> <program> [args...]', 2, 'USAGE');
  const dir = mkdtempSync(path.join(tmpdir(), 'proofline-rt-'));
  try {
    const r = runWithTimeout(Number(args[0]), args.slice(1), { cwd: ctx.cwd, env: ctx.env, outFile: `${dir}/out` });
    try { ctx.out(readFileSync(`${dir}/out`, 'latin1')); } catch { /* nothing written */ }
    return r.status;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** `cli doctor-commands propose|apply|empty` (the former bin/lib/commands.sh): `proofline doctor --commands`, `--apply-commands`, and the empty keys of the config. @param {Context} ctx @param {string[]} args */
function doctorCommandsCli(ctx, args) {
  if (args.length !== 1) throw new ProoflineError('proofline-core cli doctor-commands: propose|apply|empty', 2, 'USAGE');
  if (args[0] === 'propose') return proposeCommands(ctx);
  if (args[0] === 'apply') return applyCommands(ctx);
  if (args[0] === 'empty') { ctx.out(`${emptyKinds(ctx).join(' ')}\n`); return 0; }
  throw new ProoflineError('proofline-core cli doctor-commands: propose|apply|empty', 2, 'USAGE');
}

/** `cli doctor-scale propose|apply` (the former bin/lib/timeouts.sh): `proofline doctor --scale` and `--apply-scale`. @param {Context} ctx @param {string[]} args */
function doctorScaleCli(ctx, args) {
  if (args.length === 1 && args[0] === 'propose') return proposeScale(ctx);
  if (args.length === 1 && args[0] === 'apply') return applyScale(ctx);
  throw new ProoflineError('proofline-core cli doctor-scale: propose|apply', 2, 'USAGE');
}

/**
 * `cli hook-timeouts-apply <ROOT> <REL>` (the former `hook_timeouts_apply` of bin/lib/install.sh): sets the timeout of the proofline hooks in the settings file REL of the project
 * ROOT from its config. Prints one line `same|merged|warn TAB text`, nothing when there is nothing to do.
 * @param {Context} ctx @param {string[]} args
 */
function hookTimeoutsApplyCli(ctx, args) {
  if (args.length !== 2 || args[1].startsWith('/') || args[1].split('/').includes('..')) throw new ProoflineError('proofline-core cli hook-timeouts-apply: <ROOT> <relative settings file>', 2, 'USAGE');
  const r = applyHookTimeouts(path.resolve(ctx.cwd, args[0]), args[1]);
  if (r.state !== 'absent') ctx.out(`${r.state}\t${r.text}\n`);
  return 0;
}

/**
 * `cli context-size <repo|project> <ROOT> [report|tsv|check <budget-file>]` (the former bin/lib/context-size.sh, A202): the size of the text proofline loads into every session. A
 * project falls back to the checkout in PL_HOME (default ROOT) for a file it lacks. Status 1 when `check` finds an item above its budget, 2 for a usage error.
 * @param {Context} ctx @param {string[]} args
 */
function contextSizeCli(ctx, args) {
  const [mode = '', root = '', cmd = 'report', budget = ''] = args;
  if (mode !== 'repo' && mode !== 'project') throw new ProoflineError('usage: proofline-core cli context-size <repo|project> <root> [report|tsv|check <budget-file>]', 2, 'USAGE');
  if (!rootExists(path.resolve(ctx.cwd, root))) throw new ProoflineError(`context-size: no such directory: ${root}`, 2, 'USAGE');
  if (cmd !== 'report' && cmd !== 'tsv' && cmd !== 'check') throw new ProoflineError(`context-size: unknown command: ${cmd}`, 2, 'USAGE');
  const rows = contextRows(mode, root, ctx.env.PL_HOME || root);
  if (cmd === 'tsv') { ctx.out(tsvText(rows)); return 0; }
  if (cmd === 'report') { ctx.out(reportText(rows)); return 0; }
  let text;
  try { text = readFileSync(path.resolve(ctx.cwd, budget), 'latin1'); } catch { throw new ProoflineError(`context-size: budget file not found: ${budget}`, 2, 'USAGE'); }
  const bad = checkBudget(rows, text);
  for (const l of bad) ctx.out(`${l}\n`);
  return bad.length > 0 ? 1 : 0;
}

/** `cli hookspath-message VALUE` (the text `init` and `doctor` share): the warning for a core.hooksPath in the global or system git config. @param {Context} ctx @param {string[]} args */
function hookspathMessageCli(ctx, args) {
  if (args.length !== 1) throw new ProoflineError('proofline-core cli hookspath-message: <value>', 2, 'USAGE');
  ctx.out(`${globalHookspathMessage(args[0])}\n`);
  return 0;
}

/** The closed set. @type {Readonly<Record<string, (ctx: Context, args: string[]) => number>>} */
export const CLI_COMMANDS = Object.freeze({ 'leftover-worktrees': leftoverCommand, 'worktree-deps': worktreeDepsCli, insights, queue: queueCommand, 'next-line': nextLine, 'pre-commit': preCommitCommand, 'pre-push': prePushCommand, 'scan-secrets': secretScanCli, 'platform-info': platformCli, slug: slugCli, 'task-adapter': taskAdapterCli, merge: mergeCli, 'exec-policy': execPolicyCli, 'runtime-detect': runtimeDetectCli, discover: discoverCli, 'run-timeout': runTimeoutCli, 'doctor-commands': doctorCommandsCli, 'doctor-scale': doctorScaleCli, 'hook-timeouts-apply': hookTimeoutsApplyCli, 'context-size': contextSizeCli, doctor: doctorCommand, 'insights-front': insightsFront, config: configCommand, 'hookspath-message': hookspathMessageCli });

/**
 * The `cli` names only bin/proofline may start (A232): writers (a config key, a settings file, a candidates file), the runner of an arbitrary program and the front ends.
 * agent.sh always starts the core with `--pl-argv0` (io.viaAgent), and a model reaches the core only through agent.sh, so from there these are refused.
 */
export const LAUNCHER_ONLY = Object.freeze(['config', 'doctor', 'insights-front', 'hookspath-message', 'discover', 'run-timeout', 'hook-timeouts-apply']);

/** @param {Context} ctx @param {string[]} args the arguments after `cli` */
export function runCli(ctx, args) {
  const name = args[0] ?? '';
  if (ctx.io.viaAgent === true && LAUNCHER_ONLY.includes(name)) throw new ProoflineError(`proofline-core: cli ${name} is not reachable through agent.sh (it belongs to bin/proofline)`, 2, 'USAGE');
  if (!Object.hasOwn(CLI_COMMANDS, name)) throw new ProoflineError(`proofline-core: ${name === '' ? '(no name)' : name} is not a CLI subcommand of the Node core`, 2, 'NOT_MOVED');
  const code = CLI_COMMANDS[name](ctx, args.slice(1));
  ctx.flush();
  return code;
}
