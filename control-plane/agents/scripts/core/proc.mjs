// @ts-check
// The only module of the core, the hook and the CLI that imports node:child_process (ADR 8.1; a static check fails otherwise).
// Every child is counted per program and timed, in process: spawnCounts() and spawnLog() are read by the caller (tests, the benchmark). No
// environment value and no file switches this on or sends it anywhere (an env-named log file would be an arbitrary-file append for any role).
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env as ownEnv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { refuseUntrustedScript } from './tree.mjs';

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
 * @property {AbortSignal} [signal] runAsync: when it aborts, the child (and its process group, with `group`) is stopped
 * @property {boolean} [allowEqualTree] a run worktree's script may run while its whole tree equals the project's (the hook's rollback mode only; see tree.mjs)
 * @property {boolean} [group] the child leads its own process group on POSIX, so a stop reaches everything it started (no `ps` walk); run(): after the child has ended or hit `timeoutMs`, whatever is left in its group is killed
 * @property {NodeJS.Signals} [killSignal] run(): the signal that stops the child at `timeoutMs` (default SIGTERM; a child that ignores it would keep run() waiting, so a caller that cannot wait says SIGKILL)
 */

/**
 * @typedef {object} ProcResult
 * @property {number} status the exit status; 128 + signal number when a signal ended the child; 127 when it could not start
 * @property {Buffer} stdout
 * @property {Buffer} stderr
 * @property {boolean} started false when the program could not be started (not found)
 * @property {boolean} [timedOut] run(): `timeoutMs` expired (whatever status the child then reported)
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
  const refused = refuseUntrustedScript(program, args, options.cwd, options.allowEqualTree === true);
  if (refused !== null) {
    if (options.stdio === 'inherit') { try { writeSync(2, refused); } catch { /* no stderr */ } }
    return { status: 126, stdout: Buffer.alloc(0), stderr: Buffer.from(refused), started: false };
  }
  count(program);
  const t0 = Date.now();
  const r = spawnSync(program, args, /** @type {import('node:child_process').SpawnSyncOptionsWithBufferEncoding & { detached?: boolean }} */ ({
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    stdio: options.stdio ?? 'pipe',
    timeout: options.timeoutMs,
    killSignal: options.killSignal,
    maxBuffer: 1 << 30,
    windowsHide: true,
    detached: options.group === true && process.platform !== 'win32',   // spawnSync accepts it (a group leader); the typings of SpawnSyncOptions omit it
  }));
  logSpawn(program, Date.now() - t0);
  // a group leader has ended or been stopped: nothing it started may go on (a grandchild would keep writing to the descriptors it inherited)
  if (options.group === true && process.platform !== 'win32' && r.pid) { try { process.kill(-r.pid, 'SIGKILL'); } catch { /* the group is empty */ } }
  const timedOut = /** @type {NodeJS.ErrnoException | undefined} */ (r.error)?.code === 'ETIMEDOUT';
  if (r.error && /** @type {NodeJS.ErrnoException} */ (r.error).code === 'ENOENT') {
    return { status: 127, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), started: false };
  }
  const status = r.status ?? 128 + signalNumber(r.signal);
  return { status, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0), started: !r.error || timedOut, timedOut };
}

/**
 * Start a program that outlives this process (a sleep inhibitor): its own session, no descriptors, never waited for. Returns its pid (0 when it did not start).
 * @param {string} program @param {string[]} args @param {NodeJS.ProcessEnv} [env] @returns {number}
 */
