// @ts-check
// The helper commands (A229, issue #173 package A; they ran as shell scripts and agent.sh functions before): friction, calibrate, build-record, lessons, rules,
// wait-line, task-rename-plan, task-rename-apply and test. The guards are the ones of agent.sh: friction report|send, lessons write|promote and rules tally need
// the lead; build-record run is the lead's; test and the two task-rename commands are lead-only; wait-line needs a run and the lead.
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findApproval, hashOf, sharedDirOf } from '../approvals.mjs';
import { consumeApproval, requestApproval, requireLead } from '../approve.mjs';
import { buildRecordCommand } from '../buildrecord.mjs';
import { now } from '../clock.mjs';
import { bytes } from '../config.mjs';
import { budgetUsage, inflightDispatch, inflightParts } from '../dispatch.mjs';
import { fail } from '../errors.mjs';
import { calibrate, frictionCommand } from '../friction.mjs';
import { lessonsCommand } from '../lessons.mjs';
import { isFile } from '../paths.mjs';
import * as proc from '../proc.mjs';
import { hgit } from '../hgit.mjs';
import { fileText, validTaskId } from '../records.mjs';
import { rulesCommand } from '../rules.mjs';
import { requireRun, runDir } from '../runs.mjs';
import { slug } from '../slug.mjs';
import { taskTitle } from './runcmds.mjs';

/** @typedef {import('../context.mjs').Context} Context */

// ---- wait-line ----------------------------------------------------------------------------------------------------------------------

/**
 * `wait-line <ID> ["WHAT"] [--done]` (A171): the one-line status for a wait, `waiting: <what>, <M>m<SS>s so far`; WHAT defaults to the dispatch in flight. The first
 * call for a WHAT starts its clock (.agents/local/wait/); --done stops it. The lead prints this line and nothing more while it waits.
 * @param {Context} ctx @param {string[]} args
 */
function waitLine(ctx, args) {
  const id = args[0] ?? '';
  if (id === '') { ctx.err('usage: agent.sh wait-line <ID> [WHAT] [--done]\n'); return 2; }
  let what = bytes(args[1] ?? '');
  let done = false;
  requireRun(ctx, id); requireLead(ctx);
  if (what === '--done') { what = ''; done = true; }
  if ((args[2] ?? '') === '--done') done = true;
  if (what === '') {
    const fly = inflightDispatch(ctx, runDir(ctx, id));
    if (fly === null) fail(`nothing is in flight: name what you wait for, for example agent.sh wait-line ${id} "CI of the pull request"`);
    what = `dispatch ${inflightParts(fly).role}`;
  }
  what = what.replace(/[^A-Za-z0-9 ._-]/g, ' ').slice(0, 80);
  const file = `${ctx.root}/.agents/local/wait/${id}-${what.replace(/[^A-Za-z0-9]/g, '-').slice(0, 60)}`;
  if (done) { rmSync(file, { force: true }); ctx.out(`wait over: ${what}\n`); return 0; }
  try { mkdirSync(`${ctx.root}/.agents/local/wait`, { recursive: true }); } catch { /* read-only here: the clock then restarts at every call */ }
  let nonEmpty = false;
  try { nonEmpty = statSync(file).size > 0; } catch { nonEmpty = false; }
  if (!nonEmpty) { try { writeFileSync(file, `${now().epoch}\n`); } catch { /* none */ } }
  let start = '';
  try { start = (fileText(ctx, file) ?? '').replace(/\n+$/, ''); } catch { start = ''; }
  if (!/^[0-9]+$/.test(start)) start = String(now().epoch);
  const e = now().epoch - Number(start);
  const used = budgetUsage(ctx, runDir(ctx, id))[0];
  const t = used === undefined ? '' : ` (TIME: ${Math.floor((used.e * 100) / used.t)}% of its ${Math.floor(used.t / 60)}m limit)`;
  ctx.out(`waiting: ${what}, ${Math.floor(e / 60)}m${String(e % 60).padStart(2, '0')}s so far${t}\n`);
  return 0;
}

// ---- task-rename-plan / task-rename-apply (A202) ----------------------------------------------------------------------------------------

// Consistent task file names: <ID>-<slug>.md. task-rename-plan lists the queued markdown task files (backlog/, todo/ and the top level of tasks.dir) that are named
// only by their ID or only by a slug and proposes <ID>-<slug-of-the-title>.md; it asks the user's approval (kind `rename`, bound to the proposal's sha256).
// task-rename-apply renames only after that approval, and re-checks every row first. A task that has a run or a worktree, one whose file holds a published
// completion report, and every file in in-progress/ or done/ is never proposed and never renamed.

/** @param {string} p */
function plainFile(p) { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } }

/** The queued task files, in glob order. @param {Context} ctx @returns {string[]} */
function renameFiles(ctx) {
  const td = `${ctx.root}/${ctx.config().get('tasks.dir', '.agents/tasks')}`;
  /** @type {string[]} */ const out = [];
  for (const d of [`${td}/backlog`, `${td}/todo`, td]) {
    /** @type {string[]} */ let names = [];
    try { names = readdirSync(d).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort(); } catch { names = []; }
    for (const n of names) if (plainFile(`${d}/${n}`)) out.push(`${d}/${n}`);
  }
  return out;
}

