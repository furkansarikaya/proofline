// @ts-check
// Night mode (A157, A200, A202) in Node (A225): the state of a batch, derived from its records, and the commands that read or change it:
// `batch-next`, `batch-status`, `batch-answer`, `batch-answers`, `batch-awake`, `batch-park`, `batch-cover`. The plan (`batch-plan`) is in batchplan.mjs.
// There is no driver: the lead runs the tasks in the SAME session, one after the other (run, then deliver, and only when the task is merged the next one);
// this code only reads the state from the records and answers "what is next". Each task runs in a git worktree of its own,
// .agents/local/worktrees/<ID> (A169): a parked task, one waiting for merge or one in a CI-fix round blocks no independent task.
// Files under .agents/local/batch/: SUMMARY.md, order.tsv (ID class depends_on), state.tsv (ID parked reason question: only the lead's own parks),
// merged.tsv (ID PR epoch, written by deliver-step merge), ci.tsv (ID sha epoch: the CI of its merge commit was checked), answers.tsv, lint.tsv, paths.tsv,
// accept.tsv, owner (pid epoch of the session that works the batch), awake.pid / awake (the sleep inhibitor), history/<batch id>/.
// Test seams (PROOFLINE_TEST=1 only): PROOFLINE_UNAME replaces the system name, PROOFLINE_BATCH_INHIBIT=none says no sleep inhibitor is installed,
// PROOFLINE_SESSION_PID names the session process.
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { batchApproval, pendingRequest, sharedDirOf } from './approvals.mjs';
import { approvalBound, nextNum, planTestAcs, requireLead, requireOpenRun, rationaleLine } from './approve.mjs';
import { bytes } from './config.mjs';
import { prView, deliverDir } from './deliver.mjs';
import { ProoflineError, fail } from './errors.mjs';
import { asciiLower } from './shellglob.mjs';
import { hashFile } from './fingerprint.mjs';
import { ledgerToken } from './questions.mjs';
import { ledgerIf } from './lifecycle.mjs';
import { shellChild } from './lifeutil.mjs';
import { isDir, isFile } from './paths.mjs';
import * as proc from './proc.mjs';
import { gateField, readBytes, textLines } from './records.mjs';
import { requireRun, runDir } from './runs.mjs';
import { pipelineClass, pipelineClassValid } from './signals.mjs';
import { CHECK_HANDLERS } from './commands/checks.mjs';
import { batchAnswerRow } from './knownissues.mjs';
import { now } from './clock.mjs';
import { afterFrontMatter } from './taskfile.mjs';

/** @typedef {import('./context.mjs').Context} Context */
/** @typedef {{ id: string, state: string, detail: string, question: string, pr: string, epoch: string }} Row */

export const PLUG_LINE = 'Keep the computer awake (plugged in, lid open) and this session open.';

/** The batch folder, in the main tree from any worktree (A185). @param {Context} ctx */
export const bdOf = (ctx) => `${ctx.sharedMain()}/.agents/local/batch`;
/** `cd DIR && pwd -P`, or the path itself. @param {string} d */
function physical(d) { try { return realpathSync(d); } catch { return d; } }

/** `tsv`: tabs and newlines of a text become spaces. @param {string} s */
export const tsvText = (s) => s.replace(/[\t\n]/g, ' ');
const rd = (/** @type {string} */ f) => readBytes(f) ?? '';
const rows = (/** @type {string} */ f) => textLines(rd(f)).map((l) => l.split('\t'));

/** `bid`: the first 12 hex digits of the sha256 of the summary. @param {Context} ctx */
export function bid(ctx) { return hashFile(`${bdOf(ctx)}/SUMMARY.md`).slice(0, 12); }

/** The worktree folder base of the tasks (physical). @param {Context} ctx */
const wtbOf = (ctx) => `${physical(ctx.root)}/.agents/local/worktrees`;

/** Run a command of this core in process (a read-only one takes no lock), or its shell code when no runner exists. @param {Context} ctx @param {string[]} argv @returns {{ status: number, out: string, err: string }} */
export function agentCall(ctx, argv) {
  if (ctx.runner !== null) {
    /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
    const status = ctx.runner(argv, { env: ctx.env, cwd: ctx.root, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) }, scriptPath: ctx.scriptPath, isProcess: false });
    return { status, out: Buffer.concat(out).toString('latin1'), err: Buffer.concat(err).toString('latin1') };
  }
  return shellChild(ctx, argv);
}

/** Call a handler of this core, keeping what it wrote out of this command's output. @param {Context} ctx @param {() => number} fn @returns {{ status: number, out: string }} */
function captured(ctx, fn) {
  const mark = ctx.chunks.length;
  let status = 0;
  try { status = fn(); } catch (e) { if (e instanceof ProoflineError) status = e.exitCode; else throw e; }
  const added = ctx.chunks.splice(mark);
  return { status, out: added.filter((c) => c[0] === 'out').map((c) => c[1].toString('latin1')).join('') };
}

// ---- the task files -------------------------------------------------------------------------------------------------------------------------

/** `tid FILE` (A202): the ID in the H1 of a task file, the file name only when there is none. @param {string} file */
export function tid(file) {
  const base = path.basename(file, '.md');
  const first = textLines(rd(file))[0] ?? '';
  const m = /^# Task: *([^ ]*)/.exec(first);
  const id = m ? m[1] : '';
  if (id !== '' && (base === id || (base.startsWith(`${id}-`) && base.length > id.length + 1))) return id;
  return base;
}
/** The names of `DIR/*.md` that are files, sorted. @param {string} dir */
export function mdFiles(dir) {
  try { return readdirSync(dir, { encoding: 'latin1' }).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort().map((n) => `${dir}/${Buffer.from(n, 'latin1').toString('utf8')}`).filter((f) => isFile(f)); } catch { return []; }
}
/** `tfile ID`: the path of the queued task file (top level, todo/, backlog/), or null. @param {string} td @param {string} id */
export function tfile(td, id) {
  for (const d of [td, `${td}/todo`, `${td}/backlog`]) {
    if (isFile(`${d}/${id}.md`)) return `${d}/${id}.md`;
    for (const f of mdFiles(d)) {
      const b = path.basename(f);
      if (!b.startsWith(`${id}-`)) continue;
      const rest = b.slice(id.length + 1);
      if (rest.startsWith('FU') && /^[0-9]/.test(rest.slice(2))) continue;
      if (tid(f) !== id) continue;
      return f;
    }
  }
  return null;
}