export function spawnDetached(program, args, env) {
  count(program);
  const child = spawn(program, args, { env, stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {});
  child.unref();
  return child.pid ?? 0;
}

/**
 * Asynchronous form of run.
 * @param {string} program @param {string[]} args @param {ProcOptions} [options] @returns {Promise<ProcResult>}
 */
export function runAsync(program, args, options = {}) {
  const refused = refuseUntrustedScript(program, args, options.cwd, options.allowEqualTree === true);
  if (refused !== null) return Promise.resolve({ status: 126, stdout: Buffer.alloc(0), stderr: Buffer.from(refused), started: false });
  count(program);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const grouped = options.group === true && process.platform !== 'win32';
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, stdio: options.stdio ?? 'pipe', windowsHide: true, detached: grouped });
    if (grouped) groupLeaders.add(child);
    const stop = () => killTree(child);
    if (options.signal) { if (options.signal.aborted) stop(); else options.signal.addEventListener('abort', stop, { once: true }); }
    /** @type {Buffer[]} */ const out = [];
    /** @type {Buffer[]} */ const err = [];
    child.stdout?.on('data', (d) => out.push(d));
    child.stderr?.on('data', (d) => err.push(d));
    let timer;
    if (options.timeoutMs) timer = setTimeout(() => killTree(child), options.timeoutMs);
    child.on('error', () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      logSpawn(program, Date.now() - t0);
      resolve({ status: 127, stdout: Buffer.concat(out), stderr: Buffer.concat(err), started: false });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      logSpawn(program, Date.now() - t0);
      resolve({ status: code ?? 128 + signalNumber(signal), stdout: Buffer.concat(out), stderr: Buffer.concat(err), started: true });
    });
    // a child that ends before it reads (a stub that exits at once) closes its stdin: the EPIPE of the write is not an error of ours, and without a
    // listener it would be an uncaught exception that ends the whole hook process
    child.stdin?.on('error', () => {});
    if (options.input !== undefined && child.stdin) child.stdin.end(options.input);
  });
}

/**
 * The one place that hands a string to a shell: user commands from config.yaml and user-written task adapters (`/bin/sh -c` on POSIX).
 * @param {string} text @param {ProcOptions} [options] @returns {ProcResult}
 */
export function runUserCommand(text, options = {}) {
  const [program, ...args] = userShellArgv(text);
  return run(program, args, options);
}

/** The program that starts a shell script FILE (a launcher, or a script the user or the project wrote). Never given a command string: see runScript. */
export const SCRIPT_SHELL = 'sh';

/**
 * Start a shell script file: `sh <script> [args]`. The first word must be a file, never an option (`-c` would hand a string to a shell; that is runUserCommand's job alone).
 * The no-shell-logic check refuses the program names sh, bash, awk and sed anywhere else in the Node sources.
 * @param {string[]} argv the script, then its arguments @param {ProcOptions} [options] @returns {ProcResult}
 */
export function runScript(argv, options = {}) {
  if (argv.length === 0 || argv[0] === '' || argv[0].startsWith('-')) throw new Error('runScript starts a script file, not a command string');
  return run(SCRIPT_SHELL, argv, options);
}

/**
 * The argument vector that hands a user's command string to a shell (`/bin/sh -c` on POSIX). For a caller that has to put a wrapper (`timeout`) or its own
 * spawn function in front of the shell; like runUserCommand it is the only place a string meets a shell (the no-shell-logic check refuses any other `sh -c`).
 * @param {string} text @returns {string[]}
 */
export function userShellArgv(text) {
  return [process.platform === 'win32' ? 'sh' : '/bin/sh', '-c', text];
}

/**
 * Run a program with its standard output and error in one string (the shell's `2>&1`, without a shell); the status is the program's. Standard input is
 * `options.stdin` (default 'ignore'); the other `options` are those of run().
 * @param {string} program @param {string[]} args @param {ProcOptions & { stdin?: 'ignore'|'inherit'|'pipe' }} [options] @returns {{ status: number, text: string }}
 */
