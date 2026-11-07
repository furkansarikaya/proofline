// @ts-check
// The specialist runner (D6, D7, D8; A226: the former scripts/dispatch.sh). Runs ONE specialist step headless on the runtime the execution policy resolves. The
// specialist reports through `agent.sh submit` (the script builds the header, fingerprint and hashes and records the result); the dispatcher reads the
// submission status and never parses the final message.
//
//   node proofline-core.mjs dispatch <TASK-ID> <role> [--focus F] [--prompt-file F] [--model M] [--effort E] [--runtime RT]
//   node proofline-core.mjs dispatch codex-profile <TASK-ID>      (the Codex permission profile of a run; tests/real-session/codex-sandbox.sh)
//
// 1 decision: `decide` runs IN PROCESS with the dispatcher's authority (core/decide.mjs); nothing here re-decides it.
// 2 prompt: the role's instructions (stable prefix), then the task-specific suffix (header, optional lines, --prompt-file), which must fit the decision's
//   context_bytes (never truncated).
// 3 run: codex `exec` (a permission profile that lists the writable paths one by one, A199), claude `-p` running the generated agent (`--agent proofline-<role>`
//   from .claude/agents/, else `--agents` JSON built from .agents/roles/<role>.md and .agents/tools.conf; never the Agent/Task tools), or
//   dispatch.command_template.<runtime> (D8). The runtime is a child in its own process group under a watchdog: TERM at the timeout (config
//   dispatch.timeout_seconds, default 5400, times timeouts.scale; pipelines.<CLASS>.dispatch_timeout_seconds of the run's class wins, A171), KILL after the
//   grace (5 s) for whatever is still there. The implementer, and the designer while handoff is IMPLEMENTING, are bracketed by `window-open` / `window-close`;
//   every other role must leave the product tree unchanged. A change to .git/config or to HEAD during the step is BLOCKED for every role.
// 4 the last message is saved as dispatch/<NNN>-<role>-<runtime>.md in the run (a log, never parsed); the runtime gets PROOFLINE_AGENT (a per-attempt token) and
//   PROOFLINE_FOCUS in its environment, so its `agent.sh submit` writes .agents/local/submissions/<token>.status. No valid submission: the step is run once more
//   with the rejection in its prompt, then BLOCKED. While a step runs, dispatch/<NNN>-<role>-<runtime>.running says so (A124).
// Failover (D7) on a runtime failure (limit, quota, rate limit, 429, missing binary, auth error), never on a task failure; a transient network error is retried on
// the same runtime (A200). A timeout (124) writes dispatch/RESUME-<role>[-focus].md, which the next dispatch of the same role and focus carries in its prompt (A171).
// A dispatch stopped from outside (HUP, INT, TERM): the signal goes to the worker's group, the dispatcher waits for it, ledgers the interruption, writes the RESUME
// note, CLOSES the implementer's write window with the signal status (128 + signal; a user decision of 2026-11-07, A226: the safe side, the next dispatch continues the
// step) and exits 143. The window is closed only after the worker's group has exited, so nothing can still write. A SIGKILL of the dispatcher runs no handler: the
// worker's guardian (core/guardian.mjs, proc.mjs) kills the group, and then a closer closes the window with status 137 the same way (exactly once, only a window this
// dispatcher opened). Remaining gaps: the guardian killed too, or the dispatcher killed after its worker has exited and before it closes the window (no guardian is
// left): no one closes the window and the A224 recovery applies; a grandchild that started a session of its own
// (it can outlive the kill and write after the close), and Windows (no guardian).
// Exit: 0 recorded | 1 task failure or record rejected | 2 usage/config | 5 NEEDS_INPUT | 6 BLOCKED | 124 timeout | 143 stopped from outside.
// Runtime binaries: PROOFLINE_CODEX_BIN, PROOFLINE_CLAUDE_BIN (tests use fake runtimes). The watchdog's grace and the shortest timeout are options of
// startDispatch(), not environment values.
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytes } from './config.mjs';
import { Context } from './context.mjs';
import { dispatcherIo } from './decide.mjs';
import * as dt from './dispatchtext.mjs';
import { gitState } from './gitstate.mjs';
import { isDir, isFile } from './paths.mjs';
import * as proc from './proc.mjs';
import { commandV, runtimeDetect } from './runtimedetect.mjs';
import { sectionValue } from './records.mjs';
import { tmScaled } from './timeouts.mjs';
import { pipelineClassValid } from './signals.mjs';

/** @typedef {import('./context.mjs').Io} Io */
/** @typedef {(argv: string[], io: Io) => number} Runner */

/**
 * @typedef {object} DispatchOptions
 * @property {Runner} run runs one command of the Node core in process (proofline-core.mjs `run`)
 * @property {number} [graceMs] the watchdog's grace between TERM and KILL (default 5000)
 * @property {number} [minTimeoutSeconds] the shortest step time (default 30; tests lower it)
 */

const NET_BACKOFF_CAP = 300;
const SIGNUM = /** @type {Record<string, number>} */ ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 });

/** A stop with a status, like the shell's `exit N`. */
class Exit extends Error {
  /** @param {number} code */
  constructor(code) { super(`exit ${code}`); this.name = 'DispatchExit'; this.code = code; }
}

/**
 * What the lead reads when `window-open` refuses a worker dispatch (a dispatch killed from outside left its edits unattested, A224): the recovery is one question to
 * the user. The lead texts and tests/skills/proofline-lead.test.mjs hold this text.
 * @param {string} id @param {string} role
 */
export function windowOpenRefusedText(id, role) {
  return `dispatch: window-open refused; ${role} not started. If an earlier dispatch of this step was killed from outside (exit 124 or Terminated), its edits are unattested: run agent.sh tree-inspect ${id} and put ONE question to the user (keep the tree with tree-accept, or discard the listed files); do not dispatch again, discard or edit by hand before the answer (A224)`;
}

/** @param {number} n */
const pad3 = (n) => String(n).padStart(3, '0');
/** @param {string} p */
const readLatin1 = (p) => readFileSync(p, 'latin1');
/** @param {string} p */
const sizeOf = (p) => { try { return statSync(p).size; } catch { return 0; } };
/** @param {string} s a byte string @returns {string} the same bytes as the text an argument list carries */
const asArg = (s) => Buffer.from(s, 'latin1').toString('utf8');
/** @param {string} text */
const lastLines = (text) => dt.tailLines(text, 1e9);
const nowEpoch = () => Math.floor(Date.now() / 1000);
const nowIso = () => new Date(nowEpoch() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** POSIX `cksum` of the bytes: the CRC the explorer's resume note is named by. @param {Buffer} buf */
export function cksum(buf) {
  let crc = 0;
  /** @param {number} b */
  const step = (b) => {
    crc ^= b << 24;
    for (let k = 0; k < 8; k++) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1);
    crc >>>= 0;
  };
  for (const b of buf) step(b);
  let len = buf.length;
  while (len > 0) { step(len & 0xff); len = Math.floor(len / 256); }
  return String((~crc) >>> 0);
}

