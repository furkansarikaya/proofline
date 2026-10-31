// @ts-check
// The mkdir lock protocol of agent.sh (lines 58-122, 8944-8967), so that an old-engine and a new-engine process exclude each other:
//   * a lock is a folder made with mkdir (atomic); the holder writes its pid into <lock>/pid and removes both on release;
//   * a waiter whose holder is dead (kill -0 fails) takes the pid file by rename (pid.brk.<own pid>), checks whose it was, and either
//     removes the folder (and, for a run lock, appends the `lock-break` ledger event) or puts the file back untouched;
//   * the lock folders are .agents/local/.lock (older versions), .agents/local/locks/shared.lock (main tree), locks/tree.lock (a
//     worktree) and <run>/.lock.
// Differences from the shell that cannot be seen from outside: one clock reading for ts= and epoch=; no `sleep` process.
import { appendFileSync, accessSync, constants, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { now, sleepSync } from './clock.mjs';
import { fail } from './errors.mjs';
import { sha256 } from './hash.mjs';
import { tmScaled } from './timeouts.mjs';

const DIGITS = /^[0-9]+$/;

/** `kill -0 PID`: true when the signal could be sent (a process of another user answers EPERM, which the shell also counts as failure). @param {number} pid */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** @param {string} p */
function readText(p) { try { return readFileSync(p, 'latin1'); } catch { return ''; } }

/** `$(cat FILE)`: the text without trailing newlines. @param {string} p */
function cat(p) { return readText(p).replace(/\n+$/, ''); }

/** @param {string} p */
function isFileSync(p) { try { return statSync(p).isFile(); } catch { return false; } }
/** @param {string} p */
function isDirSync(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

// --- RUN.yaml access and the ledger: only what the `lock-break` event needs (the full ports come with the stage that moves `records`) ---

/** `sv_load`: "section.key=value" lines of a RUN.yaml, as the awk program prints them. @param {string} text */
export function runSections(text) {
  /** @type {string[]} */ const out = [];
  const seen = new Set();
  let s = '';
  for (const line of text.split('\n')) {
    if (/^[a-z_]+:[ \t\n\v\f\r]*$/.test(line)) { s = line.split(/[ \t\n\v\f\r]+/)[0].replace(/:[^]*$/, ''); continue; }
    if (/^[^ \t\n\v\f\r#]/.test(line)) { s = ''; continue; }
    if (s !== '' && /^ {2}[a-z_0-9]+:/.test(line)) {
      const k = line.slice(2).replace(/:[^]*$/, '');
      const v = line.replace(/^[^:]*:[ \t\n\v\f\r]*/, '').replace(/[ \t\n\v\f\r]+#[^]*$/, '').replace(/"/g, '');
      if (!seen.has(`${s}.${k}`)) { seen.add(`${s}.${k}`); out.push(`${s}.${k}=${v}`); }
    }
  }
  return out;
}

/** `section_value DIR SECTION KEY`, or null when the key is not there. @param {string[]} rows @param {string} section @param {string} key */
function sectionValue(rows, section, key) {
  const prefix = `${section}.${key}=`;
  for (const r of rows) if (r.startsWith(prefix)) return r.slice(prefix.length);
  return null;
}

/** `lifecycle_digest`: the digest of the lifecycle fields of RUN.yaml. @param {string[]} rows */
function lifecycleDigest(rows) {
  /** @param {string} s @param {string} k */
  const lv = (s, k) => `${s}.${k}=${sectionValue(rows, s, k) ?? ''}\n`;
  let t = lv('execution', 'state') + lv('execution', 'knowledge_state') + lv('execution', 'awaiting_input') + lv('execution', 'autonomy')
    + lv('handoff', 'state') + lv('handoff', 'implemented_patch_sha256') + lv('handoff', 'code_done_patch_sha256')
    + lv('pipeline', 'classification') + lv('pipeline', 'review') + lv('pipeline', 'tier')
    + lv('completion_report', 'published') + lv('completion_report', 'adapter') + lv('completion_report', 'receipt');
  if (sectionValue(rows, 'task_source', 'type') === 'local_markdown') t += lv('task_source', 'path') + lv('task_source', 'revision');
  return sha256(t);
}

/**
 * `ledger_append ID EVENT FROM TO DETAIL` for a run: one line, chained to the previous one by its SHA-256.
 * @param {string} runDir @param {string} role the canonical execution role
 * @param {string} event @param {string} from @param {string} to @param {string} detail
 */
export function ledgerAppend(runDir, role, event, from, to, detail) {
  const file = `${runDir}/LEDGER.log`;
  const rows = runSections(readText(`${runDir}/RUN.yaml`));
  let seq = 1;
  let prev = 'genesis';
  let size = 0;
  try { size = statSync(file).size; } catch { /* no ledger yet */ }
  if (size > 0) {
    const lines = readText(file).replace(/\n+$/, '').split('\n');
    const last = lines[lines.length - 1];
    const m = /^seq=([0-9]+) /.exec(last);
    seq = (m ? Number(m[1]) : 0) + 1;
    prev = sha256(last);
  }
  const t = now();
  const one = detail.replace(/[\n\t]/g, ' ');
  const line = `seq=${seq} prev=${prev} event=${event} role=${role} from=${from || '-'} to=${to || '-'} digest=${lifecycleDigest(rows)} ts=${t.iso} epoch=${t.epoch} detail=${one}\n`;
  try { appendFileSync(file, Buffer.from(line, 'latin1')); } catch { fail(`could not append to lifecycle ledger: ${file}`); }
}

/** `gates_enforced ID`: RUN.yaml has the key lifecycle_gates.required. @param {string} runDir */
function gatesEnforced(runDir) {
  return runSections(readText(`${runDir}/RUN.yaml`)).some((r) => r.startsWith('lifecycle_gates.required='));
}

export class LockSet {
  /**
   * @param {import('./context.mjs').Context} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {string[]} */ this.held = [];
  }

  /** `acquire_lock PATH` @param {string} lockPath */
  acquire(lockPath) {
    if (this.held.includes(lockPath)) return;
    const env = this.ctx.env;
    const given = env.PROOFLINE_LOCK_TIMEOUT;
    const timeoutText = given !== undefined && given !== '' ? given : String(tmScaled(this.ctx.config(), 120, 1, 3600));
    if (!DIGITS.test(timeoutText)) fail(`invalid PROOFLINE_LOCK_TIMEOUT: ${timeoutText}`);
    const dir = path.dirname(lockPath);
    try { accessSync(dir, constants.W_OK); } catch {
      fail(`cannot take the lock ${lockPath}: its directory is not writable by this process (a sandbox must grant .agents/local and the run folder)`);
    }
    const timeout = Number(timeoutText);
    const tries = timeout * 5;
    let n = 0;
    let broke = '';
    for (;;) {
      try { mkdirSync(lockPath); break; } catch { /* held, or not creatable */ }
      if (isFileSync(`${lockPath}/pid`)) {
        const pidText = cat(`${lockPath}/pid`);
        if (DIGITS.test(pidText) && !alive(Number(pidText))) {
          // Take the pid file by rename and check whose it was: a holder that took the lock after our read is put back untouched.
          const brk = `${lockPath}/pid.brk.${process.pid}`;
          let moved = false;
          try { renameSync(`${lockPath}/pid`, brk); moved = true; } catch { /* somebody else was faster */ }
          if (moved) {
            if (cat(brk) === pidText) {
              rmSync(brk, { force: true });
              try { rmdirSync(lockPath); } catch { /* not empty or gone */ }
              broke = pidText;
              continue;
            }
            try { renameSync(brk, `${lockPath}/pid`); } catch { /* ignore */ }
          }
        }
      }
      if (n >= tries) fail(`lock timeout after ${timeoutText}s: ${lockPath}`);
      sleepSync(200);
      n++;
    }
    writeFileSync(`${lockPath}/pid`, `${process.pid}\n`);
    this.held.unshift(lockPath);
    const agentsRuns = `${this.ctx.agents}/runs/`;
    if (lockPath.startsWith(agentsRuns) && lockPath.endsWith('/.lock') && broke !== '') {
      const runDir = lockPath.slice(0, -'/.lock'.length);
      if (gatesEnforced(runDir)) ledgerAppend(runDir, this.ctx.role, 'lock-break', '-', '-', `stale lock holder pid=${broke}`);
    }
  }

  /** `take_old_lock PATH` (A199): the lock older versions took; taken when the folder is writable, otherwise only a live holder is waited for. @param {string} lockPath */
  takeOld(lockPath) {
    const given = this.ctx.env.PROOFLINE_LOCK_TIMEOUT;
    const base = given !== undefined && given !== '' ? given : '120';
    if (!DIGITS.test(base)) fail(`invalid PROOFLINE_LOCK_TIMEOUT: ${base}`);
    const total = Number(base) * 5;
    for (let n = 0; n < total; n++) {
      try { mkdirSync(lockPath); try { rmdirSync(lockPath); } catch { /* ignore */ } this.acquire(lockPath); return; } catch (e) {
        if (e instanceof Error && e.name === 'ProoflineError') throw e;
      }
      if (!isDirSync(lockPath)) return; // not there and not creatable: the folder is read-only here
      const p = cat(`${lockPath}/pid`);
      if (!DIGITS.test(p)) { this.acquire(lockPath); return; }
      if (!alive(Number(p))) { this.acquire(lockPath); return; }
      sleepSync(200);
    }
    this.acquire(lockPath);
  }

  /** `release_locks`: only a lock whose pid file holds this process's pid is released. */
  releaseAll() {
    for (const p of this.held) {
      if (isFileSync(`${p}/pid`) && cat(`${p}/pid`) === String(process.pid)) {
        rmSync(`${p}/pid`, { force: true });
        try { rmdirSync(p); } catch { /* not empty */ }
      }
    }
    this.held = [];
  }
}

/**
 * The commands that take no lock although they are not read-only (agent.sh line 8939): they only read the config, or take the locks in
 * a process of their own.
 */
const UNLOCKED = new Set(['approve-pending', 'friction', 'batch-status', 'batch-check', 'batch-next', 'pr-state', 'batch-ci', 'batch-awake', 'batch-park', 'db-config', 'hook-config']);

/**
 * `lock_command`: does this command take the locks (agent.sh lines 8934-8940)?
 * @param {string} command @param {string[]} args the arguments after the command @param {string} role @param {boolean} readOnly
 */
export function takesLocks(command, args, role, readOnly) {
  let lock = !readOnly;
  if (command === 'tier' && role === 'lead') lock = true;
  if (UNLOCKED.has(command) || (command === 'deliver-merged' && args[1] === '--check')) lock = false;
  if (command === 'submit') lock = false;
  return lock;
}

/**
 * The locks of a locking command, in the order of agent.sh (lines 8948-8967): the older .lock, the shared lock (a worktree: its own tree
 * lock first, then the main tree's), then the run's own lock.
 * @param {LockSet} locks @param {import('./context.mjs').Context} ctx @param {string} command @param {string[]} args the arguments after the command
 */
export function takeCommandLocks(locks, ctx, command, args) {
  const agents = ctx.agents;
  mkdirSync(`${agents}/local`, { recursive: true });
  try { mkdirSync(`${agents}/local/locks`, { recursive: true }); } catch { /* read-only here */ }
  locks.takeOld(`${agents}/local/.lock`);
  const main = ctx.sharedMain();
  if (main === ctx.root) {
    if (isDirSync(`${agents}/local/locks`)) locks.acquire(`${agents}/local/locks/shared.lock`);
  } else {
    if (isDirSync(`${agents}/local/locks`)) locks.acquire(`${agents}/local/locks/tree.lock`);
    if (isDirSync(`${main}/.agents/local`)) {
      locks.takeOld(`${main}/.agents/local/.lock`);
      locks.acquire(`${main}/.agents/local/locks/shared.lock`);
    }
  }
  const id = args[0];
  if (command !== 'start' && id && /^[A-Za-z0-9_-]+$/.test(id) && isDirSync(ctx.runDir(id))) locks.acquire(`${ctx.runDir(id)}/.lock`);
}