// ---- state ----------------------------------------------------------------------------------------------------------------------------------

/** `st_get ID COL`: a column of the lead's own park of the task. @param {Context} ctx @param {string} id @param {number} col */
function stGet(ctx, id, col) {
  const r = rows(`${bdOf(ctx)}/state.tsv`).find((f) => f[0] === id);
  return r ? (r[col - 1] ?? '') : '';
}
/** `merged_pr ID`: the PR of the last merged row of the task, or null. @param {Context} ctx @param {string} id */
export function mergedPr(ctx, id) {
  let p = null;
  for (const f of rows(`${bdOf(ctx)}/merged.tsv`)) if (f[0] === id) p = f[1] ?? '';
  return p;
}
/** `rroot ID`: where the task's run lives: its own worktree, else the main working tree. @param {Context} ctx @param {string} id */
function rroot(ctx, id) { return isDir(`${wtbOf(ctx)}/${id}/.agents`) ? `${wtbOf(ctx)}/${id}` : ctx.root; }
/** `rsec ID SECTION KEY`: a value of the run's RUN.yaml. @param {Context} ctx @param {string} id @param {string} sec @param {string} key */
function rsec(ctx, id, sec, key) {
  const text = readBytes(`${rroot(ctx, id)}/.agents/runs/${id}/RUN.yaml`);
  if (text === null) return '';
  let inside = false;
  for (const l of text.split('\n')) {
    if (l === `${sec}:`) { inside = true; continue; }
    if (inside && /^[^ #]/.test(l)) return '';
    if (inside && l.startsWith(`  ${key}:`)) return l.replace(/^[^:]*:[ \t\n\v\f\r]*/, '').replace(/"/g, '');
  }
  return '';
}
const hasRun = (/** @type {Context} */ ctx, /** @type {string} */ id) => isFile(`${rroot(ctx, id)}/.agents/runs/${id}/RUN.yaml`);

/** `open_question ID`: the first line of the first unanswered question, from the run's records. @param {Context} ctx @param {string} id */
function openQuestion(ctx, id) {
  const qd = `${rroot(ctx, id)}/.agents/runs/${id}/questions`;
  /** @type {string[]} */ let names = [];
  try { names = readdirSync(qd, { encoding: 'latin1' }).filter((n) => /^[0-9]{3}\.md$/.test(n)).sort(); } catch { return ''; }
  for (const n of names) {
    const f = `${qd}/${n}`;
    if (existsSync(`${f.slice(0, -3)}.answer.md`)) continue;
    const text = readBytes(f);
    if (text === null) continue;
    return afterFrontMatter(text)[0] ?? '';
  }
  return '';
}
/** `pending_approval ID`: the kind of an approval request nobody answered, or null. @param {Context} ctx @param {string} id */
function pendingApproval(ctx, id) {
  const d = `${rroot(ctx, id)}/.agents/runs/${id}/approvals`;
  /** @type {string[]} */ let names = [];
  try { names = readdirSync(d).sort(); } catch { return null; }
  for (const b of names) {
    const m = /^([0-9]{3})-request-(.*)\.yaml$/.exec(b);
    if (!m) continue;
    const n = Number(m[1]); const k = m[2];
    let answered = false;
    for (const a of names) { const am = /^([0-9]{3})-(.*)\.yaml$/.exec(a); if (am && am[2] === k && !(Number(am[1]) < n)) answered = true; }
    if (!answered) return k;
  }
  return null;
}
/** `fmt_ts`: an epoch as local date and time. @param {string} t */
function fmtTs(t) {
  if (t === '') return '-';
  if (!/^[0-9]+$/.test(t)) return t;
  const d = new Date(Number(t) * 1000);
  const p = (/** @type {number} */ x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `ans_row ID KIND`: the newest recorded answer for the batch in force: [letter, question number], or null. @param {Context} ctx @param {string} id @param {string} kind */
export function ansRow(ctx, id, kind) {
  const f = `${bdOf(ctx)}/answers.tsv`;
  if (!isFile(f)) return null;
  const b = bid(ctx);
  /** @type {string[] | null} */ let r = null;
  for (const x of rows(f)) if (x[0] === b && x[1] === id && x[3] === kind) r = [x[4] ?? '', x[2] ?? ''];
  return r;
}

/**
 * `own_state ID`: open or parked, the detail (the action of an open task, the reason of a parked one) and the question, from the lead's own parks and the
 * task's run records. A run with an unanswered question, a FAILED or BLOCKED run, an approval request the batch does not cover and an open pull request park
 * the task; an answered question or a reopened run un-parks it by itself.
 * @param {Context} ctx @param {string} id @returns {{ ds: string, dd: string, dq: string }}
 */
function ownState(ctx, id) {
  if (stGet(ctx, id, 2) === 'parked') return { ds: 'parked', dd: stGet(ctx, id, 3), dq: stGet(ctx, id, 4) };
  // A200: a task whose pre-flight answer is "park until it is decided or written" never starts; the answer is the user's own
  if (!hasRun(ctx, id)) {
    for (const k of ['dep', 'ac', 'scope', 'type']) {
      const a = ansRow(ctx, id, k);
      if (a === null) continue;
      if (a[0] === 'b' && k === 'dep') return { ds: 'parked', dd: 'new dependency', dq: `you answered ${a[1]} with b: a dependency is needed and only you approve it; decide it, then agent.sh batch-park ${id} --clear` };
      if (a[0] === 'a' && k === 'scope') return { ds: 'parked', dd: 'allowed scope', dq: `you answered ${a[1]} with a: the task's Allowed scope is widened (or the path dropped) by you first; then agent.sh batch-park ${id} --clear` };
      if (a[0] === 'a' && k === 'type') return { ds: 'parked', dd: 'type sections to write', dq: `you answered ${a[1]} with a: the sections the task type needs are written (task-author) first; then agent.sh batch-park ${id} --clear` };
      if (a[0] === 'a' && k === 'ac') return { ds: 'parked', dd: 'criteria to write', dq: `you answered ${a[1]} with a: the acceptance criteria are written (task-author) first; then agent.sh batch-park ${id} --clear` };
    }
  }
  if (!hasRun(ctx, id)) return { ds: 'open', dd: 'run', dq: '' };
  const es = rsec(ctx, id, 'execution', 'state');
  if (es === 'FAILED' || es === 'BLOCKED') return { ds: 'parked', dd: es, dq: '' };
  const q = openQuestion(ctx, id);
  if (q !== '') return { ds: 'parked', dd: 'question', dq: q };
  const ak = pendingApproval(ctx, id);
  if (ak !== null) {
    if (ak === 'plan' || ak === 'mutation_budget') return { ds: 'open', dd: `cover ${ak}`, dq: '' };
    if (/^(commit|push|pr|merge|cleanup)$/.test(ak)) return { ds: 'open', dd: 'cover delivery', dq: '' };
    return { ds: 'parked', dd: 'approval request', dq: ak };
  }
  const rr = rroot(ctx, id);
  const prFile = `${rr}/.agents/local/deliver/${id}/PR`;
  try {
    if (statSync(prFile).size > 0) {
      // the merge step ran but merged.tsv has no record: ask the platform (a session died after the merge, or the user merged by hand)
      const pr = rd(prFile).replace(/\n+$/, '');
      let ps = 'unreadable';
      if (/^[0-9]+$/.test(pr)) {
        const mark = ctx.chunks.length;
        try { ps = prView(ctx, pr).split('\n')[0].split(' ')[0]; } catch { ps = ''; }
        ctx.chunks.length = mark;
      }
      if (ps === 'MERGED') return { ds: 'open', dd: 'deliver cleanup', dq: pr };
      if (ps === 'OPEN') return { ds: 'parked', dd: 'awaiting merge', dq: `pull request ${pr} is open and not merged` };
      return { ds: 'parked', dd: 'awaiting merge', dq: `pull request ${pr}: its state cannot be read (platform tool missing, not logged in or not supported); look at it yourself` };
    }
  } catch { /* no PR file */ }
  // the user merges (platform other, a local origin): the delivered commit is kept in MERGE_HEAD; git says whether it was merged
  const dd = `${rr}/.agents/local/deliver/${id}`;
  const sum = rd(`${dd}/SUMMARY.md`);
  let waits = false;
  try { waits = statSync(`${dd}/MERGE_HEAD`).size > 0; } catch { waits = false; }
  if (!waits && textLines(sum).includes('merge_by: user')) {
    const br = (textLines(sum).find((l) => l.startsWith('branch: ')) ?? '').slice(8);
    waits = proc.run('git', ['-C', rr, 'rev-parse', '-q', '--verify', `refs/remotes/origin/${br}`], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'ignore', 'ignore'] }).status === 0;
  }
  if (waits) {
    if (agentCall(ctx, ['deliver-merged', id, '--check']).status === 0) return { ds: 'open', dd: 'deliver merged', dq: '' };
    return { ds: 'parked', dd: 'awaiting merge', dq: `the branch of ${id} is pushed and waits for YOUR merge into origin's ${ctx.config().get('canonical_branch', 'main')} (for example: git push origin <branch>:${ctx.config().get('canonical_branch', 'main')}); then /proofline batch continues` };
  }
  const hs = rsec(ctx, id, 'handoff', 'state');
  return { ds: 'open', dd: hs === 'CODE_DONE' || hs === 'DONE' ? 'deliver' : 'resume', dq: '' };
}

/**
 * `derive`: one row per task of order.tsv, in order: ID state detail question PR merge-epoch. State: merged, parked, skipped (a dependency is parked or
 * skipped), waiting (a dependency is still open) or open (detail: the action).
 * @param {Context} ctx @returns {Row[]}
 */
export function derive(ctx) {
  const bd = bdOf(ctx);
  if (!isFile(`${bd}/order.tsv`)) return [];
  const order = rows(`${bd}/order.tsv`);
  const paths = rows(`${bd}/paths.tsv`);
  const hasPaths = paths.length > 0 && statSync(`${bd}/paths.tsv`).size > 0;
  /** @type {Row[]} */ const dv = [];
  const stateOf = (/** @type {string} */ t) => dv.find((r) => r.id === t)?.state ?? '';
  const depsOf = (/** @type {string} */ t) => ((order.find((f) => f[0] === t) ?? [])[2] ?? '').replace(/,/g, ' ').split(' ').filter((x) => x !== '' && x !== '-');
  const orderIndex = (/** @type {string} */ t) => order.findIndex((f) => f[0] === t);
  for (const f of order) {
    const id = f[0];
    let s = ''; let d = ''; let q = ''; let p = ''; let t = '';
    const mp = mergedPr(ctx, id);
    if (mp !== null) {
      s = 'merged'; p = mp;
      for (const x of rows(`${bd}/merged.tsv`)) if (x[0] === id) t = x[2] ?? '';
    } else {
      for (const dep of depsOf(id)) {
        if (mergedPr(ctx, dep) !== null) continue;
        const ds = stateOf(dep);
        if (ds === '') continue; // done before this batch: planned only when it is in done/
        if (ds === 'parked' || ds === 'skipped') { s = 'skipped'; d = `depends on ${dep} (${ds})`; break; }
        s = 'waiting'; d = `depends on ${dep} (not merged yet)`; break;
      }
      // A200: a task that names a code path an earlier task of the batch names too waits until that task is merged (the same file in two open branches is a
      // conflict at merge); a dependency that is not earlier in the order is not "done before this batch" either
      if (s === '') {
        for (const dep of depsOf(id)) {
          if (mergedPr(ctx, dep) !== null) continue;
          if (orderIndex(dep) < 0) continue;
          if (!dv.some((r) => r.id === dep)) { s = 'waiting'; d = `depends on ${dep} (later in the order, not merged yet)`; break; }
        }
      }
      if (s === '' && hasPaths) {
        const mine = new Set(paths.filter((x) => x[0] === id).map((x) => x[1]));
        for (const x of paths) {
          if (x[0] === id || !mine.has(x[1])) continue;
          // only a task that comes EARLIER in the order and is not merged
          const xi = orderIndex(x[0]); const me = orderIndex(id);
          if (xi >= 0 && xi < me && mergedPr(ctx, x[0]) === null) {
            const ds = stateOf(x[0]);
            if (ds === 'parked' || ds === 'skipped') { s = 'skipped'; d = `shares ${x[1]} with ${x[0]} (${ds})`; } else { s = 'waiting'; d = `shares ${x[1]} with ${x[0]} (not merged yet)`; }
            break;
          }
        }
      }
      if (s === '') { const o = ownState(ctx, id); s = o.ds; d = o.dd; q = o.dq; }
    }
    dv.push({ id, state: s, detail: tsvText(d), question: tsvText(q), pr: p, epoch: t });
  }
  return dv;
}
/** `ci_pending`: the latest merged task of this batch whose merge commit's CI was not checked yet, or ''. @param {Context} ctx */
function ciPending(ctx) {
  const bd = bdOf(ctx);
  let size = 0;
  try { size = statSync(`${bd}/merged.tsv`).size; } catch { return ''; }
  if (size === 0) return '';
  const inOrder = new Set(rows(`${bd}/order.tsv`).map((f) => f[0]));
  let id = '';
  for (const f of rows(`${bd}/merged.tsv`)) if (inOrder.has(f[0])) id = f[0];
  if (id === '') return '';
  if (rows(`${bd}/ci.tsv`).some((f) => f[0] === id)) return '';
  return id;
}
/** `derive_state`: nobatch | unapproved | approved (work is left) | finished-parked | finished-clean. @param {Context} ctx @param {Row[]} [given] */
export function deriveState(ctx, given) {
  const bd = bdOf(ctx);
  if (!(isFile(`${bd}/SUMMARY.md`) && isFile(`${bd}/order.tsv`))) return 'nobatch';
  if (batchApproval(ctx) === null) return 'unapproved';
  const rs = given ?? derive(ctx);
  if (rs.some((r) => r.state === 'open' || r.state === 'waiting') || ciPending(ctx) !== '') return 'approved';
  if (rs.some((r) => r.state === 'parked' || r.state === 'skipped')) return 'finished-parked';
  return 'finished-clean';
}
/** @param {Context} ctx */
function approvedAt(ctx) {
  const sum = hashFile(`${bdOf(ctx)}/SUMMARY.md`);
  const ad = `${sharedDirOf(ctx, 'approvals')}`;
  /** @type {string[]} */ let names = [];
  try { names = readdirSync(ad).filter((n) => /^[0-9]{3}-batch\.yaml$/.test(n)).sort(); } catch { return ''; }
  let at = '';
  for (const n of names) {
    const t = rd(`${ad}/${n}`);
    if (textLines(t).some((l) => l === `bound: "${sum}"`)) at = (textLines(t).find((l) => l.startsWith('approved_at: ')) ?? '').slice(13);
  }
  return at === '' ? '' : fmtTs(at);
}

// ---- processes: the session and the sleep inhibitor ------------------------------------------------------------------------------------------

/** The state letters of `ps -o stat=` for a pid: '' when there is no such process. @param {number} pid */
function pidStat(pid) {
  try { process.kill(pid, 0); } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ESRCH') return ''; }
  const r = proc.run('ps', ['-o', 'stat=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
  return r.stdout.toString('latin1').replace(/ /g, '').replace(/\n/g, '');
}
const seamOn = (/** @type {Context} */ ctx) => ctx.env.PROOFLINE_TEST === '1';
/** `uname_s` @param {Context} ctx */
function unameS(ctx) {
  if (seamOn(ctx) && (ctx.env.PROOFLINE_UNAME ?? '') !== '') return /** @type {string} */ (ctx.env.PROOFLINE_UNAME);
  const p = os.platform();
  return p === 'darwin' ? 'Darwin' : p === 'linux' ? 'Linux' : p;
}
/** @param {Context} ctx @param {string} name */
function onPath(ctx, name) {
  for (const d of (ctx.env.PATH ?? '').split(':')) { if (d !== '' && isFile(`${d}/${name}`)) { try { return (statSync(`${d}/${name}`).mode & 0o111) !== 0; } catch { /* next */ } } }
  return false;
}
/** `inhibit_kind`: caffeinate | systemd-inhibit | none. @param {Context} ctx */
function inhibitKind(ctx) {
  if (seamOn(ctx) && ctx.env.PROOFLINE_BATCH_INHIBIT === 'none') return 'none';
  switch (unameS(ctx)) {
    case 'Darwin': return onPath(ctx, 'caffeinate') ? 'caffeinate' : 'none';
    case 'Linux': return onPath(ctx, 'systemd-inhibit') ? 'systemd-inhibit' : 'none';
    default: return 'none';
  }
}
/** The process table: pid -> [ppid, command name]. One read of /proc on Linux, one `ps` elsewhere. @returns {Map<number, [number, string]>} */
function processTable() {
  /** @type {Map<number, [number, string]>} */ const t = new Map();
  if (os.platform() === 'linux' && isDir('/proc/self')) {
    try {
      for (const n of readdirSync('/proc')) {
        if (!/^[0-9]+$/.test(n)) continue;
        const s = readBytes(`/proc/${n}/stat`);
        if (s === null) continue;
        const close = s.lastIndexOf(')');
        const open = s.indexOf('(');
        const rest = s.slice(close + 2).split(' ');
        t.set(Number(n), [Number(rest[1]), s.slice(open + 1, close)]);
      }
      return t;
    } catch { /* fall through to ps */ }
  }
  const r = proc.run('ps', ['-A', '-o', 'pid=,ppid=,comm='], { stdio: ['ignore', 'pipe', 'ignore'] });
  for (const l of r.stdout.toString('latin1').split('\n')) {
    const m = /^ *([0-9]+) +([0-9]+) +(.*)$/.exec(l);
    if (m) t.set(Number(m[1]), [Number(m[2]), m[3].replace(/.*\//, '')]);
  }
  return t;
}
/** `session_pid`: the agent session's own process (claude or codex), found by walking up the parents of this process; null when there is none. @param {Context} ctx @returns {string | null} */
function sessionPid(ctx) {
  if (seamOn(ctx) && (ctx.env.PROOFLINE_SESSION_PID ?? '') !== '') return /** @type {string} */ (ctx.env.PROOFLINE_SESSION_PID);
  const table = processTable();
  let p = process.pid;
  for (let i = 0; i < 12; i++) {
    const e = table.get(p);
    if (!e) break;
    p = e[0];
    if (p === 0 || p === 1 || Number.isNaN(p)) break;
    const c = table.get(p);
    if (c && (c[1] === 'claude' || c[1] === 'codex')) return String(p);
  }
  return null;
}
/** `awake_line` @param {Context} ctx @returns {string} */
function awakeLine(ctx) {
  const bd = bdOf(ctx);
  if (!(isFile(`${bd}/awake.pid`) && isFile(`${bd}/awake`))) return '';
  const p = rd(`${bd}/awake.pid`).replace(/\n+$/, '');
  if (!/^[0-9]+$/.test(p) || p === '0' || p === '1') return '';
  const st = pidStat(Number(p));
  return st === '' || st.startsWith('Z') ? 'awake: the sleep inhibitor ended (the session it was tied to is gone)\n' : rd(`${bd}/awake`);
}
/** `claim_owner`: one session works a batch; another live session gets `wait` (its pid), a dead owner is taken over. Only the lead claims. @param {Context} ctx @returns {string} the other session's pid, or '' */
function claimOwner(ctx) {
  if (ctx.role !== 'lead') return '';
  const me = sessionPid(ctx);
  if (me === null) return '';
  const bd = bdOf(ctx);
  const owner = (rd(`${bd}/owner`).split('\n')[0] ?? '').split('\t')[0];
  if (owner !== '' && owner !== me) {
    const st = /^[0-9]+$/.test(owner) ? pidStat(Number(owner)) : '';
    if (!(st === '' || st.startsWith('Z'))) return owner;
  }
  try { writeFileSync(`${bd}/owner`, `${me}\t${now().epoch}\n`); } catch { /* read-only here: no claim */ }
  return '';
}

// ---- batch-next ---------------------------------------------------------------------------------------------------------------------------

/** `next_report [--tsv]`: the digest the lead re-reads before every task. @param {Context} ctx @param {boolean} [tsv] */
export function nextReport(ctx, tsv = false) {
  const rs = derive(ctx);
  const state = deriveState(ctx, rs);
  if (tsv) {
    ctx.out(`state\t${state}\n`);
    for (const r of rs) ctx.out(`${[r.id, r.state, r.detail, r.question].join('\t')}\n`);
    return;
  }
  if (state === 'nobatch') { ctx.out('no batch planned (agent.sh batch-plan <ID...|all>)\n'); return; }
  if (state === 'unapproved') {
    ctx.out(`batch ${bid(ctx)}: NOT approved (or the summary changed): the user replies "approve batch" to the summary; nothing runs before.\nNEXT: approve\n`);
    return;
  }
  ctx.out(`batch ${bid(ctx)}, approved at ${approvedAt(ctx)}\n`);
  ctx.out(awakeLine(ctx));
  const wait = claimOwner(ctx);
  ctx.out('task | state | detail | pending question\n');
  // A202: a parked task is written PARKED (not "parked", not a running state) and the reason leads its detail; the pending question stays last
  for (const r of rs) ctx.out(`${r.id} | ${r.state === 'parked' ? 'PARKED' : r.state} | ${r.detail === '' ? '-' : r.detail} | ${r.question === '' ? '-' : r.question}\n`);
  const ci = ciPending(ctx);
  const open = rs.find((r) => r.state === 'open');
  if (wait !== '') {
    ctx.out(`NEXT: wait (owned by pid ${wait})   (pid ${wait} is another live session; if it is yours, run the batch there or close it; do not start a second one. If that session is gone, ask again: a dead owner is taken over)\n`);
    return;
  }
  const cc = captured(ctx, () => CHECK_HANDLERS['commands-check'](ctx, []));
  if (cc.status === 0) {
    // A200: the approved summary named a proven commands proposal that is not written yet: writing it comes first, before any task starts
    ctx.out(`NEXT: commands   (proofline doctor --apply-commands: ${cc.out.replace(/\n+$/, '')}; the batch approval covers writing exactly this proposal, and it must be written before the first task so every run gates on the project's own build, test and lint)\n`);
  } else if (ci !== '') {
    ctx.out(`NEXT: ci ${ci}   (agent.sh batch-ci ${ci}: the CI of its merge commit; red or no run in time: stop the batch)\n`);
  } else if (open) {
    const id = open.id; const act = open.detail;
    if (act === 'run') ctx.out(`NEXT: run ${id}   (agent.sh worktree-add ${id}, then /proofline run ${id} with .agents/local/worktrees/${id} as the working folder)\n`);
    else if (act === 'resume') {
      const rr = rroot(ctx, id);
      const where = rr.startsWith(ctx.root) ? rr.slice(ctx.root.length).replace(/^\/+/, '') : rr;
      ctx.out(`NEXT: resume ${id}   (agent.sh next ${id}, in ${where === '' ? 'the main working tree' : where})\n`);
    } else if (act.startsWith('cover ')) ctx.out(`NEXT: cover ${id} ${act.slice(6)}   (agent.sh batch-cover ${id} ${act.slice(6)})\n`);
    else if (act === 'deliver cleanup') ctx.out(`NEXT: deliver ${id} cleanup ${open.question}   (pull request ${open.question} is merged but not recorded: agent.sh deliver-step ${id} cleanup ${open.question} records the merge and cleans up)\n`);
    else if (act === 'deliver merged') ctx.out(`NEXT: deliver ${id} merged   (the user merged it on origin: agent.sh deliver-merged ${id} proves that from git, records the merge and cleans up the run and its worktree)\n`);
    else if (act === 'deliver') ctx.out(`NEXT: deliver ${id}   (the whole delivery of the lead skill; the approval is covered by batch-cover ${id} delivery)\n`);
  } else if (state === 'finished-parked') ctx.out('NEXT: finished   (parked or skipped tasks wait for the user: answer their questions or reopen the run, then /proofline batch continues)\n');
  else ctx.out('NEXT: finished\n');
}

/** `batch-next [--tsv]`: read-only (but the owner claim), every role may read the digest. @param {Context} ctx @param {string[]} args */
export function batchNext(ctx, args) {
  ctx.fpMode = 'yes';
  nextReport(ctx, args[0] === '--tsv');
  return 0;
}

// ---- batch-status -------------------------------------------------------------------------------------------------------------------------

/** `batch-status`: the morning table, from the same records, never from a log. @param {Context} ctx */
export function batchStatus(ctx) {
  ctx.fpMode = 'yes';
  const bd = bdOf(ctx);
  if (!(isFile(`${bd}/SUMMARY.md`) && isFile(`${bd}/order.tsv`))) { ctx.out('no batch planned (agent.sh batch-plan <ID...|all>)\n'); return 0; }
  ctx.out(`batch ${bid(ctx)}, approved at ${approvedAt(ctx)}\n`);
  ctx.out(awakeLine(ctx));
  ctx.out('\ntask | result | PR | merge | park reason | pending question\n');
  for (const r of derive(ctx)) {
    let s = r.state; let d = r.detail;
    if (s === 'open' || s === 'waiting') { s = 'pending'; d = ''; } else if (s === 'parked') s = 'PARKED'; // A202: a parked task never reads like a running or pending one
    const t = r.epoch === '' ? '' : fmtTs(r.epoch);
    ctx.out(`${r.id} | ${s} | ${r.pr === '' ? '-' : r.pr} | ${t === '' ? '-' : t} | ${d === '' ? '-' : d} | ${r.question === '' ? '-' : r.question}\n`);
  }
  ctx.out('\n');
  const fr = proc.run('sh', [`${ctx.trustedScripts}/friction.sh`, 'show'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  ctx.out(fr.stdout.toString('latin1'));
  if (fr.status !== 0) ctx.out('no friction report\n');
  ctx.out('\nresume: answer the open questions (or reopen a run), then run /proofline batch in a session; merged tasks are not run again.\n');
  return 0;
}

// ---- the user's answers to the pre-flight questions (A200) --------------------------------------------------------------------------------

const NEG_RE = new RegExp(`(^|[^a-z])(not|never|no|nope|n.t|dont|do not|without|degil|${bytes('değil')}|hayir|${bytes('hayır')}|bolme|${bytes('bölme')})([^a-z]|$)`);
const ONE = /(^|[^a-z0-9])q[0-9]+/;

/** The segment of a lower-cased message after the token of question QN, up to the next question token. @param {string} low @param {string} qn */
function segmentOf(low, qn) {
  let s = low;
  const q = asciiLower(qn);
  for (;;) {
    const m = ONE.exec(s);
    if (!m) return '';
    const tok = m[0].replace(/^[^q]*/, '');
    s = s.slice(m.index + m[0].length);
    const n = ONE.exec(s);
    const seg = n ? s.slice(0, n.index) : s;
    if (tok === q) return seg;
  }
}

/** `batch-answer` (A200): record the user's answers from their newest captured message that is newer than the summary and not used by another answer. @param {Context} ctx */
export function batchAnswer(ctx) {
  requireLead(ctx);
  const bd = bdOf(ctx);
  if (!(isFile(`${bd}/lint.tsv`) && isFile(`${bd}/SUMMARY.md`))) fail('batch: no batch plan to answer (agent.sh batch-plan <ID...|all>)');
  if (statSync(`${bd}/lint.tsv`).size === 0) { ctx.out('batch: the summary asks no pre-flight question\n'); return 0; }
  const pd = sharedDirOf(ctx, 'prompts');
  const hist = `${pd}/history`;
  const b = bid(ctx);
  let from = Math.floor(statSync(`${bd}/SUMMARY.md`).mtimeMs / 1000);
  if (!Number.isFinite(from)) from = now().epoch;
  const consumed = new Set(textLines(rd(`${pd}/consumed`)));
  let pick = '';
  /** @type {string[]} */ let names = [];
  try { names = readdirSync(hist, { encoding: 'latin1' }).filter((n) => n.endsWith('.txt')).sort(); } catch { names = []; }
  for (const n of names) {
    const e = n.slice(0, n.indexOf('-') < 0 ? n.length : n.indexOf('-'));
    if (e === '' || /[^0-9]/.test(e)) continue;
    if (!(Number(e) >= from)) continue;
    const text = rd(`${hist}/${Buffer.from(n, 'latin1').toString('utf8')}`);
    if (!/[^ \t\n\v\f\r]/.test(text) || text.startsWith('<task-notification>')) continue;
    if (consumed.has(n)) continue;
    // a message that carries no question number and no "recommended" is not an answer: it may be the approval or a remark
    if (!new RegExp(`(^|[^a-z0-9])q[0-9]+|recommended|${bytes('önerilen')}|onerilen`).test(asciiLower(text))) continue;
    pick = n;
  }
  if (pick === '') fail("batch: no captured user message since the summary answers a question (the user answers Q1, Q2 ... or says 'all recommended'; then run this again)");
  const low = asciiLower(rd(`${hist}/${Buffer.from(pick, 'latin1').toString('utf8')}`)).replace(/\n/g, ' ').replace(/ +/g, ' ');
  const T = bytes('tümü'); const O = bytes('önerilen');
  const all = new RegExp(`(all|every|hepsi|${T}|tumu)[^.]{0,20}(recommended|${O}|onerilen)|(recommended|${O}|onerilen)[^.]{0,12}(all|for all|hepsi|${T}|tumu)`).test(low);
  let count = 0;
  for (const row of textLines(rd(`${bd}/lint.tsv`)).map((l) => l.split('\t'))) {
    const [qn, qid, qkind, , qopts, qrec, qparam] = row;
    const seg = segmentOf(low, qn);
    let l = '';
    if (seg !== '') {
      const t = seg.replace(/^[ :.)=,-]*/, '');
      const one = t.replace(new RegExp(`^(option|answer|choose|${bytes('seçenek')}|secenek) *`), '').replace(/[ ,.;)(-]*$/, '');
      if (/^[a-e]$/.test(one)) l = one;
      if (l === '') {
        if (qkind === 'split') {
          const BO = bytes('bölme'); const BOL = bytes('böl'); const HI = bytes('hayır');
          if (new RegExp(`proceed without splitting|do not split|dont split|don.t split|no split|(^|[^a-z])(${BO}|bolme)([^a-z]|$)|${bytes('bölmeden')}|bolmeden`).test(t)) l = 'b';
          else if (new RegExp(`^(no|${HI}|hayir)([^a-z]|$)`).test(t)) {
            // a leading "no" that also says to split ("no problem, split it") is ambiguous: left unanswered, asked again at freeze
            l = new RegExp(`(^|[^a-z])(split|${BOL}|bol)`).test(t) ? '' : 'b';
          } else if (new RegExp(`(^|[^a-z])(split|${BOL}|bol|yes|evet|recommended|${O}|onerilen)([^a-z]|$)`).test(t) && !NEG_RE.test(t)) l = 'a';
        } else if (new RegExp(`^(recommended|your recommendation|${O}|onerilen|yes|evet|ok|okay|keep)([^a-z]|$)`).test(t) && !NEG_RE.test(t)) l = qrec;
        // question c of class: "standard" or "complex" in words
        if (l === '' && qkind === 'class' && t.startsWith('standard')) l = 'b';
      }
    } else if (all) l = qrec;
    if (l === '') continue;
    if (!qopts.includes(`${l})`)) continue;
    const param = qkind === 'split' && l === 'b' ? qparam : '-';
    appendFileSync(`${bd}/answers.tsv`, `${b}\t${qid}\t${qn}\t${qkind}\t${l}\t${param}\t${pick}\n`);
    count++;
    ctx.out(`batch: ${qn} (${qid}, ${qkind}): option ${l} recorded from the user's message ${pick}\n`);
  }
  if (count === 0) fail(`batch: the user's message ${pick} answers no question in a form this script understands (letters after the question number, or 'all recommended'); the unanswered questions are asked again at freeze`);
  appendFileSync(`${pd}/consumed`, `${pick}\n`);
  return 0;
}

/** `batch-answers [ID]` (A200): the recorded answers of the batch in force, one per line. @param {Context} ctx @param {string[]} args */
export function batchAnswers(ctx, args) {
  const bd = bdOf(ctx);
  if (!isFile(`${bd}/answers.tsv`)) { ctx.out('no answers recorded\n'); return 0; }
  const b = bid(ctx);
  const t = args[0] ?? '';
  for (const f of rows(`${bd}/answers.tsv`)) {
    if (f[0] === b && (t === '' || f[1] === t)) ctx.out(`${f[2]} ${f[1]} ${f[3]}: option ${f[4]}${(f[5] ?? '') !== '-' && f[5] !== undefined && f[5] !== '' ? ` (up to ${f[5]})` : ''}\n`);
  }
  return 0;
}

// ---- keep the computer awake, park ------------------------------------------------------------------------------------------------------------

/** `batch-awake`: the sleep inhibitor belongs to the session (macOS: caffeinate -i -w <the session's pid>; Linux: systemd-inhibit held while the session lives). @param {Context} ctx */
export function batchAwake(ctx) {
  requireLead(ctx);
  const kind = inhibitKind(ctx);
  if (kind === 'none') { ctx.out(`sleep inhibitor: none available (no caffeinate or systemd-inhibit); the machine may sleep and stop the batch. ${PLUG_LINE}\n`); return 0; }
  const sess = sessionPid(ctx);
  if (sess === null) {
    ctx.out(`could not find the agent session process to tie the sleep inhibitor to; start one yourself in a terminal: ${kind === 'caffeinate' ? 'caffeinate -i' : 'systemd-inhibit --what=idle:sleep sleep infinity'}. ${PLUG_LINE}\n`);
    return 1;
  }
  const bd = bdOf(ctx);
  mkdirSync(bd, { recursive: true });
  if (isFile(`${bd}/awake.pid`)) {
    const m = /\(session pid ([0-9]*)\)/.exec(rd(`${bd}/awake`));
    if (m && m[1] === sess) {
      const o = rd(`${bd}/awake.pid`).replace(/\n+$/, '');
      const st = /^[0-9]+$/.test(o) ? pidStat(Number(o)) : '';
      if (!(st === '' || st.startsWith('Z'))) { ctx.out(rd(`${bd}/awake`)); ctx.out(`${PLUG_LINE}\n`); return 0; }
    }
  }
  let pid; let txt;
  if (kind === 'caffeinate') {
    pid = proc.spawnDetached('caffeinate', ['-i', '-w', sess], ctx.env);
    txt = `sleep inhibitor: caffeinate -i -w ${sess} (session pid ${sess}): the Mac does not idle-sleep while this session lives`;
  } else {
    pid = proc.spawnDetached('systemd-inhibit', ['--what=idle:sleep', '--who=proofline', '--why=night batch is running', 'sh', '-c', 'while kill -0 "$1" 2>/dev/null; do sleep 5; done', '_', sess], ctx.env);
    txt = `sleep inhibitor: systemd-inhibit --what=idle:sleep (session pid ${sess}): held while this session lives`;
  }
  writeFileSync(`${bd}/awake.pid`, `${pid}\n`);
  writeFileSync(`${bd}/awake`, `${txt}\n`);
  ctx.out(rd(`${bd}/awake`));
  ctx.out(`${PLUG_LINE} the lid still sleeps most machines when closed.\n`);
  return 0;
}

/** `batch-park ID REASON | ID --clear`: the lead's own park of a task that has no run to carry a question (state.tsv). @param {Context} ctx @param {string[]} args */
export function batchPark(ctx, args) {
  requireLead(ctx);
  const id = args[0] ?? ''; const reason = args[1] ?? '';
  if (id === '' || reason === '') fail('usage: agent.sh batch-park <ID> <reason>|--clear');
  const bd = bdOf(ctx);
  if (!(isFile(`${bd}/order.tsv`) && rows(`${bd}/order.tsv`).some((f) => f[0] === id))) fail(`batch: ${id} is not in the batch`);
  const keep = rows(`${bd}/state.tsv`).filter((f) => f[0] !== id).map((f) => f.join('\t'));
  if (reason !== '--clear') keep.push(`${id}\tparked\t${tsvText(reason)}\t`);
  writeFileSync(`${bd}/state.tsv.tmp`, keep.length > 0 ? `${keep.join('\n')}\n` : '');
  renameSync(`${bd}/state.tsv.tmp`, `${bd}/state.tsv`);
  ctx.out(reason === '--clear' ? `batch: ${id} is no longer parked by the lead\n` : `batch: ${id} parked: ${reason}\n`);
  // A202: the task's one status block shows the park (or its end); best effort, the park itself is already recorded
  if (agentCall(ctx, ['status-block', id, reason === '--clear' ? 'unparked' : 'parked']).status !== 0) ctx.err(`batch: note: the status block of ${id} was not updated\n`);
  return 0;
}

// ---- batch-cover ---------------------------------------------------------------------------------------------------------------------------

/** `batch_accept_given`: the batch approval of the current summary stands and the newest answer to its accept question is b, from a captured user message. @param {Context} ctx */
function acceptGiven(ctx) {
  if (batchApproval(ctx) === null) return false;
  const row = batchAnswerRow(ctx, 'batch', 'accept');
  if (row === null || row[0] !== 'b') return false;
  const b = bid(ctx);
  let m = '';
  for (const f of rows(`${bdOf(ctx)}/answers.tsv`)) if (f[0] === b && f[1] === 'batch' && f[3] === 'accept') m = f[6] ?? '';
  return m !== '' && isFile(`${sharedDirOf(ctx, 'prompts')}/history/${m}`);
}
/** `batch_record ID KIND REQUEST BATCH-HASH [DELIVERY [CAP]]`: an approval as `approve` writes it, marked source batch. @param {Context} ctx @param {string} id @param {string} kind @param {string} req @param {string} bh @param {string} [delivery] @param {string} [cap] */
function batchRecord(ctx, id, kind, req, bh, delivery = '', cap = '') {
  const ad = `${runDir(ctx, id)}/approvals`;
  const slug = kind.replace(/:/g, '-');
  const n = nextNum(ad);
  const file = `${ad}/${n}-${slug}.yaml`;
  let body = `kind: "${kind}"\nbound: "${gateField(ctx, req, 'bound')}"\nsource: "batch"\nrequest: "${path.basename(req)}"\nanswered_by: "user"\napproved_at: ${now().epoch}\nconsumed: "false"\nvia_batch: "${bh}"\n`;
  if (delivery !== '') body += `delivery: "${delivery}"\n`;
  const ref = gateField(ctx, req, 'ref');
  if (ref !== '') body += `ref: "${ref}"\n`; // A169
  if (cap !== '') body += `cap: "${cap}"\n`;
  mkdirSync(ad, { recursive: true });
  writeFileSync(file, Buffer.from(body, 'latin1'));
  ctx.forget('file:'); ctx.forget('ledger-bound:'); ctx.forget('patch:'); ctx.forget('fp:');
  ledgerIf(ctx, id, 'approval', '-', '-', `${ledgerToken(runDir(ctx, id), `approvals/${n}-${slug}.yaml`)} ${kind} source=batch answered_by=user bound=${gateField(ctx, req, 'bound')} via_batch=${bh}`);
  ctx.out(`batch approval recorded: ${id} ${kind}\n`);
}

/** `batch-cover ID KIND`: records the approval of a plan, a delivery or a mutation budget as the user's, only while every check holds. @param {Context} ctx @param {string[]} args */
export function batchCover(ctx, args) {
  const id = args[0] ?? ''; const kind = args[1] ?? '';
  if (id === '' || kind === '') fail('usage: agent.sh batch-cover <ID> <plan|delivery|mutation_budget|rationale:PATTERN>');
  requireLead(ctx);
  const bd = bdOf(ctx);
  if (!(kind === 'plan' || kind === 'delivery' || kind === 'mutation_budget')) {
    if (kind.startsWith('rationale:')) {
      // a DESIGN.md pattern justification the user accepted for this batch with the one accept answer; the line must be exactly the one the approved summary lists
      if (!acceptGiven(ctx)) fail('no accepted list in the approved batch: the user has not answered the accept question of the summary with b');
      const pat = kind.slice(10);
      const line = rationaleLine(ctx, pat);
      if (line === '') fail(`DESIGN.md has no justification line for ${pat}`);
      if (!textLines(rd(`${bd}/SUMMARY.md`)).includes(`- accept R ${line}`)) fail(`the DESIGN.md line for ${pat} is not the one the approved batch summary lists (changed or never listed): the user approves it on its own`);
    } else fail(`${kind} is not covered by the batch approval (only plan, delivery, mutation_budget, rationale:<pattern> accepted in the summary)`);
  }
  if (batchApproval(ctx) === null) fail('no valid batch approval for the current summary');
  const bh = hashFile(`${bd}/SUMMARY.md`);
  if (!rows(`${bd}/order.tsv`).some((f) => f[0] === id)) fail(`${id} is not in the batch (excluded or never planned)`);
  requireRun(ctx, id); requireOpenRun(ctx, id);
  const cls = pipelineClass(ctx, runDir(ctx, id));
  if (!(pipelineClassValid(cls) && cls !== 'CRITICAL')) fail(`run ${id} is classified ${cls === '' ? 'unknown' : cls}: CRITICAL or unclassified work is not covered by the batch approval`);
  if (kind === 'delivery') {
    if (!isFile(`${deliverDir(ctx, id)}/SUMMARY.md`)) fail(`no delivery summary for ${id} (agent.sh deliver-plan ${id} first)`);
    const dh = hashFile(`${deliverDir(ctx, id)}/SUMMARY.md`);
    /** @type {Array<[string, string]>} */ const list = [];
    for (const s of ['commit', 'push', 'pr', 'merge', 'cleanup']) {
      const rq = pendingRequest(ctx, id, s);
      if (rq === null) continue;
      if (gateField(ctx, rq, 'delivery') === dh && gateField(ctx, rq, 'bound') === approvalBound(ctx, id, s)) list.push([s, rq]);
    }
    if (list.length === 0) fail(`no pending delivery step request of the current summary for ${id}`);
    for (const [s, rq] of list) batchRecord(ctx, id, s, rq, bh, dh);
    return 0;
  }
  const rq = pendingRequest(ctx, id, kind);
  if (rq === null) fail(`no pending ${kind} request for ${id}`);
  if (gateField(ctx, rq, 'bound') !== approvalBound(ctx, id, kind)) fail(`the content changed since the ${kind} request; request again`);
  if (kind === 'mutation_budget') {
    let cap = ctx.config().get('batch.mutation_budget_cap', '40');
    if (!/^[0-9]+$/.test(cap)) cap = '40';
    const n = planTestAcs(rd(`${runDir(ctx, id)}/PLAN.md`));
    if (!(n <= Number(cap))) fail(`mutation budget: PLAN ## Tests names ${n} criteria, above the batch cap ${cap}: not covered by the batch approval`);
    batchRecord(ctx, id, kind, rq, bh, '', cap);
  } else batchRecord(ctx, id, kind, rq, bh);
  return 0;
}

/** The handlers of the batch commands that read or change the state. @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const BATCH_HANDLERS = {
  'batch-next': batchNext,
  'batch-status': (ctx) => batchStatus(ctx),
  'batch-answer': (ctx) => batchAnswer(ctx),
  'batch-answers': batchAnswers,
  'batch-awake': (ctx) => batchAwake(ctx),
  'batch-park': batchPark,
  'batch-cover': batchCover,
};
