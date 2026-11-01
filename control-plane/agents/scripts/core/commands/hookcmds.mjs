// @ts-check
// Stage 3: worktree-root, in-knowledge-scope, hook-time, friction-note, window-open, window-close, language-check, answer (agent.sh 0.0.42).
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { now } from '../clock.mjs';
import { answer } from '../answer.mjs';
import { requireLead, requireOpenRun } from '../approve.mjs';
import { nextUser } from '../nextuser.mjs';
import { fail } from '../errors.mjs';
import { verifyMutationOwnership } from '../gates.mjs';
import { sha256 } from '../hash.mjs';
import { languageCheck } from '../language.mjs';
import { ledgerAppend, verifySeal } from '../ledger.mjs';
import { isDir, isFile } from '../paths.mjs';
import * as proc from '../proc.mjs';
import { gateField, gatesEnforced, planDestructive, readBytes, sectionValue } from '../records.mjs';
import { requireRun, runDir } from '../runs.mjs';
import { inKnowledgeScope } from '../scope.mjs';
import { taskPatchFingerprint } from '../gates.mjs';

/** @typedef {import('../context.mjs').Context} Context */

/** `rw_valid_id` @param {string} id */
const rwValid = (id) => /^[A-Za-z0-9_-]+$/.test(id) && !/^[^A-Za-z0-9]/.test(id) && !id.includes('..');

/** `cd DIR && pwd -P`, or null. @param {string} d */
function physical(d) { try { return realpathSync(d); } catch { return null; } }

