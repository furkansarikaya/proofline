// @ts-check
// Runs: the active-run marker, the open runs, `require_run` (with the delivered-mode rule of A169), `effective`, and
// `known_control_artifact` (which files under a run folder are the control plane's own).
import { readdirSync, statSync } from 'node:fs';
import { fail } from './errors.mjs';
import { git, headSha, verifyRev, isAncestor } from './git.mjs';
import { boundNames, listNames } from './ledger.mjs';
import { isFile } from './paths.mjs';
import { fieldOf, fileLines, fileText, sectionValue, textLines, validTaskId } from './records.mjs';
import { pipelineNeeds } from './signals.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** `run_dir ID` @param {Context} ctx @param {string} id */
export function runDir(ctx, id) { return `${ctx.root}/.agents/runs/${id}`; }

/** @param {string} p */
function isDirectory(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

/** `active_run`: the id in the ACTIVE_RUN marker, '' when there is none. Fails when the marker is not one valid id of an existing run. @param {Context} ctx */
export function activeRun(ctx) {
  const marker = `${ctx.root}/${ctx.config().get('active_run_file', '.agents/local/ACTIVE_RUN')}`;
  if (!isFile(marker)) return '';
  const rows = textLines(fileText(ctx, marker) ?? '').filter((l) => !new RegExp(`^${'[ \\t\\n\\v\\f\\r]'}*$`).test(l));
  if (rows.length === 0) return '';
  if (rows.length !== 1) fail('ACTIVE_RUN must contain at most one task id');
  const task = rows[0];
  if (!validTaskId(task)) fail('invalid active task id');
  if (!isDirectory(runDir(ctx, task))) fail(`active run not found: ${task}`);
  return task;
}

/** The run folders in glob order (`.agents/runs/*`, no dot files). @param {Context} ctx */
function runFolders(ctx) {
  try { return readdirSync(`${ctx.root}/.agents/runs`).filter((n) => !n.startsWith('.')).sort(); } catch { return []; }
}

/** `open_runs`: "<ID> <task branch|->" for every run that is not terminated. @param {Context} ctx @returns {string[]} */
export function openRuns(ctx) {
  /** @type {string[]} */ const out = [];
  for (const id of runFolders(ctx)) {
    const d = runDir(ctx, id);
    if (!isDirectory(d)) continue;
    if (!isFile(`${d}/RUN.yaml`)) { out.push(`${id} -`); continue; }
    const st = sectionValue(ctx, d, 'execution', 'state');
    if (st === 'FAILED' || st === 'BLOCKED') continue;
    let b = sectionValue(ctx, d, 'repository', 'task_branch');
    if (b === '' || b === 'PENDING') b = '-';
    out.push(`${id} ${b}`);
  }
  return out;
}

/** `deliver_dir ID` @param {Context} ctx @param {string} id */
function deliverDir(ctx, id) { return `${ctx.root}/.agents/local/deliver/${id}`; }

/** The first line that starts with PREFIX, without it (`sed -n 's/^PREFIX//p' | head -1`). @param {string[]} lines @param {string} prefix */
function lineValue(lines, prefix) {
  for (const l of lines) if (l.startsWith(prefix)) return l.slice(prefix.length);
  return '';
}

/** `ci_fix_recs ID`: the attempt records bound in the ledger, oldest first. @param {Context} ctx @param {string} dir @returns {string[]} */
function ciFixRecs(ctx, dir) {
  const names = listNames(`${dir}/ci-fix`, /^[0-9]{3}\.yaml$/);
  return boundNames(ctx, dir, 'ci-fix', 'ci-fix-', names).sort().map((n) => `${dir}/ci-fix/${n}`);
}

/** `ci_chain_ok ID`: HEAD is the delivery's own commit chain. @param {Context} ctx @param {string} id */
export function ciChainOk(ctx, id) {
  const dir = runDir(ctx, id);
  const summary = `${deliverDir(ctx, id)}/SUMMARY.md`;
  if (!isFile(summary)) return false;
  const lines = fileLines(ctx, summary);
  const h0 = lineValue(lines, 'head: ');
  const msg = lineValue(lines, 'message: ');
  let tip = h0;
  if (` ${lineValue(lines, 'steps: ')} `.includes(' commit ')) {
    const c = git(ctx, ['rev-list', '--reverse', '--ancestry-path', `${h0}..HEAD`]).out.split('\n')[0] ?? '';
    if (c === '' || verifyRev(ctx, `${c}^`) !== h0) return false;
    if (git(ctx, ['log', '-1', '--format=%s', c]).out.replace(/\n+$/, '') !== msg) return false;
    tip = c;
  }
  for (const f of ciFixRecs(ctx, dir)) {
    const ch = fieldOf(fileLines(ctx, f), 'committed_head');
    if (ch === '' || ch === 'PENDING') continue;
    if (verifyRev(ctx, `${ch}^`) !== tip) return false;
    tip = ch;
  }
  return headSha(ctx) === tip;
}

/**
 * `delivered_mode ID` (A169): a run whose HEAD is its own delivery commit chain has that commit under it, so its task paths are measured
 * from base_sha. Sets ctx.ctpBase.
 * @param {Context} ctx @param {string} id
 */
export function deliveredMode(ctx, id) {
  if (ctx.memo.get('delivered-mode') === id) return;
  ctx.memo.set('delivered-mode', id);
  const b = sectionValue(ctx, runDir(ctx, id), 'repository', 'base_sha');
  if (b === '' || b === 'PENDING') return;
  if (!isAncestor(ctx, b, 'HEAD')) return;
  if (b === headSha(ctx)) return;
  if (!ciChainOk(ctx, id)) return;
  ctx.ctpBase = b;
}

/** `require_run ID` @param {Context} ctx @param {string} id */
export function requireRun(ctx, id) {
  if (!validTaskId(id)) fail('invalid task id');
  if (!isDirectory(runDir(ctx, id))) fail(`run not found: ${id}`);
  if (isFile(`${deliverDir(ctx, id)}/SUMMARY.md`)) deliveredMode(ctx, id);
}

/** `run_profile ID` @param {Context} ctx @param {string} id */
export function runProfile(ctx, id) {
  let rp = '';
  if (id !== '' && isFile(`${runDir(ctx, id)}/RUN.yaml`)) rp = sectionValue(ctx, runDir(ctx, id), 'execution', 'profile');
  return rp === 'max' || rp === 'balanced' || rp === 'economy' ? rp : ctx.config().get('profile', 'balanced');
}

/**
 * `effective [ID]`: the mode, profile, task and policy lines, then the policy file's `section.key=value` rows.
 * @param {Context} ctx @param {string} given @returns {string}
 */
export function effective(ctx, given) {
  let task = given;
  if (task === '') task = activeRun(ctx);
  if (task !== '') requireRun(ctx, task);
  let mode = '';
  if (task !== '' && isFile(`${runDir(ctx, task)}/RUN.yaml`)) mode = sectionValue(ctx, runDir(ctx, task), 'execution', 'mode');
  if (mode === '' || mode === 'PENDING') mode = ctx.config().get('default_mode', 'deterministic');
  const profile = runProfile(ctx, task);
  const policy = `${ctx.agents}/modes/${mode}.yaml`;
  if (!isFile(policy)) fail(`invalid mode: ${mode}`);
  let out = `mode=${mode}\nprofile=${profile}\ntask=${task === '' ? 'none' : task}\nimplementation_allowed=${task !== '' ? 'true' : 'false'}\npolicy=${policy.slice(ctx.root.length + 1)}\n`;
  let section = '';
  for (const line of textLines(fileText(ctx, policy) ?? '')) {
    if (/^[a-z_]+:$/.test(line)) { section = line.slice(0, -1); continue; }
    if (/^[ \t\n\v\f\r]+[a-z_]+:/.test(line)) {
      const l = line.replace(/^[ \t\n\v\f\r]+/, '');
      const key = l.replace(/:[^]*$/, '');
      const value = l.replace(/^[^:]*:[ \t\n\v\f\r]*/, '');
      if (value !== '') out += `${section}.${key}=${value}\n`;
    }
  }
  return out;
}

/** `lifecycle_folder_status PATH` @param {string} p */
export function lifecycleFolderStatus(p) {
  const parts = p.split('/');
  const parent = parts.length >= 2 ? parts[parts.length - 2] : '.';
  return ['backlog', 'todo', 'in-progress', 'done'].includes(parent) ? parent : '';
}

/**
 * `known_control_artifact ID PATH`: a file the control plane itself keeps (a run's records), or the bookkeeping of a published or
 * reopened run (its task file).
 * @param {Context} ctx @param {string} id @param {string} p
 */
export function knownControlArtifact(ctx, id, p) {
  const dir = runDir(ctx, id);
  if (!p.startsWith(`.agents/runs/${id}/`)) {
    let reopened = false;
    try { reopened = readdirSync(`${dir}/gates`).some((n) => n.endsWith('-REOPEN.yaml') && /^.*$/.test(n)); } catch { /* none */ }
    if (sectionValue(ctx, dir, 'completion_report', 'published') === 'true' || reopened) {
      const src = sectionValue(ctx, dir, 'task_source', 'path');
      if (src !== '' && p === src) return true;
      const td = ctx.config().get('tasks.dir', '.agents/tasks');
      if (p.startsWith(`${td}/`) && src !== '' && p.split('/').pop() === src.split('/').pop() && lifecycleFolderStatus(src) === 'done' && !isFile(`${ctx.root}/${p}`) && !isDirectory(`${ctx.root}/${p}`)) return true;
    }
    return false;
  }
  const rel = p.slice(`.agents/runs/${id}/`.length);
  if (['TASK.md', 'PLAN.md', 'RUN.yaml', 'COMPLETION_REPORT.md', 'LEDGER.log', 'HOOKS.log', 'VERIFY.md', 'mutation_budget', '.lock/pid'].includes(rel)) return true;
  if (/^(amendments|dispatch|worker-evidence|decisions|gates|results|reports|questions|approvals|waivers|security|ci-fix|scratch)\//.test(rel)) return true;
  if (/^reviews\/(proof-review\/(plan|rules|small)|test-trust\/(tests|qa)|data-design|proof-review\/config|contract-proof|concurrency-proof|performance-proof|data-migration|visual-proof)\//.test(rel)) return true;
  if (/^design\/[^/]*\.(md|json)$/.test(rel)) return true;
  if (rel === 'EVIDENCE.md') return pipelineNeeds(ctx, dir, 'evidence') === 'yes';
  if (rel === 'QA_PLAN.md' || rel === 'QA_REPORT.md') return pipelineNeeds(ctx, dir, 'qa') === 'yes';
  return false;
}
