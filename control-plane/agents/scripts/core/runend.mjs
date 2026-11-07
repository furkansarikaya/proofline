// @ts-check
// Stage 4, package 4B: the end of a run: `terminate`, `cleanup` (with the removal of the run's worktree and the archive of its records) and
// `archive_run`. File formats, messages and the order of the checks are those of agent.sh 0.0.47.
import { frictionReport } from './friction.mjs';
import { rulesCommand } from './rules.mjs';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { now } from './clock.mjs';
import { fail } from './errors.mjs';
import { fixRoundsUsed, maxFixRounds, taskOwnedPaths } from './gates.mjs';
import { git, isAncestor, headSha } from './git.mjs';
import { verifySeal } from './ledger.mjs';
import { enforceTaskBranch, setRunValue } from './lifecycle.mjs';
import { fieldFromText, justificationOk, led, must, quietly, readStdin } from './lifeutil.mjs';
import { verifyCompletionReport } from './complreport.mjs';
import { requireLead, requireOpenRun } from './approve.mjs';
import { isDir, isFile } from './paths.mjs';
import * as proc from './proc.mjs';
import { fileText, gatesEnforced, ledgerLines, sectionKeyPresent, sectionValue, textLines } from './records.mjs';
import { requireRun, runDir } from './runs.mjs';
import { asciiLower } from './shellglob.mjs';
import { hookTime } from './commands/hookcmds.mjs';
import { freshness, verifyHandoff, verifyKnowledgeScope } from './commands/verify.mjs';
import { statusBlockUpdate } from './statusblock.mjs';

/** @typedef {import('./context.mjs').Context} Context */

// ---- metrics (A80): the run record ---------------------------------------------------------------------------------------------------

/** `metrics_line TASK ROLE RUNTIME MODEL DURATION OUTCOME`. @param {Context} ctx @param {string[]} f */
export function metricsLine(ctx, f) {
  if (ctx.config().get('metrics', 'on') === 'off') return;
  const file = `${ctx.sharedMain()}/.agents/local/metrics/history.tsv`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = statSync(file).size; } catch { /* new */ }
    const head = size > 0 ? '' : 'time\ttask\trole\truntime\tmodel\tduration_s\toutcome\n';
    writeFileSync(file, `${head}${now().iso}\t${f.join('\t')}\n`, { flag: 'a', encoding: 'latin1' });
  } catch { /* best effort */ }
}

/** `metrics_json KIND TASK ROLE FOCUS GATE RUNTIME MODEL DURATION TIN TOUT TTOT TURNS RETRIES DELEG FIXR RESULT SIZE SCOPE`. @param {Context} ctx @param {string[]} a */
export function metricsJson(ctx, a) {
  if (ctx.config().get('metrics', 'on') === 'off') return;
  const file = `${ctx.sharedMain()}/.agents/local/metrics/records.jsonl`;
  const s = (/** @type {string | undefined} */ v) => { const t = (v ?? '').replace(/[^A-Za-z0-9._+:-]/g, ''); return t === '' || t === '-' ? 'null' : `"${t}"`; };
  const n = (/** @type {string | undefined} */ v) => (v === undefined || !/^[0-9]+$/.test(v) ? 'null' : v);
  const g = (/** @type {number} */ i) => a[i];
  const line = `{"schema":"proofline.metrics/1","kind":${s(g(0))},"time":"${now().iso}","task":${s(g(1))},"role":${s(g(2))},"focus":${s(g(3))},"gate":${s(g(4))},"runtime":${s(g(5))},"model":${s(g(6))},"duration_s":${n(g(7))},"tokens_in":${n(g(8))},"tokens_out":${n(g(9))},"tokens_total":${n(g(10))},"turns":${n(g(11))},"retries":${n(g(12))},"delegations":${n(g(13))},"fix_rounds":${n(g(14))},"result":${s(g(15))},"size":${s(g(16))},"scope_paths":${n(g(17))}}\n`;
  try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, line, { flag: 'a', encoding: 'latin1' }); } catch { /* best effort */ }
}

