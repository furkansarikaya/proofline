// @ts-check
// The only module of the core, the hook and the CLI that imports node:child_process (ADR 8.1; a static check fails otherwise).
// Every child is counted per program and timed, in process: spawnCounts() and spawnLog() are read by the caller (tests, the benchmark). No
// environment value and no file switches this on or sends it anywhere (an env-named log file would be an arbitrary-file append for any role).
import { spawn, spawnSync } from 'node:child_process';

/** @type {Map<string, number>} */
const counts = new Map();

/** @param {string} program */
function count(program) { counts.set(program, (counts.get(program) ?? 0) + 1); }

/** @type {Array<{ program: string, ms: number }>} */
const log = [];

/** @param {string} program @param {number} ms */
function logSpawn(program, ms) { log.push({ program, ms }); }

/** One entry per child started so far (program, milliseconds). @returns {Array<{ program: string, ms: number }>} */
export function spawnLog() { return log.slice(); }

/**
 * @typedef {object} ProcOptions
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {Buffer|string} [input] bytes written to the child's stdin
 * @property {'pipe'|'inherit'|'ignore'|Array<'pipe'|'inherit'|'ignore'|number>} [stdio]
 * @property {number} [timeoutMs]
 * @property {boolean} [group] runAsync on POSIX: the child leads its own process group, and the time limit stops the whole group (the processes it started too)
 */

/**
 * @typedef {object} ProcResult
 * @property {number} status the exit status; 128 + signal number when a signal ended the child; 127 when it could not start
 * @property {Buffer} stdout
 * @property {Buffer} stderr
 * @property {boolean} started false when the program could not be started (not found)
 * @property {boolean} [timedOut] runAsync: the time limit stopped the child
 */

/** @param {string|null} signal */
function signalNumber(signal) {
  if (!signal) return 0;
  const n = /** @type {Record<string, number>} */ (({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15 }))[signal];
  return n ?? 1;
}

/**
 * Run a program to completion (`shell: false`). A program that is not found gives status 127, like `sh`.
 * @param {string} program @param {string[]} args @param {ProcOptions} [options] @returns {ProcResult}
 */
export function run(program, args, options = {}) {
  count(program);
  const t0 = Date.now();
  const r = spawnSync(program, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    stdio: options.stdio ?? 'pipe',
    timeout: options.timeoutMs,
    maxBuffer: 1 << 30,
    windowsHide: true,
  });
  logSpawn(program, Date.now() - t0);
  if (r.error && /** @type {NodeJS.ErrnoException} */ (r.error).code === 'ENOENT') {
    return { status: 127, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), started: false };
  }
  const status = r.status ?? 128 + signalNumber(r.signal);
  return { status, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0), started: !r.error };
}

/**
 * Asynchronous form of run.
 * @param {string} program @param {string[]} args @param {ProcOptions} [options] @returns {Promise<ProcResult>}
 */
export function runAsync(program, args, options = {}) {
  count(program);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const leader = options.group === true && process.platform !== 'win32';
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, stdio: options.stdio ?? 'pipe', windowsHide: true, detached: leader });
    /** @type {Buffer[]} */ const out = [];
    /** @type {Buffer[]} */ const err = [];
    child.stdout?.on('data', (d) => out.push(d));
    child.stderr?.on('data', (d) => err.push(d));
    let timer;
    let timedOut = false;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        if (leader && child.pid !== undefined) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } } else killTree(child);
      }, options.timeoutMs);
    }
    child.on('error', () => {
      if (timer) clearTimeout(timer);
      logSpawn(program, Date.now() - t0);
      resolve({ status: 127, stdout: Buffer.concat(out), stderr: Buffer.concat(err), started: false, timedOut });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      logSpawn(program, Date.now() - t0);
      resolve({ status: code ?? 128 + signalNumber(signal), stdout: Buffer.concat(out), stderr: Buffer.concat(err), started: true, timedOut });
    });
    if (options.input !== undefined && child.stdin) child.stdin.end(options.input);
  });
}

/**
 * The one place that hands a string to a shell: user commands from config.yaml and user-written task adapters (`/bin/sh -c` on POSIX).
 * @param {string} text @param {ProcOptions} [options] @returns {ProcResult}
 */
export function runUserCommand(text, options = {}) {
  return run(process.platform === 'win32' ? 'sh' : '/bin/sh', ['-c', text], options);
}

/** Kill a child and, on POSIX, its process group when it leads one. @param {import('node:child_process').ChildProcess} child */
export function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    count('taskkill');
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
}

/** @returns {{ total: number, byProgram: Record<string, number> }} */
export function spawnCounts() {
  let total = 0;
  /** @type {Record<string, number>} */ const byProgram = {};
  for (const [k, v] of counts) { byProgram[k] = v; total += v; }
  return { total, byProgram };
}

export function resetSpawnCounts() { counts.clear(); log.length = 0; }
