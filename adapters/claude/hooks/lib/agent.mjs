// @ts-check
// How the hook reaches the project's control plane (ADR 0001 5.1, A194): the hook imports the core of the PROJECT it acts on
// (<root>/.agents/scripts/proofline-core.mjs), as the shell hook ran that project's agent.sh. A command the core owns runs in this very process;
// every other command, a command whose engine is forced to the shell code, and a step that needs a time budget run as `sh agent.sh`
// (a child that can be stopped, and that honours a project's own agent.sh).
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
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
 * @property {{ session: string, time: number, sha256: string, text: string }} [promptCapture] the capture of the prompt this hook is handling (core latestCapture then means exactly this one)
 */

export class Agents {
  /** @param {{ root: string, mainRoot: string, agentPath: string, env: NodeJS.ProcessEnv, lockWait: number, cwd: string }} s */
  constructor(s) {
    this.s = s;
    /** @type {Promise<any> | null} */ this._proc = null;
    /** @type {Promise<any> | null} */ this._core = null;
    this.abandoned = false;
  }

  /** The scripts folder of the MAIN tree: the code the hook runs, also for a session rooted in a run worktree (a worktree's copy is tracked content a task could rewrite). */
  get coreDir() { return `${this.s.mainRoot}/.agents/scripts`; }

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
   * Run one agent.sh command. A command the core owns runs from the PROJECT's core in this process (or, with a time budget, on a worker thread the
   * hook stops waiting for); the run worktree only decides which tree's data it works on (the script path names the root), never whose code runs.
   * A command run as `sh agent.sh` (not owned by the core, or the engine forced to the shell) runs a worktree's agent.sh only when its whole
   * script tree is byte-identical to the project's own. @param {string[]} argv @param {AgentOptions} [opt] @returns {Promise<AgentResult>}
   */
  async run(argv, opt = {}) {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...this.s.env, PROOFLINE_LOCK_TIMEOUT: String(opt.lockWait ?? this.s.lockWait) };
    if (!opt.keepRole) delete env.AGENT_ROLE;
    const agentPath = opt.agentPath ?? this.s.agentPath;
    const cwd = opt.cwd ?? this.s.cwd;
    const command = argv[0] ?? '';
    if (!this.forcedSh(command)) {
      const core = await this.core();
      if (core && core.commandTable().some((/** @type {{ name: string, moved: boolean }} */ e) => e.name === command && e.moved)) {
        const io = { env, cwd, scriptPath: agentPath, stdinText: opt.input === undefined ? undefined : opt.input.toString(), promptCapture: opt.promptCapture };
        if (opt.budgetMs === undefined) return inProcess(core, argv, io);
        return this.onWorker(argv, io, opt.budgetMs);
      }
    }
    const proc = await this.proc();
    if (!proc) return { status: 127, stdout: '', stderr: `proofline: ${this.coreDir}/core/proc.mjs is missing\n`, timedOut: false };
    const args = [agentPath, ...argv];
    if (opt.budgetMs !== undefined) {
      const budget = await import(pathToFileURL(`${this.coreDir}/core/budget.mjs`).href);
      const r = await budget.runWithBudget(opt.budgetMs / 1000, 'sh', args, { cwd, env, input: opt.input ?? '', stdio: ['pipe', 'pipe', 'pipe'], allowEqualTree: true });
      return { status: r.status, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), timedOut: r.timedOut };
    }
    const r = proc.run('sh', args, { cwd, env, input: opt.input ?? '', stdio: ['pipe', 'pipe', 'pipe'], allowEqualTree: true });
    return { status: r.status, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), timedOut: false };
  }

  /** @param {string[]} argv @param {object} io @param {number} budgetMs @returns {Promise<AgentResult>} */
  onWorker(argv, io, budgetMs) {
    // the shared flag tells the worker the hook stopped waiting (a child the worker's bridge started cannot be killed): the core then writes no record
    const cancel = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { coreUrl: pathToFileURL(`${this.coreDir}/proofline-core.mjs`).href, argv, io, cancel } });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        Atomics.store(cancel, 0, 1);
        this.abandoned = true; // the process ends with process.exit: a worker stuck in a synchronous wait cannot be stopped sooner
        void worker.terminate();
        resolve({ status: 124, stdout: '', stderr: '', timedOut: true });
      }, budgetMs);
      worker.on('message', (/** @type {{ status: number, stdout: Buffer, stderr: Buffer }} */ m) => {
        clearTimeout(timer);
        resolve({ status: m.status, stdout: Buffer.from(m.stdout).toString('utf8'), stderr: Buffer.from(m.stderr).toString('utf8'), timedOut: false });
      });
      worker.on('error', (e) => { clearTimeout(timer); resolve({ status: 70, stdout: '', stderr: `proofline: internal error in ${argv[0]}: ${e}\n`, timedOut: false }); });
    });
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
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, scriptPath: string, stdinText?: string, promptCapture?: object }} given @returns {AgentResult}
 */
function inProcess(core, argv, given) {
  /** @type {Buffer[]} */ const out = [];
  /** @type {Buffer[]} */ const err = [];
  const io = { ...given, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) } };
  const status = core.run(argv, io);
  return { status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut: false };
}