/** `metrics_run ID OUTCOME`: the run record, the hook timings and the friction report. @param {Context} ctx @param {string} id @param {string} outcome */
export function metricsRun(ctx, id, outcome) {
  const dir = runDir(ctx, id);
  const lines = ledgerLines(ctx, dir);
  const m = lines.length > 0 ? / epoch=([0-9]*) /.exec(lines[0]) : null;
  const dur = m ? String(now().epoch - Number(m[1])) : '-';
  const runtime = ctx.config().get('runtime.lead', 'claude');
  metricsLine(ctx, [id, 'lead', runtime, '-', dur, outcome]);
  let deleg = 0;
  try { deleg = readdirSync(`${dir}/decisions`).filter((x) => /^[0-9]{3}-.*\.decision$/.test(x)).length; } catch { /* none */ }
  let fr = '-';
  try { fr = String(fixRoundsUsed(ctx, dir)); } catch { /* shell: 2>/dev/null || echo - */ }
  const task = fileText(ctx, `${dir}/TASK.md`) ?? '';
  let size = '';
  { let fm = false; let seen = false;
    for (const l of textLines(task)) {
      if (/^---[ \t\n\v\f\r]*$/.test(l)) { fm = !fm; if (!fm && seen) break; seen = true; continue; }
      if (fm && l.startsWith('size:')) { size = l.replace(/^size:[ \t]*/, ''); break; }
    } }
  size = size.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 16).replace(/ /g, '').replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
  const sp = sectionValue(ctx, dir, 'freeze', 'scope_paths').split(',').filter((x) => x !== '').length;
  metricsJson(ctx, ['run', id, 'lead', '-', '-', runtime, '-', dur, '-', '-', '-', '-', '-', String(deleg), fr, outcome, size, String(sp)]);
  try { hookTime(ctx, [id]); } catch { /* 2>/dev/null || : */ }
  const mark = ctx.chunks.length;
  try { frictionReport(ctx, id); } catch { /* the report is a courtesy: whatever it says is not the run's result */ }
  ctx.chunks.length = mark;
}

// ---- terminate ----------------------------------------------------------------------------------------------------------------------

/** `terminate_run ID OUTCOME` @param {Context} ctx @param {string} id @param {string} outcome */
export function terminateRun(ctx, id, outcome) {
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  requireLead(ctx);
  if (outcome !== 'FAILED' && outcome !== 'BLOCKED') fail(`invalid outcome: ${outcome} (want FAILED|BLOCKED)`);
  if (!gatesEnforced(ctx, dir)) fail('terminate requires the lifecycle_gates policy');
  requireOpenRun(ctx, id);
  if (sectionValue(ctx, dir, 'execution', 'state') === 'CODE_DONE') fail('a CODE_DONE run is complete, not terminated');
  enforceTaskBranch(ctx, id);
  verifySeal(ctx, id, dir);
  const text = readStdin();
  const reason = fieldFromText(text, 'reason');
  const evidence = fieldFromText(text, 'evidence');
  if (!justificationOk(reason)) fail('terminate requires a specific reason (>=20 chars)');
  if (!justificationOk(evidence)) fail('terminate requires the evidence behind it (>=20 chars: the failing gate records, the failing command and its output)');
  if (outcome === 'FAILED') {
    const used = fixRoundsUsed(ctx, dir); const max = maxFixRounds(ctx);
    if (!(used > max)) fail(`FAILED requires the fix rounds to be exhausted (${used} failing rounds, max_fix_rounds ${max}); use BLOCKED for an environment/tooling/external blocker`);
  }
  const prev = sectionValue(ctx, dir, 'execution', 'state');
  setRunValue(ctx, id, 'execution', 'state', outcome);
  led(ctx, id, 'terminate', prev, outcome, `reason: ${reason}; evidence: ${evidence}`);
  metricsRun(ctx, id, asciiLower(outcome));
  statusBlockUpdate(ctx, id, 'failed');
  ctx.out(`run terminated: ${id} ${outcome}\n`);
  return 0;
}

// ---- archive ------------------------------------------------------------------------------------------------------------------------

/** `[ -L P ]` @param {string} p */
function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

/**
 * `archive_run ID RUNDIR` (A200): a compressed copy of the run's records under <main tree>/.agents/local/archive/<ID>/, the newest archive.keep runs kept.
 * @param {Context} ctx @param {string} id @param {string} runPath
 */
