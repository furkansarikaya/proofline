// @ts-check
// proofline-core: the Node form of the control plane (ADR 0001). Entry: `node proofline-core.mjs <command> [args]`, and
// `run(argv, io)` for in-process callers. It does what agent.sh does, in the same order: resolve the root, validate the role, apply the
// worktree rule, check the role gate, take the locks of a locking command, run the handler, release the locks. A command it does not
// own yet is run by the shell code through proc.mjs (the bridge; counted).
import './core/node-check.mjs';
import { accessSync, constants, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './core/commands/cli.mjs';
import { HANDLERS } from './core/commands/moved.mjs';
import { COMMAND_NAMES, READ_ONLY_COMMANDS } from './core/commands/names.mjs';
import { bytes } from './core/config.mjs';
import { Context, validRole } from './core/context.mjs';
import { BridgeToShell, ProoflineError } from './core/errors.mjs';
import { LockSet, takeCommandLocks, takesLocks } from './core/lock.mjs';
import { isDir, isFile } from './core/paths.mjs';
import * as proc from './core/proc.mjs';

/** @typedef {import('./core/context.mjs').Io} Io */

const READ_ONLY = new Set(READ_ONLY_COMMANDS);

/**
 * @typedef {object} CommandEntry
 * @property {string} name
 * @property {boolean} readOnly in agent.sh's read_only_commands (any role may run it)
 * @property {boolean} moved a Node handler owns it; the others are run by the shell code through the bridge
 */

/** @type {CommandEntry[]} */
const COMMANDS = COMMAND_NAMES.map((name) => ({ name, readOnly: READ_ONLY.has(name), moved: Object.hasOwn(HANDLERS, name) }));
const ROLE_NAMES = ['lead', 'task_author', 'explorer', 'architect', 'data_architect', 'designer', 'qa', 'implementer', 'reviewer', 'security_reviewer', 'verifier'];

/**
 * The 132 commands of agent.sh, in the order of its dispatch: name, readOnly (any role), the roles that may run it, moved (a Node handler
 * owns it; the others go through the bridge).
 * @returns {Array<CommandEntry & { roles: string[] }>}
 */
export function commandTable() {
  return COMMANDS.map((e) => ({ ...e, roles: ROLE_NAMES.filter((r) => commandAllowed(r, e.name)) }));
}

/** The commands every role may run besides the read-only ones, per role (agent.sh lines 8929-8933). @param {string} role @returns {string[] | null} null: all */
function extraCommands(role) {
  switch (role) {
    case 'lead': return null;
    case 'reviewer': case 'security_reviewer': case 'qa': case 'verifier': return ['record', 'gate', 'submit'];
    case 'implementer': return ['record', 'submit', 'worker-evidence', 'handoff'];
    default: return ['record', 'submit'];
  }
}

/**
 * `cmd_allowed` under the role case of agent.sh: may this (canonical, valid) role run this command?
 * @param {string} role @param {string} command
 */
export function commandAllowed(role, command) {
  const extra = extraCommands(role);
  return extra === null || READ_ONLY.has(command) || extra.includes(command);
}

/** @param {string} id */
const validTaskId = (id) => /^[A-Za-z0-9_-]+$/.test(id);

/**
 * Run the shell code for a command (the bridge, and the worktree rule). The engine is forced to the shell so that nothing loops.
 * @param {Context} ctx @param {string[]} argv @param {{ cwd?: string, script?: string, force?: boolean }} [opt]
 */
function viaShell(ctx, argv, opt = {}) {
  // the bridge exists for the shell-error-text fallbacks of the commands this core owns, never for another command
  if (argv[0] === undefined || !Object.hasOwn(HANDLERS, argv[0])) throw new ProoflineError('proofline-core: the bridge only serves the commands of the Node core', 2, 'NOT_MOVED');
  ctx.discard();
  const env = opt.force === false ? { ...ctx.env } : { ...ctx.env, PROOFLINE_ENGINE: 'sh' };
  const script = opt.script ?? path.join(ctx.scriptDir, 'agent.sh');
  const own = ctx.io.isProcess === true;
  const r = proc.run('sh', [script, ...argv], { cwd: opt.cwd ?? ctx.cwd, env, stdio: own ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
  if (!own) {
    if (r.stdout.length) ctx.io.stdout.write(r.stdout);
    if (r.stderr.length) ctx.io.stderr.write(r.stderr);
  }
  return r.status;
}

/**
 * One command invocation.
 * @param {string[]} argv the arguments after agent.sh
 * @param {Io} io
 * @returns {number} the exit status
 */
export function run(argv, io) {
  const ctx = new Context(io, io.scriptPath ?? fileURLToPath(import.meta.url));
  const locks = new LockSet(ctx);
  try {
    return dispatch(ctx, locks, argv);
  } catch (e) {
    if (e instanceof BridgeToShell) return viaShell(ctx, argv);
    if (e instanceof ProoflineError) { ctx.printError(e); ctx.flush(); return e.exitCode; }
    // An unexpected exception is a bug of the core: it fails closed (message and stack on stderr, a non-zero status), it is never answered by
    // the shell code. Only the enumerated shell-error-text shapes (BridgeToShell) are handed back.
    ctx.discard();
    const text = e instanceof Error ? (e.stack ?? e.message) : String(e);
    io.stderr.write(Buffer.from(`proofline: internal error in ${argv[0] ?? ''}: ${text}\n`));
    return 70;
  } finally {
    locks.releaseAll();
  }
}

/** @param {Context} ctx @param {LockSet} locks @param {string[]} argv */
function dispatch(ctx, locks, argv) {
  const command = argv[0] ?? '';
  const args = argv.slice(1);
  // the CLI-only subcommands (closed set, read-only; see core/commands/cli.mjs) are not agent.sh commands and take neither role gate nor bridge
  if (command === 'cli') return runCli(ctx, args);
  const handler = Object.hasOwn(HANDLERS, command) ? HANDLERS[command] : undefined;
  // agent.sh parses the config at its start: a config that exists but cannot be read is the shell's (awk's) error
  if (handler && isFile(ctx.configFile)) { try { accessSync(ctx.configFile, constants.R_OK); } catch { throw new BridgeToShell('config unreadable'); } }
  if (!validRole(ctx.role)) throw new ProoflineError(`invalid execution role: ${bytes(ctx.rawRole)}`, 1);
  // A169: a run that lives in its own worktree is served by that worktree's agent.sh (only for a command this core owns)
  const id = args[0];
  if (handler && id !== undefined && validTaskId(id) && !isExisting(`${ctx.root}/.agents/runs/${id}`)
    && isDir(`${ctx.root}/.agents/local/worktrees/${id}/.agents/runs/${id}`) && isFile(`${ctx.root}/.agents/local/worktrees/${id}/.agents/scripts/agent.sh`)) {
    const wt = `${ctx.root}/.agents/local/worktrees/${id}`;
    return viaShell(ctx, argv, { cwd: wt, script: '.agents/scripts/agent.sh', force: false });
  }
  // the role gate comes first, for every command
  if (!commandAllowed(ctx.role, command)) throw new ProoflineError(`command denied for ${ctx.role}: ${command}`, 1);
  // This entry is not a second front door to agent.sh: it runs the commands it owns and nothing else. An unmoved command is run with agent.sh.
  if (!handler) throw new ProoflineError(`proofline-core: ${command === '' ? '(no command)' : command} is not a command of the Node core; run it with agent.sh`, 2, 'NOT_MOVED');
  if (takesLocks(command, args, ctx.role, READ_ONLY.has(command))) takeCommandLocks(locks, ctx, command, args);
  const code = handler(ctx, args);
  ctx.flush();
  return code;
}

/** `[ -e PATH ]` @param {string} p */
function isExisting(p) { try { realpathSync(p); return true; } catch { return false; } }

/** A synchronous writer for a descriptor of this process: output keeps its order with a child that inherits the descriptor. @param {number} fd */
function fdWriter(fd) {
  return {
    /** @param {Buffer} chunk */
    write(chunk) {
      let off = 0;
      while (off < chunk.length) {
        try { off += writeSync(fd, chunk, off); } catch (e) {
          const code = /** @type {NodeJS.ErrnoException} */ (e).code;
          if (code === 'EAGAIN') continue;
          return false; // EPIPE: the reader went away
        }
      }
      return true;
    },
  };
}

/** The entry point: the arguments of the process, its descriptors, its environment. @param {string} scriptPath */
export function main(scriptPath) {
  const io = {
    env: process.env, cwd: process.cwd(), stdout: fdWriter(1), stderr: fdWriter(2), stdin: process.stdin, isProcess: true,
    scriptPath: path.resolve(scriptPath),
  };
  return run(process.argv.slice(2), io);
}

const entry = process.argv[1];
if (entry && (() => { try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })()) {
  process.exitCode = main(entry);
}
