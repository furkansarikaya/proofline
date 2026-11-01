// @ts-check
// How the hook reaches the project's control plane (ADR 0001 5.1, A194): the hook imports the core of the PROJECT it acts on
// (<root>/.agents/scripts/proofline-core.mjs), as the shell hook ran that project's agent.sh. A command the core owns runs in this very process;
// every other command, a command whose engine is forced to the shell code, and a step that needs a time budget run as `sh agent.sh`
// (a child that can be stopped, and that honours a project's own agent.sh).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isFile, isDir } from './fsx.mjs';

/**
 * @typedef {object} AgentResult
 * @property {number} status the exit status (127: could not start; 124: stopped by the time budget)
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 */

/**
 * @typedef {object} AgentOptions
 * @property {boolean} [keepRole] keep AGENT_ROLE of the hook's environment (default: removed, as the shell hook's `unset AGENT_ROLE`)
 * @property {number} [lockWait] PROOFLINE_LOCK_TIMEOUT for this command (default: the hook's lock wait)
 * @property {number} [budgetMs] stop the command (and the processes it started) after this long; the command then runs as a child
 * @property {string | Buffer} [input] bytes for the command's stdin (default: none)
 * @property {string} [agentPath] the agent.sh to use (default: the one of the hook's run worktree)
 * @property {string} [cwd]
 */

export class Agents {
  /** @param {{ root: string, mainRoot: string, agentPath: string, env: NodeJS.ProcessEnv, lockWait: number, cwd: string }} s */
  constructor(s) {
    this.s = s;
    /** @type {Promise<any> | null} */ this._proc = null;
    /** @type {Promise<any> | null} */ this._core = null;
    this.coreDir = `${s.root}/.agents/scripts`;
  }

  /** The project's proc.mjs (null when the project has none). */
  proc() {
    if (!this._proc) this._proc = isFile(`${this.coreDir}/core/proc.mjs`) ? import(pathToFileURL(`${this.coreDir}/core/proc.mjs`).href).catch(() => null) : Promise.resolve(null);
    return this._proc;
  }

  /** The project's core (null when it is not there: an installed project then fails closed through agent.sh, which prints the reason). */
  core() {
    if (!this._core) {
      this._core = isFile(`${this.coreDir}/proofline-core.mjs`) && isDir(`${this.coreDir}/core`)
        ? import(pathToFileURL(`${this.coreDir}/proofline-core.mjs`).href).catch(() => null) : Promise.resolve(null);
    }
    return this._core;
  }

  /** The engine switch of agent.sh's preamble, for one command: `sh` / `sh:<command>,...` in <main tree>/.agents/local/engine, or the environment. @param {string} command */
  forcedSh(command) {
    const env = this.s.env;
    if (env.PROOFLINE_ENGINE === 'sh') return true;
    if (`,${env.PROOFLINE_ENGINE_SH ?? ''},`.includes(`,${command},`)) return true;
    const e = engineFileValue(this.s.mainRoot);
    return e === 'sh' || (e.startsWith('sh:') && `,${e.slice(3)},`.includes(`,${command},`));
  }

  /**
   * Run one agent.sh command. @param {string[]} argv @param {AgentOptions} [opt] @returns {Promise<AgentResult>}
   */
  async run(argv, opt = {}) {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...this.s.env, PROOFLINE_LOCK_TIMEOUT: String(opt.lockWait ?? this.s.lockWait) };
    if (!opt.keepRole) delete env.AGENT_ROLE;
    const agentPath = opt.agentPath ?? this.s.agentPath;
    const cwd = opt.cwd ?? this.s.cwd;
    const command = argv[0] ?? '';
    const proc = await this.proc();
    if (!proc) return { status: 127, stdout: '', stderr: `proofline: ${this.coreDir}/core/proc.mjs is missing\n`, timedOut: false };
    if (opt.budgetMs === undefined && !this.forcedSh(command)) {
      const core = await this.core();
      if (core && core.commandTable().some((/** @type {{ name: string, moved: boolean }} */ e) => e.name === command && e.moved)) return inProcess(core, argv, { env, cwd, agentPath, input: opt.input });
    }
    const args = [agentPath, ...argv];
    if (opt.budgetMs !== undefined) {
      const budget = await import(pathToFileURL(`${this.coreDir}/core/budget.mjs`).href);
      const r = await budget.runWithBudget(opt.budgetMs / 1000, 'sh', args, { cwd, env, input: opt.input ?? '', stdio: ['pipe', 'pipe', 'pipe'] });
      return { status: r.status, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), timedOut: r.timedOut };
    }
    const r = proc.run('sh', args, { cwd, env, input: opt.input ?? '', stdio: ['pipe', 'pipe', 'pipe'] });
    return { status: r.status, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), timedOut: false };
  }
}

/** @param {string} mainRoot the first line of .agents/local/engine without trailing white space ('' when absent) */
export function engineFileValue(mainRoot) {
  try {
    const t = readFileSync(`${mainRoot}/.agents/local/engine`, 'utf8');
    return (t.split('\n')[0] ?? '').replace(/\s+$/, '');
  } catch { return ''; }
}

/**
 * @param {any} core @param {string[]} argv
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, agentPath: string, input?: string | Buffer }} o @returns {AgentResult}
 */
function inProcess(core, argv, o) {
  /** @type {Buffer[]} */ const out = [];
  /** @type {Buffer[]} */ const err = [];
  const io = {
    env: o.env, cwd: o.cwd, scriptPath: o.agentPath,
    stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) },
    stdinText: o.input === undefined ? undefined : o.input.toString(),
  };
  const status = core.run(argv, io);
  return { status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut: false };
}