export function archiveRun(ctx, id, runPath) {
  let keep = ctx.config().get('archive.keep', '10');
  if (keep === '' || /[^0-9]/.test(keep)) keep = '10';
  const kept = Number(keep);
  if (!(kept > 0)) return;
  if (!isDir(runPath)) return;
  const root = `${ctx.sharedMain()}/.agents/local/archive`;
  for (const p of [path.dirname(root), root, `${root}/${id}`]) if (isLink(p)) fail(`refusing to archive under ${p}: it is a symlink; the run is kept`);
  try { mkdirSync(`${root}/${id}`, { recursive: true }); } catch { fail(`could not create ${root}/${id}; the run is kept`); }
  const stamp = now().iso.replace(/[-:]/g, '');
  const file = `${root}/${id}/${id}-${stamp}.tar.gz`;
  const old = process.umask(0o077);
  let ok = false;
  try {
    const a = proc.run('tar', ['-czf', file, '-C', path.dirname(runPath), path.basename(runPath)], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'ignore', 'ignore'] });
    ok = a.status === 0 && proc.run('tar', ['-tzf', file], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'ignore', 'ignore'] }).status === 0;
  } finally { process.umask(old); }
  if (!ok) { rmSync(file, { force: true }); fail(`could not archive the records of ${id} into ${root}/${id}; the run is kept (set archive.keep: 0 to skip the archive)`); }
  // keep the newest archive.keep run folders (by last write), whichever task they belong to
  let names = [];
  try { names = readdirSync(root); } catch { /* none */ }
  const timed = names.map((n) => { let t = 0; try { t = statSync(`${root}/${n}`).mtimeMs; } catch { /* gone */ } return { n, t }; }).sort((x, y) => y.t - x.t || (x.n < y.n ? -1 : 1));
  timed.forEach((e, i) => {
    if (i + 1 <= kept) return;
    if (/[^A-Za-z0-9._-]/.test(e.n) || e.n === '' || e.n === '.' || e.n === '..') return;
    if (isDir(`${root}/${e.n}`) && !isLink(`${root}/${e.n}`)) rmSync(`${root}/${e.n}`, { recursive: true, force: true });
  });
  ctx.out(`evidence archived: .agents/local/archive/${id}/${path.basename(file)} (the newest ${keep} runs are kept)\n`);
}

// ---- cleanup ------------------------------------------------------------------------------------------------------------------------

const SB_KEYS = 'run type class stage event updated branch start_commit runtime session question answer park failure pr ci delivered_commit estimate duration tokens look_at known_issues'.split(' ');
const reStatusKey = new RegExp(`^- (${SB_KEYS.join('|')}): `);

/** `sb_strip ID` over a text: the status section of the task, when it is only the control plane's own block. @param {string} id @param {string} text */
function sbStrip(id, text) {
  const line = textLines(text);
  const bg = `<!-- PROOFLINE-STATUS:BEGIN:${id} -->`; const en = `<!-- PROOFLINE-STATUS:END:${id} -->`;
  const blank = /^[ \t\n\v\f\r]*$/;
  /** @type {string[]} */ const out = [];
  let done = false;
  for (let i = 0; i < line.length; i++) {
    if (!done && line[i] === '## Proofline Status') {
      let j = i + 1;
      while (j < line.length && blank.test(line[j])) j++;
      if (j < line.length && line[j] === bg) {
        let k = j + 1;
        while (k < line.length && line[k] !== en) k++;
        let ok = k < line.length;
        for (let m = j + 1; ok && m < k; m++) if (!blank.test(line[m]) && !reStatusKey.test(line[m])) ok = false;
        if (ok) { i = k; done = true; continue; }
      }
    }
    out.push(line[i]);
  }
  return out.join('\n').replace(/\n+$/, ''); // a command substitution drops the trailing newlines
}

