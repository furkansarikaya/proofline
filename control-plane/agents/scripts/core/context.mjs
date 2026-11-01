// @ts-check
// Per-invocation context: the paths, the role, the config, the output. It lives for one `run()` and is dropped at its end, even inside
// one hook process (A203 rejected caching across commands). Output is collected in order and written when the command is done, so a
// command that must be handed back to the shell code has written nothing yet.
import path from 'node:path';
import { Config, bytes } from './config.mjs';
import { ProoflineError } from './errors.mjs';
import { projectRoot, sharedRoot } from './paths.mjs';

/**
 * @typedef {object} Io
 * @property {NodeJS.ProcessEnv} env
 * @property {string} cwd
 * @property {{ write(chunk: Buffer): unknown }} stdout
 * @property {{ write(chunk: Buffer): unknown }} stderr
 * @property {NodeJS.ReadableStream | null} [stdin]
 * @property {boolean} [isProcess] true when stdout and stderr are this process's own descriptors (the CLI): a child may inherit them
 * @property {string} [argv0] agent.sh's own $0 as typed, already checked to name the core's sibling agent.sh (see main() in proofline-core.mjs)
 * @property {string} [scriptPath] the file whose folder is <root>/.agents/scripts (agent.sh or proofline-core.mjs); default: this core
 */

/** @param {string} role */
export function canonRole(role) {
  switch (role) {
    case 'full_lifecycle': return 'lead';
    case 'implementation_worker': return 'implementer';
    case 'independent_reviewer': return 'reviewer';
    case 'independent_qa': return 'qa';
    case 'independent_verifier': return 'verifier';
    default: return role;
  }
}

/** @param {string} role */
export function validRole(role) {
  return ['lead', 'task_author', 'explorer', 'architect', 'data_architect', 'designer', 'qa', 'implementer', 'reviewer', 'security_reviewer', 'verifier'].includes(role);
}

export class Context {
  /** @param {Io} io @param {string} scriptPath */
  constructor(io, scriptPath) {
    this.io = io;
    this.env = io.env;
    this.cwd = io.cwd;
    this.scriptPath = scriptPath;
    this.scriptDir = path.dirname(scriptPath);
    this.root = projectRoot(scriptPath, this.env, this.cwd);
    this.agents = `${this.root}/.agents`;
    this.configFile = `${this.agents}/config.yaml`;
    this.scripts = `${this.agents}/scripts`;
    this.rawRole = this.env.AGENT_ROLE ?? '';
    this.role = canonRole(this.rawRole === '' ? 'lead' : this.rawRole);
    /** @type {Config | null} */ this._config = null;
    /** @type {string | null} */ this._shared = null;
    /** @type {Array<['out' | 'err', Buffer]>} */ this.chunks = [];
    /** @type {Map<string, unknown>} */ this.memo = new Map();
    /** fp_fast of agent.sh: 'no' (always hash), 'yes' (read-only commands: use the fingerprint cache), 'refresh' (sealing commands: hash, then store) */
    this.fpMode = 'no';
    /** ctp_base of agent.sh: set by delivered mode; task paths are then measured from this commit instead of HEAD */
    this.ctpBase = '';
  }

  /**
   * Read once per invocation: the value for KEY, made by MAKE on the first call. The context lives for one command, so nothing is cached
   * across commands (A203). A writer drops what it changed with forget().
   * @template T @param {string} key @param {() => T} make @returns {T}
   */
  once(key, make) {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return /** @type {T} */ (this.memo.get(key));
  }

  /** Drop the remembered values whose key starts with PREFIX (every writer calls it, like sv_reset). @param {string} prefix */
  forget(prefix) {
    for (const k of [...this.memo.keys()]) if (k.startsWith(prefix)) this.memo.delete(k);
  }

  /** The config, read once. */
  config() {
    if (!this._config) this._config = Config.load(this.configFile);
    return this._config;
  }

  /** The main working tree (`sr_main`). */
  sharedMain() {
    if (this._shared === null) this._shared = sharedRoot(this.root, this.env);
    return this._shared;
  }

  /** `run_dir ID` @param {string} id */
  runDir(id) { return `${this.root}/.agents/runs/${id}`; }

  /** @param {string} text a byte string */
  out(text) { this.chunks.push(['out', Buffer.from(text, 'latin1')]); }
  /** @param {string} text a byte string */
  err(text) { this.chunks.push(['err', Buffer.from(text, 'latin1')]); }

  /** Write what was collected, in order. */
  flush() {
    for (const [stream, buf] of this.chunks) (stream === 'out' ? this.io.stdout : this.io.stderr).write(buf);
    this.chunks = [];
  }

  /** Forget what was collected (the command is handed to the shell code). */
  discard() { this.chunks = []; }

  /** The environment every child of the shell code inherits from agent.sh's own start (lines 8-10, 27). */
  childEnv() {
    return { ...this.env, LC_ALL: 'C', RTK_DISABLED: '1', PROOFLINE_SHARED_ROOT: this.sharedMain() };
  }

  /** Print the message of an error like `fail` does. @param {ProoflineError} e */
  printError(e) { this.err(`${e.message}\n`); }
}

export { bytes };