/**
 * Start a dispatch. `done` resolves with the exit status; `interrupt(signal)` is what a HUP, INT or TERM to the dispatcher calls.
 * @param {Io} io @param {string[]} argv the arguments after `dispatch` @param {DispatchOptions} options
 * @returns {{ done: Promise<number>, interrupt: (signal: 'SIGHUP' | 'SIGINT' | 'SIGTERM') => void }}
 */
export function startDispatch(io, argv, options) {
  const d = new Dispatcher(io, argv, options);
  return { done: d.main(), interrupt: (s) => d.interrupt(s) };
}

class Dispatcher {
  /** @param {Io} io @param {string[]} argv @param {DispatchOptions} options */
  constructor(io, argv, options) {
    this.io = io;
    this.argv = argv;
    this.o = options;
    this.env = io.env;
    this.scriptPath = io.scriptPath ?? '';
    const ctx = new Context(io, this.scriptPath);
    this.root = ctx.root;
    this.scriptDir = ctx.scriptDir;
    this.graceMs = options.graceMs ?? 5000;
    this.minTimeout = options.minTimeoutSeconds ?? 30;
    this.id = ''; this.role = ''; this.focus = ''; this.promptFile = ''; this.oModel = ''; this.oEffort = ''; this.oRuntime = '';
    this.run = ''; this.work = '';
    this.attempts = 0; this.running = ''; this.noout = false;
    this.mIn = ''; this.mOut = ''; this.mTot = ''; this.mTurns = ''; this.mRt = '';
    this.rt = ''; this.model = ''; this.effort = ''; this.tmpl = ''; this.pm = ''; this.token = ''; this.out = ''; this.log = '';
    this.status = 0; this.seqN = 0; this.retryNote = ''; this.aRuntime = ''; this.aRtReason = '';
    this.timeoutS = 0; this.t0 = nowEpoch();
    this.resumeFile = ''; this.resumeOne = '';
    /** @type {import('./proc.mjs').Leader | null} */ this.worker = null;
    /** @type {'SIGHUP' | 'SIGINT' | 'SIGTERM' | null} */ this.interrupted = null;
    /** @type {(() => void) | null} */ this.wake = null;
    this.writesCode = false;
    /** the fingerprint window-open printed (the implementer's bracket) */ this.before = '';
    /** this dispatcher opened a write window and has not closed it yet */ this.windowOpen = false;
  }

  // ---- output and the commands of the core ------------------------------------------------------------------------------------------------------
  /** @param {string} text a byte string */
  stdout(text) { this.io.stdout.write(Buffer.from(text, 'latin1')); }
  /** @param {string} text a byte string */
  stderr(text) { this.io.stderr.write(Buffer.from(text, 'latin1')); }

  /**
   * One command of the Node core in process, with the dispatcher's authority (the nonce of the shell dispatcher, A171). `all` is stdout and stderr in the order the
   * command wrote them (what a terminal showed when both went to it).
   * @param {string[]} argv @returns {{ code: number, out: string, err: string, all: string }}
   */
  cmd(argv) {
    /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = []; /** @type {Buffer[]} */ const all = [];
    const io = dispatcherIo({ env: this.env, cwd: this.io.cwd, stdout: { write: (b) => { out.push(b); all.push(b); } }, stderr: { write: (b) => { err.push(b); all.push(b); } }, scriptPath: this.scriptPath, isProcess: false });
    const code = this.o.run(argv, io);
    return { code, out: Buffer.concat(out).toString('latin1'), err: Buffer.concat(err).toString('latin1'), all: Buffer.concat(all).toString('latin1') };
  }

  /** A fresh context: RUN.yaml, the config and the files are read as they are now. */
  ctx() { return new Context(this.io, this.scriptPath); }

  /** @param {string} text @returns {Exit} */
  die(text) { this.stderr(`dispatch: ${text}\n`); return new Exit(2); }

  usage() {
    this.stderr('usage: dispatch.sh <TASK-ID> <role> [--focus F] [--prompt-file F] [--model M] [--effort E] [--runtime RT]\n');
    return new Exit(2);
  }

  /** @param {string} name @param {string} value */
  tok(name, value) { if (!dt.validToken(value)) throw this.die(`invalid value for ${name}: '${bytes(value)}'`); }

  /** The ledgered note of the dispatcher (failures never stop the dispatch except where the caller says so). @param {string} text @returns {boolean} */
  note(text) { const r = this.cmd(['ledger-note', this.id, text]); if (r.code !== 0) this.stderr(r.err); return r.code === 0; }

  /** @param {string} reason @returns {Exit} result-protocol block on stdout, ledgered */
  blocked(reason) {
    this.stdout(`ROLE: ${this.role}\nTASK: ${this.id}\nRESULT: BLOCKED\nBLOCKED_REASON: ${reason}\n`);
    this.note(`dispatch blocked role=${this.role} reason=${reason}`);
    return new Exit(6);
  }

  /** The config scalar KEY (a dotted path), '' when absent. @param {string} key */
  cfg(key) { return this.ctx().config().get(key, ''); }

  /** @param {string} p */
  rel(p) { return p.startsWith(`${this.root}/`) ? p.slice(this.root.length + 1) : p; }

  // ---- signals ----------------------------------------------------------------------------------------------------------------------------------
  /** HUP, INT or TERM to the dispatcher: the worker's group gets the same signal, a pending wait ends. @param {'SIGHUP' | 'SIGINT' | 'SIGTERM'} signal */
  interrupt(signal) {
    if (this.interrupted === null) this.interrupted = signal;
    if (this.worker) this.worker.stop(signal);
    if (this.wake) this.wake();
  }

  /** Sleep, ended early by an interrupt. @param {number} ms */
  sleep(ms) {
    return new Promise((resolve) => {
      if (this.interrupted !== null) { resolve(undefined); return; }
      const t = setTimeout(() => { this.wake = null; resolve(undefined); }, ms);
      this.wake = () => { clearTimeout(t); this.wake = null; resolve(undefined); };
    });
  }