/** `worktree_root PATH` (A184): the root of the registered run worktree that contains the physical path, else exit 1. @param {Context} ctx @param {string[]} args */
function worktreeRoot(ctx, args) {
  const p = args[0] ?? '';
  if (!p.startsWith('/')) return 1;
  if (`/${p}/`.includes('/../') || `/${p}/`.includes('/./')) return 1;
  const list = proc.run('git', ['-C', ctx.root, 'worktree', 'list', '--porcelain'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).stdout.toString('latin1').split('\n');
  let m = (list[0] ?? '').startsWith('worktree ') ? list[0].slice(9) : '';
  if (m === '') return 1;
  const mp = physical(m);
  if (mp === null) return 1;
  m = mp;
  /** @param {string} d */
  const common = (d) => {
    const r = proc.run('git', ['rev-parse', '--git-common-dir'], { cwd: d, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status !== 0) return null;
    return physical(path.resolve(d, r.stdout.toString('latin1').replace(/\n+$/, '')));
  };
  const wc = common(m);
  if (wc === null) return 1;
  const base = `${m}/.agents/local/worktrees`;
  if (!p.startsWith(`${base}/`)) return 1;
  const rest = p.slice(base.length + 1);
  const id = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest;
  if (!rwValid(id)) return 1;
  const wd = `${base}/${id}`;
  let st;
  try { st = lstatSync(wd); } catch { return 1; }
  if (!st.isDirectory() || st.isSymbolicLink() || !isFile(`${wd}/.git`)) return 1;
  if (physical(wd) !== wd) return 1;
  if (!list.some((l) => l === `worktree ${wd}`)) return 1;
  if (common(wd) !== wc) return 1;
  if (p !== wd && !p.startsWith(`${wd}/`)) return 1;
  ctx.out(`${wd}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function inKnowledgeScopeCommand(ctx, args) { return inKnowledgeScope(ctx, args[0] ?? '') ? 0 : 1; }

/** `hook_time ID` @param {Context} ctx @param {string[]} args */
function hookTime(ctx, args) {
  const id = args[0] ?? '';
  requireLead(ctx);
  const f = `${ctx.root}/.agents/local/hook-times`;
  let size = 0;
  try { size = lstatSync(f).size; } catch { return 0; }
  if (size === 0) return 0;
  if (id === '' || id === '-' || !isDir(runDir(ctx, id))) return 0;
  const work = `${f}.${process.pid}`;
  try { renameSync(f, work); } catch { return 0; }
  if (gatesEnforced(ctx, runDir(ctx, id))) {
    /** @type {Map<string, { n: number, t: number, m: string }>} */ const per = new Map();
    /** @type {string[]} */ const rows = [];
    const text = readFileSync(work, 'latin1');
    for (const line of text.split('\n')) {
      const x = line.split('|');
      if (!/^[A-Za-z0-9_.-]+$/.test(x[1] ?? '') || !/^[0-9]+$/.test(x[2] ?? '')) continue;
      if (x[3] === 'timeout') { rows.push(`hook-timeout\tname=${x[1]} ms=${x[2]}${(x[4] ?? '') !== '' ? ` note=${x[4]}` : ''}`); continue; }
      const e = per.get(x[1]) ?? { n: 0, t: 0, m: '' };
      e.n++; e.t += Number(x[2]);
      if (Number(x[2]) > Number(e.m === '' ? 0 : e.m)) e.m = x[2];
      per.set(x[1], e);
    }
    for (const [k, e] of per) rows.push(`hook\tname=${k} runs=${e.n} total_ms=${e.t} max_ms=${e.m === '' ? '0' : e.m}`);
    rows.sort();
    for (const r of rows) {
      const tab = r.indexOf('\t');
      const t = now();
      appendFileSync(`${runDir(ctx, id)}/HOOKS.log`, `ts=${t.iso} epoch=${t.epoch} event=${r.slice(0, tab)} role=${ctx.role} detail=${r.slice(tab + 1).replace(/[^A-Za-z0-9_.=,: -]/g, '_')}\n`);
    }
  }
  rmSync(work, { force: true });
  return 0;
}

/** `friction_note ID KIND` @param {Context} ctx @param {string[]} args */
function frictionNote(ctx, args) {
  const id = args[0] ?? ''; const kind = args[1] ?? '';
  requireRun(ctx, id);
  requireLead(ctx);
  if (!['user-command', 'user-shell', 'proofline_bug'].includes(kind)) fail('usage: agent.sh friction-note <ID> <user-command|user-shell|proofline_bug>');
  const dir = runDir(ctx, id);
  if (!gatesEnforced(ctx, dir)) { ctx.out(`friction noted (not ledgered: the run has no lifecycle_gates policy): ${kind}\n`); return 0; }
  verifySeal(ctx, id, dir);
  const s = sectionValue(ctx, dir, 'handoff', 'state');
  ledgerAppend(dir, ctx.role, 'friction-note', s, s, kind);
  ctx.forget('file:');
  ctx.out(`friction noted: ${kind}\n`);
  return 0;
}

/** `window_role` @param {string} r */
function windowRole(r) {
  const role = r === '' ? 'implementer' : r;
  if (role !== 'implementer' && role !== 'designer') fail(`worker windows bracket the implementer or the designer, not ${r}`);
  return role;
}

/** `resolve_topology` @param {Context} ctx @param {string} dir */
function topology(ctx, dir) {
  const t = sectionValue(ctx, dir, 'execution', 'topology');
  if (t === 'standalone' || t === 'orchestrated') return t;
  const d = ctx.config().get('default_topology', '');
  if (d === 'standalone' || d === 'orchestrated') return d;
  return fail('no valid execution topology resolved: set execution.topology in RUN.yaml or default_topology in .agents/config.yaml');
}

/** The window records of a run, in the order of their numbers. @param {string} ev */
function windowFiles(ev) {
  let names = [];
  try { names = readdirSync(ev).filter((n) => /^WINDOW-[0-9]+\.yaml$/.test(n)); } catch { /* none */ }
  return names.sort((a, b) => Number(a.slice(7, -5)) - Number(b.slice(7, -5)) || (a < b ? -1 : 1));
}

/** `window_open ID [ROLE]` @param {Context} ctx @param {string[]} args */
function windowOpen(ctx, args) {
  requireLead(ctx);
  const id = args[0];
  windowRole(args[1] ?? '');
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!gatesEnforced(ctx, dir)) return 0;
  requireOpenRun(ctx, id);
  if (topology(ctx, dir) !== 'orchestrated') return 0;
  const hs = sectionValue(ctx, dir, 'handoff', 'state');
  if (hs === 'PLANNED' && planDestructive(readBytes(`${dir}/PLAN.md`) ?? '') === 'yes') fail(`worker windows are opened only while handoff state is IMPLEMENTING: this destructive plan is frozen at PLANNED and needs a destructive approval bound to the current PLAN.md first ('agent.sh next ${id}', 'agent.sh request-approval ${id} destructive', then 'agent.sh handoff ${id} IMPLEMENTING')`);
  if (hs !== 'IMPLEMENTING') fail('worker windows are opened only while handoff state is IMPLEMENTING');
  verifySeal(ctx, id, dir);
  verifyMutationOwnership(ctx, dir, id, true);
  ctx.out(`${taskPatchFingerprint(ctx, dir)}\n`);
  return 0;
}

/** `window_close ID BEFORE [EXIT-STATUS] [ROLE]` @param {Context} ctx @param {string[]} args */
function windowClose(ctx, args) {
  requireLead(ctx);
  const id = args[0]; const before = args[1] ?? ''; const status = args[2] === undefined || args[2] === '' ? '0' : args[2];
  const role = windowRole(args[3] ?? '');
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!gatesEnforced(ctx, dir)) return 0;
  requireOpenRun(ctx, id);
  if (topology(ctx, dir) !== 'orchestrated') return 0;
  if (before === '') fail('window-close requires the fingerprint printed by window-open');
  if (sectionValue(ctx, dir, 'handoff', 'state') !== 'IMPLEMENTING') fail('worker windows are closed only while handoff state is IMPLEMENTING');
  const ev = `${dir}/worker-evidence`;
  let last = sha256('');
  for (const w of windowFiles(ev)) last = gateField(ctx, `${ev}/${w}`, 'after_sha256');
  if (before !== last) fail('worker window began at a tree that is not the last attested one: unattributed mutation');
  try { mkdirSync(ev, { recursive: true }); } catch { fail(`cannot create ${ev}`); }
  let nmax = 0;
  for (const w of windowFiles(ev)) nmax = Math.max(nmax, Number(w.slice(7, -5)));
  const n = nmax + 1;
  const after = taskPatchFingerprint(ctx, dir);
  try {
    writeFileSync(`${ev}/WINDOW-${n}.yaml`, Buffer.from(`task_id: "${id}"\nseq: ${n}\nrole: "${role}"\ntopology: "orchestrated"\nbefore_sha256: "${before}"\nafter_sha256: "${after}"\nexit_status: "${status}"\ntimestamp: "${now().iso}"\n`, 'latin1'));
  } catch { fail('could not write worker window record'); }
  ctx.forget('file:');
  ctx.out(`worker window recorded: ${id} WINDOW-${n}\n`);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function languageCheckCommand(ctx, args) {
  let stdin = '';
  if ((args[0] ?? '-') === '-' || args[0] === '') {
    // the Node hook runs this in its own process and hands the text over (its own stdin is the hook event, already read): as the bytes a pipe would carry
    const given = /** @type {{ stdinText?: string }} */ (ctx.io).stdinText;
    if (given !== undefined) stdin = Buffer.from(given, 'utf8').toString('latin1');
    else { try { stdin = readFileSync(0, 'latin1'); } catch { stdin = ''; } }
  }
  return languageCheck(ctx, args, stdin);
}

export const HOOKCMD_HANDLERS = {
  'next-user': (/** @type {Context} */ ctx, /** @type {string[]} */ args) => nextUser(ctx, args),
  'worktree-root': worktreeRoot,
  'in-knowledge-scope': inKnowledgeScopeCommand,
  'hook-time': hookTime,
  'friction-note': frictionNote,
  'window-open': windowOpen,
  'window-close': windowClose,
  'language-check': languageCheckCommand,
  answer: (/** @type {Context} */ ctx, /** @type {string[]} */ args) => answer(ctx, args),
};