/** `rename_candidate FILE`: the new absolute name when the file is a queued, non-conforming task file, else null. @param {Context} ctx @param {string} f */
function renameCandidate(ctx, f) {
  const text = fileText(ctx, f) ?? '';
  const base = path.basename(f).replace(/\.md$/, '');
  const m = /^# Task: *([^ ]*)/.exec(text.split('\n')[0] ?? '');
  const id = m ? /** @type {string} */ (m[1]) : '';
  if (id === '' || !validTaskId(id)) return null;
  if (new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-FU[0-9]`).test(base)) return null;
  if (existsSync(`${ctx.root}/.agents/runs/${id}`) || existsSync(`${sharedDirOf(ctx, 'worktrees')}/${id}`)) return null;
  if (text.includes('COMPLETION-REPORT:BEGIN')) return null;
  const idl = slug(id);
  if (base.startsWith(`${id}-`) && base.length > id.length + 1) {
    const sl = base.slice(id.length + 1);
    if (sl === slug(sl) && sl !== idl) return null;
  }
  const sl = slug(taskTitle(text));
  if (sl === '' || sl === idl) return null;
  const neu = `${path.dirname(f)}/${id}-${sl}.md`;
  return existsSync(neu) ? null : neu;
}

/** @param {Context} ctx */
function renamePlan(ctx) {
  requireLead(ctx);
  const pf = `${sharedDirOf(ctx, 'rename')}/PROPOSAL.tsv`;
  mkdirSync(path.dirname(pf), { recursive: true });
  let rows = '';
  for (const f of renameFiles(ctx)) {
    const n = renameCandidate(ctx, f);
    if (n === null) continue;
    rows += `${f.slice(ctx.root.length + 1)}\t${n.slice(ctx.root.length + 1)}\n`;
  }
  if (rows === '') {
    rmSync(pf, { force: true });
    ctx.out('task-rename: every queued task file is already named <ID>-<slug>.md\n');
    return 0;
  }
  writeFileSync(`${pf}.tmp`, Buffer.from(rows, 'latin1'));
  renameSync(`${pf}.tmp`, pf);
  ctx.out(rows);
  ctx.forget('file:');
  return requestApproval(ctx, '-', 'rename');
}

/** @param {Context} ctx */
function renameApply(ctx) {
  requireLead(ctx);
  const pf = `${sharedDirOf(ctx, 'rename')}/PROPOSAL.tsv`;
  let size = 0;
  try { size = statSync(pf).size; } catch { size = 0; }
  if (size === 0) fail('no rename proposal (agent.sh task-rename-plan)');
  const app = findApproval(ctx, '-', 'rename', hashOf(pf));
  if (app === null) fail('renaming task files needs the user\'s approval: \'agent.sh request-approval - rename\' (task-rename-plan does it), relay it; the reply "approve rename" records the approval');
  const rows = (fileText(ctx, pf) ?? '').split('\n').filter((l) => l !== '').map((l) => { const t = l.indexOf('\t'); return [l.slice(0, t), l.slice(t + 1)]; });
  for (const [o = '', n = ''] of rows) {
    if (renameCandidate(ctx, `${ctx.root}/${o}`) !== `${ctx.root}/${n}`) fail(`${o} is no longer a queued task file that needs this rename (started, reported, renamed or changed since the proposal); run task-rename-plan again`);
  }
  consumeApproval(ctx, '-', app);
  for (const [o = '', n = ''] of rows) {
    const tracked = hgit(ctx, ctx.root, ['ls-files', '--error-unmatch', '--', o]).status === 0; // reads the index: hermetic (A248 round 7)
    if (tracked) {
      const r = hgit(ctx, ctx.root, ['mv', '--', o, n], { stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status !== 0) { ctx.err(r.stderr.toString('latin1')); return r.status; }
    } else renameSync(`${ctx.root}/${o}`, `${ctx.root}/${n}`);
    ctx.out(`renamed: ${o} -> ${n}\n`);
  }
  try { unlinkSync(pf); } catch { /* gone */ }
  return 0;
}

// ---- test ----------------------------------------------------------------------------------------------------------------------------

/**
 * `test` (lead only): every sibling *-test.sh of the scripts folder, one after the other, each in throwaway repositories of its own; the first failing suite
 * stops the run with its status. What is left are the legacy shell suites of the control plane (their commands have no shell arm any more; issue #176 deletes
 * them with the dead code), so this is a plain loop and nothing more.
 * @param {Context} ctx
 */
function testSuites(ctx) {
  requireLead(ctx);
  const dir = ctx.trustedScripts;
  /** @type {string[]} */ let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('-test.sh')).sort(); } catch { names = []; }
  for (const n of names) {
    if (!isFile(`${dir}/${n}`)) continue;
    ctx.out(`== ${n}\n`);
    ctx.flush();
    const own = ctx.io.isProcess === true;
    const r = proc.run('sh', [`${dir}/${n}`], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: own ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    if (!own) { ctx.out(r.stdout.toString('latin1')); ctx.err(r.stderr.toString('latin1')); }
    if (r.status !== 0) return r.status;
  }
  return 0;
}

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const HELPER_HANDLERS = {
  friction: frictionCommand,
  calibrate: (ctx) => calibrate(ctx),
  'build-record': buildRecordCommand,
  lessons: lessonsCommand,
  rules: rulesCommand,
  'wait-line': waitLine,
  'task-rename-plan': (ctx) => renamePlan(ctx),
  'task-rename-apply': (ctx) => renameApply(ctx),
  test: (ctx) => testSuites(ctx),
};