/** `sb_block_only TREE PATH ID`: the tracked file differs from HEAD only by task ID's own status block. @param {Context} ctx @param {string} tree @param {string} p @param {string} id */
export function sbBlockOnly(ctx, tree, p, id) {
  const run = (/** @type {string[]} */ a) => proc.run('git', ['-C', tree, ...a], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  if (run(['ls-files', '--error-unmatch', '--', p]).status !== 0) return false;
  if (!isFile(`${tree}/${p}`)) return false;
  const head = run(['show', `HEAD:${p}`]);
  const cur = readFileSync(`${tree}/${p}`, 'latin1');
  return sbStrip(id, cur) === sbStrip(id, head.stdout.toString('latin1'));
}

/** `eco_union worktree_deps.folders` over ecosystems.tsv. @param {Context} ctx */
function worktreeDepFolders(ctx) {
  const t = fileText(ctx, `${ctx.agents}/ecosystems.tsv`);
  if (t === null || t === '' || !isFile(`${ctx.scripts}/ecosystems.sh`)) return [];
  /** @type {string[]} */ const out = [];
  for (const l of textLines(t)) { const f = l.split('\t'); if (f[0] !== '*' && f[1] === 'worktree_deps.folders' && f[2] !== undefined && !out.includes(f[2])) out.push(f[2]); }
  return out;
}

/**
 * `cleanup_worktree ID TERMINAL` (A169). The worktree of a delivered run is removed only when the merge is proved: IN PROCESS by the delivery code that
 * calls `cleanupRun` with `mergeProved` after its own proof (a pull request seen merged, or git), or by a `batch/merged.tsv` row of this run that is not
 * older than the nonce of this delivery's summary. There is no file, flag, lock or environment value that says "merged" (A215).
 * @param {Context} ctx @param {string} id @param {boolean} terminal @param {boolean} [mergeProved]
 */
function cleanupWorktree(ctx, id, terminal, mergeProved = false) {
  const main = ctx.sharedMain();
  if (terminal || main === ctx.root) return;
  let p;
  try { p = realpathSync(ctx.root); } catch { return; }
  if (p !== `${main}/.agents/local/worktrees/${id}`) return;
  const delivered = `${ctx.root}/.agents/local/deliver/${id}/SUMMARY.md`;
  let from = '0';
  try { if (statSync(delivered).size > 0) { const m = /^nonce: ([0-9]*)-/m.exec(readFileSync(delivered, 'latin1')); from = m ? m[1] : '0'; } } catch { /* none */ }
  if (from === '' || /[^0-9]/.test(from)) from = '0';
  let merged = mergeProved;
  if (!merged) {
    const t = fileText(ctx, `${main}/.agents/local/batch/merged.tsv`);
    merged = t !== null && textLines(t).some((l) => { const f = l.split('\t'); return f[0] === id && Number(f[2]) + 0 >= Number(from) + 0; });
  }
  if (!merged) { ctx.out(`note: the worktree ${p} is kept: no merge of ${id} is on record\n`); return; }
  try { for (const r of readdirSync(`${p}/.agents/runs`)) if (isDir(`${p}/.agents/runs/${r}`)) { ctx.out(`note: the worktree ${p} is kept: it still holds the run ${r}\n`); return; } } catch { /* no runs folder */ }
  let list = [];
  const copied = fileText(ctx, `${p}/.agents/local/worktree-copied`);
  if (copied !== null) list = textLines(copied);
  const st = proc.run('git', ['-C', p, 'status', '--porcelain', '--ignored', '--untracked-files=all'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  if (st.status !== 0) { ctx.out(`note: the worktree ${p} is kept: git status failed\n`); return; }
  let extra = textLines(st.stdout.toString('latin1')).map((l) => l.slice(3)).filter((l) => !l.startsWith('.agents/runs/') && !l.startsWith('.agents/local/') && !list.includes(l));
  if (extra.length > 0) extra = extra.filter((q) => !sbBlockOnly(ctx, p, q, id));
  for (const f of worktreeDepFolders(ctx)) extra = extra.filter((x) => !x.startsWith(`${f}/`) && x !== f);
  if (extra.length > 0) { ctx.out(`note: the worktree ${p} is kept: it holds files git does not track (not removed): ${extra.slice(0, 3).map((x) => `${x} `).join('')}\n`); return; }
  const rm = proc.run('git', ['-C', main, 'worktree', 'remove', '--force', p], { cwd: main, env: ctx.childEnv(), stdio: ['ignore', 'ignore', 'ignore'] });
  const pr = rm.status === 0 ? proc.run('git', ['-C', main, 'worktree', 'prune'], { cwd: main, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }) : null;
  if (rm.status === 0 && pr && pr.status === 0) ctx.out(`worktree removed: ${id}\n`);
  else ctx.out(`note: the worktree ${p} could not be removed; agent.sh worktree-remove ${id} in the main working tree does it\n`);
}

/**
 * `cleanup_run ID`.
 * @param {Context} ctx @param {string} id
 */
export function cleanupRun(ctx, id, mergeProved = false) {
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  requireLead(ctx);
  if (isLink(dir) || path.dirname(dir) !== `${ctx.root}/.agents/runs`) fail(`refusing to remove ${dir}: not a plain run directory`);
  const state = sectionValue(ctx, dir, 'execution', 'state');
  const term = state === 'FAILED' || state === 'BLOCKED';
  { const mark = ctx.chunks.length; try { rulesCommand(ctx, ['tally']); } catch { /* the counter is a courtesy */ } ctx.chunks.length = mark; }
  if (term) {
    verifySeal(ctx, id, dir);
    const lines = ledgerLines(ctx, dir);
    const last = lines.filter((l) => !/ event=hook(-timeout)? /.test(l)).pop();
    const ok = last !== undefined && / event=(terminate|knowledge-done) /.test(last) && lines.some((l) => l.includes(' event=terminate '));
    if (!ok) fail(`cleanup of a ${state} run requires its ledgered terminate transition: ${id}`);
  } else {
    if (sectionValue(ctx, dir, 'handoff', 'state') !== 'DONE') fail(`cleanup requires handoff DONE (or a FAILED/BLOCKED run): ${id}`);
    const base = sectionValue(ctx, dir, 'repository', 'base_sha');
    if (base !== headSha(ctx)) {
      // Delivered: the commit moved HEAD past base_sha; task paths are measured from base_sha
      if (!isAncestor(ctx, base, 'HEAD')) fail(`cleanup blocked: HEAD does not descend from the run's base_sha ${base}`);
      ctx.ctpBase = base;
      quietly(ctx, () => { must(freshness(ctx, id)); must(verifyHandoff(ctx, id, true)); must(verifyKnowledgeScope(ctx, id)); });
      const owned = taskOwnedPaths(ctx, dir).map(([p]) => p);
      if (owned.length > 0) {
        const dirty = git(ctx, ['status', '--porcelain', '--untracked-files=all', '--', ...owned]).out.replace(/\n+$/, '');
        if (dirty !== '') fail(`cleanup blocked: task-owned changes are not committed exactly: ${dirty.split('\n').map((x) => `${x} `).join('').replace(/ $/, '')}`);
      }
    } else {
      quietly(ctx, () => { must(freshness(ctx, id)); must(verifyHandoff(ctx, id, true)); });
    }
    if (sectionKeyPresent(ctx, dir, 'completion_report', 'required')) {
      quietly(ctx, () => verifyCompletionReport(ctx, id));
    }
  }
  // A116: the run's per-run assignments directory goes with it; guard before any removal so a refusal leaves both.
  const adir = `${ctx.root}/.agents/local/assignments/${id}`;
  for (const p of [`${ctx.root}/.agents/local`, `${ctx.root}/.agents/local/assignments`]) if (isLink(p)) fail(`refusing to remove assignments under ${p}: it is a symlink`);
  if (existsSync(adir) || isLink(adir)) { if (isLink(adir) || !isDir(adir)) fail(`refusing to remove ${adir}: not a plain assignments directory`); }
  archiveRun(ctx, id, dir);
  const marker = `${ctx.root}/${ctx.config().get('active_run_file', '.agents/local/ACTIVE_RUN')}`;
  if (isFile(marker) && textLines(fileText(ctx, marker) ?? '').filter((l) => !/^[ \t\n\v\f\r]*$/.test(l)).join('\n') === id) writeFileSync(marker, '');
  if (isDir(adir)) { try { rmSync(adir, { recursive: true, force: true }); } catch { fail(`could not remove ${adir}; the run is kept, retry cleanup`); } }
  rmSync(dir, { recursive: true, force: true });
  ctx.forget('file:');
  ctx.out(`run cleaned up: ${id} (runtime artifacts and .agents/local/assignments/${id} removed; ACTIVE_RUN cleared)\n`);
  cleanupWorktree(ctx, id, term, mergeProved);
  return 0;
}