  // ---- the run ----------------------------------------------------------------------------------------------------------------------------------
  /** @returns {Promise<number>} */
  async main() {
    /** @type {number} */ let code;
    try {
      code = await this.body();
    } catch (e) {
      if (e instanceof Exit) code = e.code;
      else {
        this.stderr(`dispatch: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
        code = 70;
      }
    }
    if (this.interrupted !== null) code = 143;
    this.finish(code);
    return code;
  }

  /** The shell's EXIT trap: take the worker with us, write the metrics record, remove the marker and the work folder. @param {number} code */
  finish(code) {
    if (this.worker) { this.worker.stop('SIGTERM'); this.worker = null; }
    if (this.attempts > 0) {
      const res = code === 0 ? 'submitted' : code === 124 ? 'timeout' : code === 5 ? 'needs_input' : code === 6 ? 'blocked' : 'failed';
      let tot = this.mTot;
      if (tot === '' && this.mIn !== '' && this.mOut !== '') tot = String(Number(this.mIn) + Number(this.mOut));
      this.cmd(['metrics-dispatch', this.id, this.role, this.focus, this.rt, this.model, String(nowEpoch() - this.t0), this.mIn, this.mOut, tot, this.mTurns, String(this.attempts - 1), res]);
    }
    if (this.running !== '') rmSync(this.running, { force: true });
    if (this.work !== '') rmSync(this.work, { recursive: true, force: true });
  }

  /** @returns {Promise<number>} */
  async body() {
    const a = this.argv;
    if (a[0] === 'codex-profile' && a.length === 2) {
      if (!isDir(`${this.root}/.agents/runs/${a[1]}`)) throw this.die(`no such run: ${a[1]}`);
      for (const l of this.codexProfileArgs(a[1], this.root)) this.stdout(`${l}\n`);
      return 0;
    }
    if (a.length < 2) throw this.usage();
    this.id = a[0]; this.role = a[1];
    this.tok('task-id', this.id); this.tok('role', this.role);
    this.role = ({ full_lifecycle: 'lead', implementation_worker: 'implementer', independent_reviewer: 'reviewer', independent_qa: 'qa', independent_verifier: 'verifier' })[/** @type {'lead'} */ (this.role)] ?? this.role;
    for (let i = 2; i < a.length; i += 2) {
      if (i + 1 >= a.length) throw this.usage();
      const v = a[i + 1];
      switch (a[i]) {
        case '--focus': this.tok(a[i], v); this.focus = v; break;
        case '--prompt-file': this.promptFile = v; break;
        case '--model': this.tok(a[i], v); this.oModel = v; break;
        case '--effort': this.tok(a[i], v); this.oEffort = v; break;
        case '--runtime': this.tok(a[i], v); this.oRuntime = v; break;
        default: throw this.usage();
      }
    }
    if (this.promptFile !== '' && !isFile(this.promptFile)) throw this.die(`no such prompt file: ${bytes(this.promptFile)}`);
    this.run = `${this.root}/.agents/runs/${this.id}`;
    if (!isDir(this.run)) throw this.die(`no such run: ${this.id}`);

    // timeouts: the global limit, the run's class limit (A171), timeouts.scale (A202 item 29), never below the shortest step time
    const ctx = this.ctx();
    const cfg = ctx.config();
    const digits = (/** @type {string} */ v) => /^[0-9]+$/.test(v);
    let t = cfg.get('dispatch.timeout_seconds', '');
    if (!digits(t)) t = '5400';
    const cls = sectionValue(ctx, this.run, 'pipeline', 'classification');
    if (pipelineClassValid(cls)) { const c = cfg.get(`pipelines.${cls}.dispatch_timeout_seconds`, ''); if (digits(c)) t = c; }
    this.timeoutS = tmScaled(cfg, t, 1, 28800);
    if (this.timeoutS < this.minTimeout) this.timeoutS = this.minTimeout;

    this.resumeFile = `${this.run}/dispatch/RESUME-${this.role}${this.focus === '' ? '' : `-${this.focus.replace(/\+/g, '-')}`}.md`;
    // A202 item 29: explorers run in parallel, one per assignment, and share a role: a second timeout would overwrite the first one's note. The note of an
    // explorer with an assignment is also kept under the assignment's own name (cksum of its prompt file), which the same assignment finds first.
    if (this.role === 'explorer' && this.promptFile !== '' && isFile(this.promptFile)) {
      this.resumeOne = `${this.run}/dispatch/RESUME-explorer-${cksum(readFileSync(this.promptFile))}.md`;
      if (sizeOf(this.resumeOne) > 0) this.resumeFile = this.resumeOne;
    }
    let n = 0;
    try { n = readdirSync(`${this.run}/dispatch`).filter((f) => f.endsWith('.log')).length; } catch { n = 0; }
    this.seqN = n + 1;
    mkdirSync(`${this.run}/results`, { recursive: true });
    mkdirSync(`${this.run}/dispatch`, { recursive: true });
    this.work = mkdtempSync(path.join(tmpdir(), 'dispatch.'));

    this.aRuntime = this.oRuntime; this.aRtReason = '';
    await this.attempt();
    let netMax = cfg.get('dispatch.network_retries', '');
    netMax = digits(netMax) ? netMax : '3';
    const netCap = Math.min(Number(netMax), 6);
    let base = cfg.get('dispatch.network_backoff_seconds', '');
    if (!digits(base)) base = '15';
    let netTry = 0; let netWait = Number(base);
    const subdir = `${ctx.agents}/local/submissions`;
    while (this.status !== 0 && this.status !== 124 && this.status !== 127 && netTry < netCap && !existsSync(`${subdir}/${this.token}.status`) && dt.transientNetwork(this.logText())) {
      netTry++;
      if (netWait > NET_BACKOFF_CAP) netWait = NET_BACKOFF_CAP;
      this.note(`dispatch network retry ${netTry}/${netCap} role=${this.role} runtime=${this.rt} wait=${netWait}s (the connection dropped; the step resumes from the state it left)`);
      this.stderr(`dispatch: ${this.role} on ${this.rt} lost its connection (attempt ${netTry} of ${netCap}); resuming in ${netWait}s; log: ${this.rel(this.log)}\n`);
      this.writeResume('network');
      await this.sleep(netWait * 1000);
      if (this.interrupted !== null) { await this.onInterrupted(); }
      netWait *= 2;
      this.aRuntime = this.rt; this.oModel = '';
      await this.attempt();
    }
    if (this.status !== 0 && this.status !== 124) {
      /** @type {string} */ let reason = dt.runtimeFailureReason(this.logText());
      if (this.status === 127) reason = 'missing_binary';
      if (reason === 'runtime_unavailable:network') throw this.blocked(`runtime_unavailable:network: ${this.rt} worker could not reach its API (after ${netTry} automatic retries); enable network access for the lead workspace-write sandbox and retry this step`);
      if (reason !== 'none') {
        const other = this.rt === 'claude' ? 'codex' : this.rt === 'codex' ? 'claude' : '';
        let mode = cfg.get('failover', '');
        if (mode === '') mode = 'auto';
        if (other === '') throw this.blocked(`runtime ${this.rt} failed (${reason}) and has no failover peer`);
        if (mode === 'off') throw this.blocked(`runtime ${this.rt} failed (${reason}); failover: off`);
        if (mode === 'ask') {
          const tr = this.cmd(['run-language', this.id]);
          const lang = tr.code === 0 ? tr.out.replace(/\n+$/, '') : 'en';
          const question = lang === 'tr'
            ? `1. Çalışma ortamı ${this.rt}, ${this.role} adımını çalıştıramadı (${reason}). Bu adım baştan ${other} üzerinde yeniden çalıştırılsın mı?\n   seçenekler: yes | no\n   önerilen: yes, ${other} bu rol için uygunsa\n   neden: config failover değeri ask\n`
            : `1. Runtime ${this.rt} could not run ${this.role} (${reason}). Re-run this step from its beginning on ${other}?\n   options: yes | no\n   recommended: yes, if ${other} is acceptable for this role\n   why: config failover is ask\n`;
          const qb = Buffer.from(lang === 'tr' ? bytes(question) : question, 'latin1');
          const qf = `${this.work}/question`;
          writeFileSync(qf, qb);
          const r = this.cmd(['ask', this.id, '--file', qf]);
          this.stderr(r.all);
          if (r.code !== 0) throw this.blocked(`runtime ${this.rt} failed (${reason}); failover: ask, but the question could not be stored`);
          this.note(`dispatch needs_input role=${this.role} runtime=${this.rt} reason=${reason}`);
          this.stdout(`ROLE: ${this.role}\nTASK: ${this.id}\nRESULT: NEEDS_INPUT\nQUESTIONS:\n`);
          this.io.stdout.write(qb);
          throw new Exit(5);
        }
        if (mode !== 'auto') throw this.die(`invalid failover mode in config: ${mode} (want auto|ask|off)`);
        const detect = runtimeDetect(this.ctx(), ['has', other]);
        if (detect.status !== 0) throw this.blocked(`runtime ${this.rt} failed (${reason}); ${other} is not installed`);
        const from = this.rt; this.oModel = '';   // model ids are runtime-specific; the policy picks the other runtime's model
        if (!this.note(`failover from=${from} to=${other} reason=${reason} role=${this.role}`)) throw this.blocked(`runtime ${this.rt} failed (${reason}); failover could not be ledgered`);
        this.aRuntime = other; this.aRtReason = 'AUTOMATIC_FAILOVER';
        await this.attempt();
        if (this.status !== 0 && this.status !== 124 && dt.runtimeFailureReason(this.logText()) !== 'none') throw this.blocked(`runtime ${from} failed (${reason}) and failover runtime ${this.rt} failed too`);
      }
    }
    let submissions = 0;
    for (;;) {
      if (this.status === 124) {
        this.writeResume();
        this.note(`dispatch timeout role=${this.role} runtime=${this.rt} after=${this.timeoutS}s`);
        this.stderr(`dispatch: ${this.role} on ${this.rt} timed out after ${this.timeoutS}s; log: ${this.rel(this.log)}\n`);
        throw new Exit(124);
      }
      if (this.noout) throw this.blocked(`${this.role} on ${this.rt} produced no output (exit ${this.status}); log: ${this.rel(this.log)}. An empty result also follows a dispatch killed before it finished (its caller's time limit): run it once, alone, and wait for the command to return`);
      if (this.status !== 0) { this.stderr(`dispatch: ${this.role} on ${this.rt} failed (exit ${this.status}); log: ${this.rel(this.log)}\n`); throw new Exit(1); }
      const st = `${subdir}/${this.token}.status`;
      const stText = isFile(st) ? readLatin1(st) : '';
      const field = (/** @type {string} */ k) => dt.kv(stText, k);
      if (field('status') === 'ok') {
        const sr = field('result'); const sg = field('gate'); const sw = field('raw');
        rmSync(this.resumeFile, { force: true });
        if (this.resumeOne !== '') rmSync(this.resumeOne, { force: true });   // the resumed step delivered: the note is spent
        this.stdout(`submitted: ${this.id} ${this.role} ${sr}${sg === '' ? '' : ` gate=${sg}`} (${sw === '' ? 'no raw' : sw})\n`);
        return 0;
      }
      const err = field('error');
      submissions++;
      if (submissions >= 2) {
        let hint = '';
        if (this.rt === 'codex' && dt.worktreeSandboxRefusal(this.logText())) {
          hint = '; the Codex sandbox refused a git worktree or git metadata write (A203: a Codex worker writes only its own worktree folder and the common objects folder, so it cannot create an evidence worktree): run this role with --runtime claude';
        }
        throw this.blocked(`no valid submission from ${this.role} after one retry${err === '' ? '' : ` (last rejection: ${err})`}${hint}; nothing recorded`);
      }
      // A127: name what was looked for and what exists, so a missing status file (a submit under another token) shows in the ledger
      let seen = '';
      try { seen = readdirSync(subdir).sort().map((f) => `${f},`).join(''); } catch { seen = ''; }
      this.note(`dispatch resubmit role=${this.role} runtime=${this.rt} reason=${err === '' ? 'no submission' : err} token=${this.token} status_files=${seen === '' ? 'none' : seen}`);
      this.retryNote = `Your previous attempt ended without a recorded result${err === '' ? '' : ` (last rejection: ${err})`}. Your report files may already exist: check them, fix what the rejection names, then submit. Do not redo finished work.`;
      this.aRuntime = this.rt; this.oModel = '';
      await this.attempt();
    }
  }

  /** The runtime's log of the last attempt as a byte string ('' when there is none). */
  logText() { try { return readLatin1(this.log); } catch { return ''; } }

  // ---- one attempt -----------------------------------------------------------------------------------------------------------------------------
  /** The Codex permission profile (A199, A203): the `-c` arguments, one per element. @param {string} id @param {string} root @returns {string[]} */
  codexProfileArgs(id, root) {
    let rules = `".agents"="read",".agents/runs/${id}"="write",".agents/runs/${id}/approvals"="read",".agents/runs/${id}/waivers"="read",".agents/local/locks"="write",".agents/local/submissions"="write"`;
    let abs = '';
    const git = (/** @type {string[]} */ args) => {
      const r = proc.run('git', ['-C', root, ...args], { env: this.env, stdio: ['ignore', 'pipe', 'ignore'] });
      return r.status === 0 ? r.stdout.toString('utf8').replace(/\n$/, '') : '';
    };
    const real = (/** @type {string} */ p) => { try { return realpathSync(p); } catch { return p; } };
    if (isFile(`${root}/.git`)) {
      const first = git(['worktree', 'list', '--porcelain']).split('\n')[0] ?? '';
      const main = first.startsWith('worktree ') ? first.slice('worktree '.length) : '';
      if (main !== '' && real(root).startsWith(`${main}/.agents/local/worktrees/`)) {
        mkdirSync(`${main}/.agents/local/locks`, { recursive: true });
        abs += `,"${main}/.agents/local/locks"="write"`;
      }
      let g = git(['rev-parse', '--git-dir']);
      if (g !== '' && !g.startsWith('/')) g = `${root}/${g}`;
      if (g !== '' && isDir(g)) {
        g = real(g);
        if (/\/worktrees\//.test(g)) {
          abs += `,"${g}"="write"`;
          let o = git(['rev-parse', '--git-common-dir']);
          if (!o.startsWith('/')) o = `${root}/${o}`;
          if (isDir(`${o}/objects`)) abs += `,"${real(`${o}/objects`)}"="write"`;
        }
      }
    }
    if ((rules + abs).includes('\\')) throw this.die('a path with a backslash cannot be placed in the Codex permission profile');
    return ['-c', 'default_permissions="proofline-worker"', '-c', 'permissions.proofline-worker.extends=":workspace"', '-c', `permissions.proofline-worker.filesystem={":workspace_roots"={${rules}}${abs}}`];
  }

  /** The text of the role's instructions file and its path: the one place that knows where they live. @param {string} role @returns {string} '' when none */
  roleInstructions(role) {
    const an = `proofline-${role.replace(/_/g, '-')}`;
    for (const f of [`${this.root}/.agents/roles/${role}.md`, `${this.root}/.claude/agents/${an}.md`, `${this.root}/.codex/agents/${an}.toml`]) if (isFile(f)) return f;
    return '';
  }

  /** The proofline PreToolUse hook is the confinement of a bypassPermissions worker (A114): the script must be present, non-empty and parse, and .claude/settings.json must wire it. */
  preToolHookWired() {
    const hook = `${this.root}/.agents/hooks/proofline-hook.mjs`;
    const settings = `${this.root}/.claude/settings.json`;
    if (!(sizeOf(hook) > 0 && isFile(settings))) return false;
    if (proc.run(process.execPath, ['--check', hook], { env: this.env, stdio: 'ignore' }).status !== 0) return false;
    try {
      const groups = (JSON.parse(readFileSync(settings, 'utf8')).hooks ?? {}).PreToolUse ?? [];
      return Array.isArray(groups) && groups.some((/** @type {any} */ x) => (x.hooks ?? []).some((/** @type {any} */ h) => String(h.command).includes('proofline-hook.mjs')));
    } catch { return false; }
  }

  /** @returns {string} */
  handoffState() { return sectionValue(this.ctx(), this.run, 'handoff', 'state'); }

  /** One attempt: sets status (0 ok, 124 timeout, other failure), rt, out, log. */
  async attempt() {
    this.attempts++; this.noout = false;
    const role = this.role; const id = this.id;
    // Every role writes its owned artifacts in the run dir; only the implementer, and the designer during IMPLEMENTING, may touch the product tree, inside an attested window.
    this.writesCode = role === 'implementer' || (role === 'designer' && this.handoffState() === 'IMPLEMENTING');
    const dargs = ['decide', id, role];
    if (this.focus !== '') dargs.push('--focus', this.focus);
    if (this.oModel !== '') dargs.push('--model', this.oModel);
    if (this.oEffort !== '') dargs.push('--effort', this.oEffort);
    if (this.aRuntime !== '') dargs.push('--runtime', this.aRuntime);
    if (this.aRtReason !== '') dargs.push('--runtime-reason', this.aRtReason);   // A203: an automatic failover has its own reason, not OPERATOR_OVERRIDE
    const dec = this.cmd(dargs);
    if (dec.code !== 0) {
      this.stderr(dec.err);
      if (dec.code === 4) throw this.blocked(`no decision for ${role} on ${this.aRuntime === '' ? 'the configured runtime' : this.aRuntime}: capability floor unmet or unresolvable`);
      this.stderr(`dispatch: no execution decision for ${id} ${role} (exit ${dec.code})\n`);
      throw new Exit(1);
    }
    const dv = (/** @type {string} */ k) => dt.kv(dec.out, k);
    this.rt = dv('runtime'); this.model = dv('model'); this.effort = dv('effort');
    const budget = dv('context_bytes');
    this.tok('runtime', this.rt); this.tok('model', this.model); this.tok('effort', this.effort);
    if (!/^[0-9]+$/.test(budget)) throw this.die('decision has no context_bytes');
    const rt = this.rt;

    // A113: claim the sequence atomically (mkdir), so parallel dispatches never share a token, output or log.
    // A132: claimed before the prompt is built, so the prompt can name the token-derived scratch path.
    for (;;) {
      try { mkdirSync(`${this.run}/dispatch/.claim-${pad3(this.seqN)}`); break; } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
        this.seqN++;
      }
    }
    this.token = `d${pad3(this.seqN)}-${role}-${rt}`;
    const ins = this.roleInstructions(role);
    if (ins === '') throw this.die(`no instructions for role ${role} (.agents/roles/${role}.md, .claude/agents/proofline-${role}.md or .codex/agents/proofline-${role}.toml)`);

    let suffix = `TASK: ${id}\nROLE: ${role}\n`;
    if (this.focus !== '') suffix += `FOCUS: ${this.focus}\n`;
    suffix += `RUN_DIR: .agents/runs/${id}\nReport your result with: AGENT_ROLE=${role} sh .agents/scripts/agent.sh submit ${id} --confidence <high|medium|low> [--focus F] [--artifact <path of your report>] [--findings FILE|none] [--report FILE|-] [--reason T] [--questions FILE]\nOnly one of --report/--findings may read stdin (-): use a file for the other, or one stdin document: report, a line "=== FINDINGS ===", then rows (severity|path:line|finding|evidence; answer-only: --findings none or info|-|answer|<one line>).\nThe script builds the header, fingerprint and hashes and returns any rejection to you: fix what it names and submit again. Your final message is not parsed.\n`;
    if (role === 'explorer') {
      suffix += `Explorer: write your report to EXACTLY .agents/runs/${id}/scratch/${this.token}-report.md (never a generic name such as r.md: a parallel explorer would overwrite it) and pass it with --report that path (or --report - on stdin; no --artifact); the script assigns the numbered reports/NNN-explorer.md name (A113, A132).\nExplorer report format: the report is a claims table, never prose: | id | severity | path:line | finding | evidence | one row per verified claim, for example | - | info | src/order.js:submitOrder | caller of applyDiscount, rounds to two decimals | grep -n applyDiscount src: one call |. Prose is sent back to you to redo as the table.\n`;
    }
    // A124: the window is held by the dispatcher and leaves no file until window-close, and an assignment is optional; say both, or a worker looks for them, finds nothing and reports BLOCKED.
    if (this.writesCode) suffix += 'WINDOW: dispatch.sh opened your write window before starting you (window-open). It leaves no file until the step ends (window-close writes worker-evidence/WINDOW-<n>.yaml). Do not look for it; never report BLOCKED for a missing window.\n';
    if (this.promptFile === '') suffix += `ASSIGNMENT: none was given. Do your role's default step on this task from .agents/runs/${id}/ (TASK.md, PLAN.md and their scope); never report BLOCKED for a missing assignment file.\n`;
    if (this.retryNote !== '') suffix += `\n${this.retryNote}\n`;
    // A171: an earlier dispatch of this step timed out; its recorded partial state is handed to this one.
    if (sizeOf(this.resumeFile) > 0) suffix += `\nRESUME: an earlier dispatch of this step timed out (or lost its connection) before it submitted. Continue from where it stopped; do not redo finished work. Recorded state:\n${readLatin1(this.resumeFile)}`;
    if (this.promptFile !== '') suffix += `\n${readLatin1(this.promptFile)}`;
    const sb = Buffer.byteLength(suffix, 'latin1');
    if (sb > Number(budget)) throw this.blocked(`task prompt is ${sb} bytes, over the resolved context budget of ${budget} (trim it; it is never truncated)`);
    const full = `${readLatin1(ins)}\n=== TASK ===\n${suffix}`;
    const fSuffix = `${this.work}/suffix`; const fFull = `${this.work}/full`;
    writeFileSync(fSuffix, suffix, 'latin1'); writeFileSync(fFull, full, 'latin1');

    const nnn = pad3(this.seqN);
    this.out = `${this.run}/dispatch/${nnn}-${role}-${rt}.md`;
    this.log = `${this.run}/dispatch/${nnn}-${role}-${rt}.log`;
    if (this.running !== '') rmSync(this.running, { force: true });   // a retry or failover attempt replaces the previous attempt's marker
    this.running = `${this.log.slice(0, -'.log'.length)}.running`;
    this.seqN++;
    writeFileSync(this.out, '');
    this.pm = '';
    this.tmpl = this.cfg(`dispatch.command_template.${rt}`);
    /** @type {string[]} */ let argv;
    if (this.tmpl !== '') {
      let t = this.tmpl;
      for (const [name, value] of [['prompt_file', fFull], ['output_file', this.out], ['root', this.root], ['model', this.model], ['effort', this.effort]]) t = dt.subst(t, name, dt.shellQuote(bytes(value)));
      argv = ['sh', '-c', asArg(t)];
    } else if (rt === 'codex') {
      argv = [this.env.PROOFLINE_CODEX_BIN || 'codex', 'exec', '-C', this.root, '-m', this.model, '-c', `model_reasoning_effort=${this.effort}`, '-c', 'approval_policy="never"', '--dangerously-bypass-hook-trust', '-o', this.out];
      // The specialist runs `agent.sh submit` itself. Its write access is the profile of codexProfileArgs (A199), which lists every path one by one; what a role may
      // write inside the product tree stays decided by owns.conf (PreToolUse hook) and the fingerprint check below.
      for (const d of [`${this.run}/worker-evidence`, `${this.run}/reports`, `${this.run}/approvals`, `${this.run}/waivers`, `${this.root}/.agents/local/locks`, `${this.root}/.agents/local/submissions`]) mkdirSync(d, { recursive: true });
      argv.push(...this.codexProfileArgs(id, this.root), '-');
    } else if (rt === 'claude') {
      const an = `proofline-${role.replace(/_/g, '-')}`;
      const af = `${this.root}/.claude/agents/${an}.md`;
      const bin = this.env.PROOFLINE_CLAUDE_BIN || 'claude';
      if (isFile(af)) {
        // the generated agent runs, so its tools: list applies
        const line = readLatin1(af).split('\n').find((l) => /^tools:/.test(l));
        const at = line === undefined ? '' : line.replace(/^tools:[ \t\n\v\f\r]*/, '');
        if (at === '') throw this.blocked(`${af} has no tools: list (it would inherit every tool, Agent included)`);
        if (dt.spawnTool(at)) throw this.blocked(`${af} grants an agent-spawning tool (Agent/Task)`);
        argv = [bin, '-p', '--agent', an];
      } else {
        let src = `${this.root}/.agents/roles/${role}.md`;
        if (!isFile(src)) src = ins;
        let conf = '';
        for (const c of [`${this.root}/.agents/tools.conf`, `${this.root}/.agents/roles/tools.conf`]) if (isFile(c)) { conf = readLatin1(c); break; }
        argv = [bin, '-p', '--agents', asArg(dt.agentsJson(an, readLatin1(src), role, dt.toolsRow(conf, role))), '--agent', an];
      }
      // A headless worker cannot be prompted, so the permission mode is explicit (A114). bypassPermissions is only used while the PreToolUse hook (the real
      // confinement) is installed and wired for this project.
      this.pm = this.cfg('dispatch.claude_permission_mode');
      if (this.pm === '') this.pm = 'bypassPermissions';
      if (!dt.PERMISSION_MODES.includes(this.pm)) throw this.die(`invalid dispatch.claude_permission_mode: ${this.pm} (want bypassPermissions|acceptEdits|default)`);
      if (this.pm === 'bypassPermissions' && !this.preToolHookWired()) {
        throw this.blocked("claude worker not started: the proofline PreToolUse hook is not installed in .claude/settings.json (run 'proofline doctor', then install); a headless worker runs with bypassPermissions only while the hook confines it, or set dispatch.claude_permission_mode");
      }
      this.note(`dispatch claude_permission_mode=${this.pm} role=${role}`);
      argv.push('--model', this.model, '--effort', this.effort, '--permission-mode', this.pm, '--output-format', 'json');
    } else {
      throw this.blocked(`runtime ${rt} has no built-in invocation and no dispatch.command_template.${rt}`);
    }
    const input = rt === 'claude' && this.tmpl === '' ? fSuffix : fFull;

    const gsBefore = gitState(this.root, this.env);
    /** @type {string} */ let fpBefore = '';
    this.before = ''; this.windowOpen = false;
    if (!this.writesCode) {
      const fp = this.cmd(['fingerprint', id, 'full']);
      fpBefore = fp.out.replace(/\n+$/, '');
      if (fp.code !== 0 || fpBefore === '') { this.stderr(fp.err); this.stderr(`dispatch: no product-tree fingerprint; ${role} not started\n`); throw new Exit(1); }
      // One build and test run per tree: the first reviewer or verifier dispatch makes the record, later ones reuse it. Its result never stops a dispatch.
      if (role === 'reviewer' || role === 'verifier') {
        const r = proc.run('sh', [`${this.scriptDir}/agent.sh`, 'build-record', id, 'run'], { cwd: this.io.cwd, env: this.env, stdio: ['ignore', 'pipe', 'pipe'], allowEqualTree: true });
        if (r.status !== 0) {
          const text = Buffer.concat([r.stdout, r.stderr]).toString('latin1');
          const lastLine = lastLines(text).slice(-1)[0] ?? '';
          this.stderr(`dispatch: MISSING STEP for the lead: no build record was made for this tree (${lastLine.slice(0, 200)}); the ${role} starts without one. With empty commands.build and commands.test: proofline doctor --commands (A200)\n`);
        }
      }
    } else {
      const w = this.cmd(['window-open', id, role]);
      this.stderr(w.err);
      if (w.code !== 0) {
        this.stderr(`${windowOpenRefusedText(id, role)}\n`);
        throw new Exit(1);
      }
      this.before = w.out.replace(/\n+$/, '');
      this.windowOpen = true;
    }
    this.stderr(`dispatch: ${id} ${role} runtime=${rt} model=${this.model} effort=${this.effort} (${dv('model_reason')}) writes_code=${this.writesCode ? 'yes' : 'no'}${this.pm === '' ? '' : ` permission_mode=${this.pm}`}\n`);
    this.status = 0;
    // A124: .md and .log stay empty until the worker exits, so a reader cannot tell a running dispatch from a dead one.
    writeFileSync(this.running, `pid=${process.pid}\nrole=${role}\ntimeout=${this.timeoutS}\nstarted_epoch=${nowEpoch()}\ndispatch in flight: ${id} ${role} on ${rt}, started ${nowIso()}.\nThis dispatch.sh command has not returned: the .md and .log of this step stay empty until it does.\nWait for the command to return; do not re-dispatch this step or read these files as a result.\n`);
    if (this.interrupted !== null) await this.onInterrupted();
    if (this.tmpl === '' && commandV(argv[0], this.env) === null) {
      this.status = 127;
      writeFileSync(this.log, `runtime binary not found: ${argv[0]}\n`);
    } else {
      /** @type {NodeJS.ProcessEnv} */
      const env = { ...this.env, AGENT_ROLE: role, PROOFLINE_AGENT: this.token, PROOFLINE_FOCUS: this.focus, PROOFLINE_DISPATCH_RUNTIME: rt, PROOFLINE_DISPATCH_START: String(nowEpoch()) };
      if (rt === 'codex' && (this.env.PROOFLINE_CODEX_HOME_DIR ?? '') !== '') {
        env.HOME = this.env.PROOFLINE_CODEX_HOME_DIR; env.CODEX_HOME = `${this.env.PROOFLINE_CODEX_HOME_DIR}/.codex`;
      } else if (rt !== 'codex' && (this.env.PROOFLINE_REAL_HOME ?? '') !== '') {
        // A Codex lead runs with an isolated HOME (the end-to-end harness, A21); a Claude specialist started from it needs the operator's own HOME and login,
        // or it fails with "not logged in" (failover run).
        env.HOME = this.env.PROOFLINE_REAL_HOME;
      }
      this.status = await this.runTimed(argv, env, input);
    }
    if (this.interrupted !== null) await this.onInterrupted();
    if (this.writesCode) {
      const c = this.cmd(['window-close', id, this.before, String(this.status), role]);
      this.windowOpen = false;
      this.stderr(c.all);
      if (c.code !== 0) { this.stderr('dispatch: window-close failed (unattributed mutation?)\n'); throw new Exit(1); }
    }
    const gsAfter = gitState(this.root, this.env);
    if (gsAfter !== gsBefore) {
      this.note(`policy_violation role=${role} runtime=${rt} changed .git/config or HEAD during the step`);
      throw this.blocked(`policy_violation: ${role} changed .git/config (hooks, config) or HEAD during the step; result not recorded`);
    }
    if (!this.writesCode) {
      const fa = this.cmd(['fingerprint', id, 'full']);
      const fpAfter = fa.code === 0 ? fa.out.replace(/\n+$/, '') : 'unknown';
      if (fpAfter !== fpBefore) {
        // Never auto-reverted: the user's files are theirs. Changed paths are reported; the result is not recorded.
        const dtree = proc.run('git', ['-C', this.root, 'diff-tree', '-r', '--name-only', fpBefore, fpAfter], { env: this.env, stdio: ['ignore', 'pipe', 'ignore'] });
        const changed = dtree.status === 0 ? dtree.stdout.toString('latin1').split('\n').filter((x) => x !== '').map((x) => `${x} `).join('') : '';
        this.note(`policy_violation role=${role} runtime=${rt} product tree changed by a role that does not write code: ${changed === '' ? 'paths unknown' : changed}`);
        throw this.blocked(`policy_violation: ${role} changed the product tree (${changed === '' ? 'paths unknown' : changed}); result not recorded, changes left in place`);
      }
    }
    if (this.status === 0 && rt === 'claude' && this.tmpl === '') {
      const log = this.logText();
      if (dt.claudeIsError(log)) this.status = 1;
      else {
        const res = dt.claudeResult(log);
        if (res === null) this.status = 1; else writeFileSync(this.out, res, 'latin1');
      }
    }
    if (this.status === 0 && sizeOf(this.out) === 0 && this.tmpl !== '') { try { copyFileSync(this.log, this.out); } catch { /* nothing to copy */ } }
    if (this.status === 0 && sizeOf(this.out) === 0) this.status = 1;
    // A124: a worker that wrote nothing at all leaves the lead nothing to act on; name it in the log and in BLOCKED.
    if (this.status !== 0 && this.status !== 124 && sizeOf(this.log) === 0) {
      this.noout = true;
      writeFileSync(this.log, `dispatch: ${role} on ${rt} exited with status ${this.status} and wrote nothing to its log\n`);
    }
    this.harvest();
    if (sizeOf(this.out) === 0) rmSync(this.out, { force: true });
  }

  /** Metrics (A80): after one attempt, add what the runtime reported. Tokens and turns are read from the runtime's structured output trailer; absent = empty = null, never estimated. */
  harvest() {
    if (this.tmpl !== '' || !isFile(this.log)) return;
    // the numbers belong to one runtime: after a failover the record carries the last runtime's own, never a sum with the first's
    if (this.mRt !== this.rt) { this.mIn = ''; this.mOut = ''; this.mTot = ''; this.mTurns = ''; this.mRt = this.rt; }
    const log = this.logText();
    if (this.rt === 'claude') {
      const cu = dt.claudeUsage(log);
      let ci = dt.usageNumber(cu, 'input_tokens');
      const cc = dt.usageNumber(cu, 'cache_creation_input_tokens'); const co = dt.usageNumber(cu, 'output_tokens');
      // input = fresh input plus cache-creation tokens (billed input); cache reads are excluded (docs/concepts/metrics.md)
      if (ci !== '') ci = String(Number(ci) + Number(cc === '' ? 0 : cc));
      this.mIn = dt.addN(ci, this.mIn); this.mOut = dt.addN(co, this.mOut);
      this.mTurns = dt.addN(dt.numFirst(log, 'num_turns'), this.mTurns);
    } else if (this.rt === 'codex') {
      this.mTot = dt.addN(dt.codexTotal(sizeOf(this.out) > 0 ? readLatin1(this.out) : '', log), this.mTot);
    }
  }

  /** The watchdog: the runtime as a child in its own process group, TERM at the timeout, KILL after the grace. 124 on timeout. @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {string} input @returns {Promise<number>} */
  async runTimed(argv, env, input) {
    const inFd = openSync(input, 'r');
    const logFd = openSync(this.log, 'w');
    let timedOut = false;
    try {
      const leader = proc.startLeader(argv[0], argv.slice(1), { cwd: this.root, env, stdio: [inFd, logFd, logFd], graceMs: this.graceMs, onOrphan: this.orphanSpec(env) });
      this.worker = leader;
      const timer = setTimeout(() => { timedOut = true; leader.stop('SIGTERM'); }, this.timeoutS * 1000);
      const r = await leader.exited;
      clearTimeout(timer);
      this.worker = null;
      return timedOut ? 124 : r.status;
    } finally {
      closeSync(inFd); closeSync(logFd);
    }
  }

  /**
   * What the guardian needs to close the write window when this dispatcher is killed by SIGKILL (no handler runs): the commands run as the lead (the variables this
   * dispatcher changed for the worker are put back), through the project's own core. Only for a window this dispatcher opened.
   * @param {NodeJS.ProcessEnv} workerEnv @returns {import('./proc.mjs').OrphanSpec | undefined}
   */
  orphanSpec(workerEnv) {
    if (!this.writesCode || !this.windowOpen || this.before === '') return undefined;
    /** @type {string[]} */ const remove = [];
    /** @type {Record<string, string>} */ const set = {};
    for (const k of new Set([...Object.keys(workerEnv), ...Object.keys(this.env)])) {
      if (workerEnv[k] === this.env[k]) continue;
      const orig = this.env[k];
      if (orig === undefined) remove.push(k); else set[k] = orig;
    }
    const core = fileURLToPath(new URL('../proofline-core.mjs', import.meta.url));
    const agent = `${this.scriptDir}/agent.sh`;
    return {
      cwd: this.io.cwd, remove, set,
      close: [process.execPath, core, '--pl-argv0', agent, 'window-close', this.id, this.before, '137', this.role],
      note: [process.execPath, core, '--pl-argv0', agent, 'ledger-note', this.id],
      noteText: `dispatch killed from outside role=${this.role} runtime=${this.rt} attempt=${this.attempts}: the dispatcher got SIGKILL (no handler ran)`,
    };
  }

  /** A dispatch stopped from outside: the worker has been told and has exited (or was killed after the grace). Record it and leave with 143. */
  async onInterrupted() {
    const sig = this.interrupted ?? 'SIGTERM';
    if (this.worker) { await this.worker.exited; this.worker = null; }
    this.note(`dispatch interrupted signal=${sig.slice(3)} role=${this.role} runtime=${this.rt} attempt=${this.attempts}`);
    if (this.rt !== '' && this.log !== '') this.writeResume('signal', sig);
    if (this.writesCode && this.windowOpen) {
      // the worker's group is gone (exited above, or killed after the grace): nothing can write now. The close attributes the partial edits to the implementer, as a timeout does
      // (124); it passes no gate: review, QA, verify and security still judge the content, and the scope and the worker-evidence checks still apply to it.
      const c = this.cmd(['window-close', this.id, this.before, String(128 + SIGNUM[sig]), this.role]);
      this.windowOpen = false;
      this.stderr(c.all);
      if (c.code === 0) this.stderr(`dispatch: stopped by ${sig.slice(3)}; the worker was stopped and the write window of the ${this.role} was closed with status ${128 + SIGNUM[sig]} (its partial edits are the implementer's; dispatch again to continue from dispatch/RESUME-${this.role}.md)\n`);
      else this.stderr(`dispatch: stopped by ${sig.slice(3)}; the worker was stopped but the write window of the ${this.role} could NOT be closed, so its edits are unattested: run agent.sh tree-inspect ${this.id} and put ONE question to the user (keep the tree with tree-accept, or discard the listed files); do not dispatch again, discard or edit by hand before the answer (A224)\n`);
    } else {
      this.stderr(`dispatch: stopped by ${sig.slice(3)}; the worker was stopped; log: ${this.rel(this.log)}\n`);
    }
    throw new Exit(143);
  }

  /**
   * A171: a timeout leaves the step half done (A200: so does a dropped connection, and a dispatch stopped from outside). Record what the worker left (the tail of its
   * log, the product-tree paths that differ from HEAD, the run artifacts it wrote) so the next dispatch of the same role and focus continues from it.
   * @param {'timeout' | 'network' | 'signal'} [why] @param {string} [signal]
   */
  writeResume(why = 'timeout', signal = '') {
    let t = '';
    const iso = nowIso();
    if (why === 'network') t += `interrupted_at: ${iso} (network error after attempt ${this.attempts}, runtime ${this.rt}: the connection dropped; no timeout)\n`;
    else if (why === 'signal') t += `interrupted_at: ${iso} (${signal.slice(3)} to the dispatch after attempt ${this.attempts}, runtime ${this.rt}: stopped from outside; no timeout)\n`;
    else t += `timed_out_at: ${iso} (after ${this.timeoutS}s, attempt ${this.attempts}, runtime ${this.rt})\n`;
    t += `log: ${this.rel(this.log)}\nproduct_tree_changes (git status --short):\n`;
    const st = proc.run('git', ['-C', this.root, 'status', '--short', '--untracked-files=all'], { env: this.env, stdio: ['ignore', 'pipe', 'ignore'] });
    const changes = st.stdout.toString('latin1').split('\n').filter((l) => l !== '' && !/ \.agents\/(runs|local)\//.test(l)).slice(0, 60);
    for (const l of changes) t += `  ${l}\n`;
    t += 'run_artifacts_present:\n';
    /** @type {string[]} */ const listing = [];
    const dirs = ['reports', 'results', 'scratch', 'worker-evidence'].filter((d) => isDir(`${this.run}/${d}`));
    dirs.forEach((d, i) => {
      if (i > 0) listing.push('');
      listing.push(`${d}:`);
      try { listing.push(...readdirSync(`${this.run}/${d}`).filter((f) => !f.startsWith('.')).sort()); } catch { /* unreadable */ }
    });
    for (const l of listing.slice(0, 40)) t += `  ${l}\n`;
    t += 'last_output_of_the_worker:\n';
    for (const l of dt.tailLines(this.logText(), 25)) t += `  | ${l.slice(0, 300)}\n`;
    try {
      writeFileSync(this.resumeFile, t, 'latin1');
      if (this.resumeOne !== '') copyFileSync(this.resumeFile, this.resumeOne);
    } catch { /* best effort */ }
    this.note(`dispatch resume note written role=${this.role} file=${this.rel(this.resumeFile)}`);
  }
}