export function runMerged(program, args, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'proofline-dm-'));
  const f = path.join(dir, 'out');
  const fd = openSync(f, 'w');
  try {
    const r = run(program, args, { ...options, stdio: [options.stdin ?? 'ignore', fd, fd] });
    closeSync(fd);
    return { status: r.status, text: readFileSync(f, 'latin1') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** @type {WeakSet<import('node:child_process').ChildProcess>} */
const groupLeaders = new WeakSet();
const KILL_GRACE_MS = 2000;

/**
 * Stop a child: SIGTERM, and SIGKILL two seconds later when it is still there. A child started with `group` leads its process group,
 * and the whole group is stopped (everything it started, found by the kernel, not by a walk over `ps`); on Windows `taskkill /t`.
 * @param {import('node:child_process').ChildProcess} child
 */
export function killTree(child) {
  if (child.pid === undefined) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    count('taskkill');
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  const target = groupLeaders.has(child) ? -pid : pid;
  try { process.kill(target, 'SIGTERM'); } catch { /* already gone */ }
  const t = setTimeout(() => { try { process.kill(target, 'SIGKILL'); } catch { /* gone */ } }, KILL_GRACE_MS);
  t.unref();
  // the leader is gone: whatever it left in its group has had its TERM; end it now
  child.once('close', () => { clearTimeout(t); if (target < 0) { try { process.kill(target, 'SIGKILL'); } catch { /* none left */ } } });
}

/**
 * @typedef {object} Leader
 * @property {number | undefined} pid the child's pid (undefined when it could not start)
 * @property {Promise<{ status: number, signal: string | null }>} exited resolves when the child has exited and, after a stop, nothing of its group is left
 * @property {(signal?: 'SIGTERM' | 'SIGINT' | 'SIGHUP') => void} stop send the signal to the child's whole process group; KILL follows after the grace unless the group is gone
 */

/** Is `node` found on the PATH of ENV? (the guardian is started as `node` when the launcher found it there, else with this very binary) @param {NodeJS.ProcessEnv} env */
function nodeOnPath(env) {
  for (const d of (env.PATH ?? '').split(path.delimiter)) {
    if (d === '') continue;
    try { accessSync(path.join(d, 'node'), constants.X_OK); return true; } catch { /* not here */ }
  }
  return false;
}

/** The pids below PID in the process tree (children, their children ...), from one `ps` listing; [] when it cannot be listed. @param {number} pid @returns {number[]} */
function descendants(pid) {
  const r = run('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return [];
  /** @type {Map<number, number[]>} */ const kids = new Map();
  for (const l of r.stdout.toString('latin1').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(l);
    if (m) kids.set(Number(m[2]), [...(kids.get(Number(m[2])) ?? []), Number(m[1])]);
  }
  /** @type {number[]} */ const out = [];
  for (let q = [pid]; q.length > 0;) {
    /** @type {number[]} */ const next = [];
    for (const p of q) for (const k of kids.get(p) ?? []) if (!out.includes(k)) { out.push(k); next.push(k); }
    q = next;
  }
  return out;
}

/**
 * The guardian (core/guardian.mjs): the leader of the worker's process group. It starts the real worker in that group (same descriptors, working folder and
 * environment), ignores HUP, INT and TERM itself (the worker, in the same group, gets the same signal from the dispatcher), ends with the worker's status, and
 * polls its owner: when the dispatcher is gone (even by SIGKILL, which runs no handler) it kills its own group, so a worker never outlives its dispatcher (A226).
 * With an orphan spec (a user decision of 2026-11-07) it first starts a closer (below) that outlives the group: once the group is dead it closes the implementer's write
 * window, because the dispatcher that held the window cannot.
 * @param {string[]} argv `<owner pid> <orphan spec as JSON, or -> <program> [args...]`
 */
export function runGuardian(argv) {
  const [ownerText, specText, program, ...args] = argv;
  const owner = Number(ownerText);
  for (const sig of /** @type {const} */ (['SIGHUP', 'SIGINT', 'SIGTERM'])) process.on(sig, () => {});
  const child = spawn(program, args, { stdio: 'inherit', windowsHide: true });
  const ownerGone = () => {
    if (process.ppid !== owner) return true;
    try { process.kill(owner, 0); return false; } catch (e) { return /** @type {NodeJS.ErrnoException} */ (e).code !== 'EPERM'; }
  };
  const poll = setInterval(() => {
    if (!ownerGone()) return;
    if (specText !== undefined && specText !== '-') startCloser(process.pid, specText);
    try { process.kill(-process.pid, 'SIGKILL'); } catch { /* not the leader of a group: only this process */ }
    process.kill(process.pid, 'SIGKILL');
  }, 200);
  child.on('error', () => process.exit(127));
  child.on('close', (code, signal) => { clearInterval(poll); process.exit(code ?? 128 + signalNumber(signal)); });
}

/**
 * What the dispatcher hands the guardian for the case it is killed by SIGKILL while an implementer's write window is open: the working folder, the variables of the
 * worker's environment to take away or put back (the closer must run as the lead, not as the worker), the command that closes the window, and the command that
 * ledgers a note (the text is added as its last argument). No secret travels in it: only the variables the dispatcher itself changed for the worker.
 * @typedef {{ cwd: string, remove: string[], set: Record<string, string>, close: string[], note: string[], noteText: string }} OrphanSpec
 */

/** @param {unknown} v @returns {v is string[]} */
const stringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** @param {string} text @returns {OrphanSpec | null} */
function parseSpec(text) {
  try {
    const o = JSON.parse(text);
    if (typeof o !== 'object' || o === null || typeof o.cwd !== 'string' || !stringList(o.remove) || !stringList(o.close) || o.close.length === 0 || !stringList(o.note) || o.note.length === 0 || typeof o.noteText !== 'string') return null;
    if (typeof o.set !== 'object' || o.set === null || Object.values(o.set).some((x) => typeof x !== 'string')) return null;
    return o;
  } catch { return null; }
}

/**
 * The closer: started by the guardian just before it kills the worker's group, as a process of its own (a new session, so the group kill does not reach it).
 * `<pgid> <spec JSON>`. It waits until no live process is left in the group (zombies do not count), then runs the close command once and ledgers the outcome. A group
 * that is still alive after the wait is killed again; if it will not die the window is NOT closed (the safe side: the worker might still write; the A224 recovery
 * applies). Nothing here prints; the ledger note and the window record are the evidence.
 * @param {string[]} argv
 */
export function runCloser(argv) {
  const pgid = Number(argv[0]);
  const spec = parseSpec(argv[1] ?? '');
  if (spec === null || !Number.isInteger(pgid) || pgid <= 1) return;
  /** @type {NodeJS.ProcessEnv} */ const env = { ...ownEnv };
  for (const k of spec.remove) delete env[k];
  Object.assign(env, spec.set);
  const nap = (/** @type {number} */ ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
  const waitDead = (/** @type {number} */ ms) => { const t0 = Date.now(); while (groupLive(pgid) && Date.now() - t0 < ms) nap(50); return !groupLive(pgid); };
  let dead = waitDead(10000);
  if (!dead) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } dead = waitDead(3000); }
  let result = 'the worker group did not stop in time, so the write window was left open (nothing is attested: tree-inspect applies)';
  if (dead) {
    const r = run(spec.close[0], spec.close.slice(1), { cwd: spec.cwd, env, stdio: ['ignore', 'ignore', 'ignore'] });
    result = r.status === 0 ? 'the worker group is dead and the write window was closed by the guardian' : `the worker group is dead but closing the write window failed (status ${r.status}): tree-inspect applies`;
  }
  run(spec.note[0], [...spec.note.slice(1), `${spec.noteText}; ${result}`], { cwd: spec.cwd, env, stdio: ['ignore', 'ignore', 'ignore'] });
}

/** Start the closer for the group PGID as a detached process of this same Node and guardian script. @param {number} pgid @param {string} specText */
function startCloser(pgid, specText) {
  if (parseSpec(specText) === null) return;
  try {
    const guardian = fileURLToPath(new URL('./guardian.mjs', import.meta.url));
    spawn(process.execPath, [guardian, '--closer', String(pgid), specText], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* no closer: the window stays open and the A224 recovery applies */ }
}

/**
 * Does the process group PGID still hold a live process? A zombie (a killed member whose parent has not collected it yet) does not count. When the table cannot be
 * read the answer is yes (the safe side: the window is not closed on a guess).
 * @param {number} pgid
 */
function groupLive(pgid) {
  try { process.kill(-pgid, 0); } catch (e) { return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM'; }
  const r = run('ps', ['-A', '-o', 'pgid=', '-o', 'stat='], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return true;
  for (const l of r.stdout.toString('latin1').split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)/.exec(l);
    if (m && Number(m[1]) === pgid && !m[2].startsWith('Z')) return true;
  }
  return false;
}

/**
 * Start a long-running child as the leader of its own process group (POSIX: `detached`, which makes it a session and group leader; the leader is the guardian of
 * runGuardian, which starts the real program in that group and kills the group if this process dies; Windows: a tree, stopped with `taskkill /T`, no guardian),
 * for the dispatcher's watchdog (A226). stdio is given by the caller (files, never pipes, so the child never blocks on a reader). `stop()` signals the whole group
 * and every descendant found by a `ps` listing (a grandchild that started a session of its own is not in the group), waits `graceMs` and then kills what is
 * still there with SIGKILL; `exited` resolves once the leader is gone and the group is empty or killed. A child that ends by itself leaves its group alone.
 * `onOrphan` (POSIX only): the guardian's orphan spec, see runCloser.
 * @param {string} program @param {string[]} args @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdio: Array<'ignore'|number>, graceMs?: number, onOrphan?: OrphanSpec }} options @returns {Leader}
 */
export function startLeader(program, args, options) {
  const graceMs = options.graceMs ?? 5000;
  const win = process.platform === 'win32';
  const guardian = fileURLToPath(new URL('./guardian.mjs', import.meta.url));
  const spawned = win ? program : (options.env !== undefined && nodeOnPath(options.env) ? 'node' : process.execPath);
  count(spawned);
  const t0 = Date.now();
  const child = win
    ? spawn(program, args, { cwd: options.cwd, env: options.env, stdio: options.stdio, windowsHide: true })
    : spawn(spawned, [guardian, String(process.pid), options.onOrphan === undefined ? '-' : JSON.stringify(options.onOrphan), program, ...args], { cwd: options.cwd, env: options.env, stdio: options.stdio, windowsHide: true, detached: true });
  const pid = child.pid;
  let leaderGone = false;
  let stopped = false;
  /** @type {number} */ let stopAt = 0;
  /** @type {number[]} */ let extras = [];
  /** @type {NodeJS.Timeout[]} */ const timers = [];
  /** @type {NodeJS.Timeout | undefined} */ let killTimer;
  /** @param {number} p */
  const pidAlive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  const groupAlive = () => {
    if (pid === undefined || win) return false;
    try { process.kill(-pid, 0); return true; } catch { return extras.some(pidAlive); }
  };
  /** @param {NodeJS.Signals} sig */
  const signalGroup = (sig) => {
    if (pid === undefined) return;
    if (win) {
      count('taskkill');
      spawnSync('taskkill', ['/pid', String(pid), '/T', ...(sig === 'SIGKILL' ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true });
      return;
    }
    try { process.kill(-pid, sig); } catch { /* none left */ }
    for (const p of extras) { try { process.kill(p, sig); } catch { /* gone */ } }
  };
  // a dispatcher that ends in a way nothing handles (an uncaught exception, process.exit) takes the worker's group with it (a SIGKILL runs no handler: the guardian does it)
  const onExit = () => { if (!leaderGone && pid !== undefined && !win) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } } };
  process.once('exit', onExit);
  /** @type {Leader['exited']} */
  const exited = new Promise((resolve) => {
    let result = { status: 127, signal: /** @type {string | null} */ (null) };
    const settle = () => {
      process.removeListener('exit', onExit);
      if (killTimer) clearTimeout(killTimer);
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      logSpawn(program, Date.now() - t0);
      resolve(result);
    };
    child.on('error', () => { leaderGone = true; result = { status: 127, signal: null }; settle(); });
    child.on('close', (code, signal) => {
      leaderGone = true;
      result = { status: code ?? 128 + signalNumber(signal), signal };
      if (!stopped || !groupAlive()) { settle(); return; }
      // stopped, and something of the group is still running: it has had its TERM; wait for it, KILL at the end of the grace
      timers.push(setInterval(() => { if (!groupAlive()) settle(); }, 20));
      timers.push(setTimeout(() => { signalGroup('SIGKILL'); timers.push(setTimeout(settle, 200)); }, Math.max(0, graceMs - (Date.now() - stopAt))));
    });
  });
  return {
    pid,
    exited,
    stop(signal = 'SIGTERM') {
      if (stopped) return;
      stopped = true;
      stopAt = Date.now();
      if (!win && pid !== undefined) extras = descendants(pid);
      if (!leaderGone || groupAlive()) signalGroup(signal);
      // the leader may ignore the signal: KILL the group at the end of the grace
      killTimer = setTimeout(() => { if (!leaderGone || groupAlive()) signalGroup('SIGKILL'); }, graceMs);
    },
  };
}

/** @returns {{ total: number, byProgram: Record<string, number> }} */
export function spawnCounts() {
  let total = 0;
  /** @type {Record<string, number>} */ const byProgram = {};
  for (const [k, v] of counts) { byProgram[k] = v; total += v; }
  return { total, byProgram };
}

export function resetSpawnCounts() { counts.clear(); log.length = 0; }
