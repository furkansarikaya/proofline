// @ts-check
// Stage 2, package C2: the READ-ONLY part of the approval and batch library of agent.sh (find_approval, safe_state_file, batch_approval,
// the DESIGN.md rationale lines). Nothing here writes an approval: consuming one (`consume_approval`, `approval-consume`) and the batch
// summary writer stay in the shell (stages 3-7); a path that needs them throws BridgeToShell in its command.
import { lstatSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { boundNames } from './ledger.mjs';
import { sha256File } from './hash.mjs';
import * as proc from './proc.mjs';
import { isFile } from './paths.mjs';
import { WS, gateField, gatesEnforced, textLines } from './records.mjs';
import { runDir } from './runs.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const SHARED_NAMES = ['batch', 'approvals', 'metrics', 'friction', 'prompts'];

/** `shared_dir NAME` @param {Context} ctx @param {string} name */
export function sharedDirOf(ctx, name) { return `${ctx.sharedMain()}/.agents/local/${name}`; }

/** `approvals_dir ID`: the shared folder for `-`, else the run's. @param {Context} ctx @param {string} id */
function approvalsDir(ctx, id) { return id === '-' ? sharedDirOf(ctx, 'approvals') : `${runDir(ctx, id)}/approvals`; }

/** `[ -L P ]` @param {string} p */
function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

/**
 * `safe_state_file FILE`: a regular file with one hard link, no symlink on its folder chain below the project root (or, for the shared
 * state of a run worktree, below the main tree's shared folders).
 * @param {Context} ctx @param {string} file
 */
export function safeStateFile(ctx, file) {
  if (isLink(file) || !isFile(file)) return false;
  try { const st = statSync(file); if (!st.isFile() || st.nlink !== 1) return false; } catch { return false; }
  let d = path.dirname(file);
  let base = ctx.root;
  const main = ctx.sharedMain();
  const under = (/** @type {string} */ x, /** @type {string} */ r) => x === r || x.startsWith(`${r}/`);
  if (!under(d, ctx.root) && under(d, main)) {
    base = main;
    let ok = SHARED_NAMES.some((n) => under(d, `${main}/.agents/local/${n}`));
    const wp = `${main}/.agents/local/worktrees/`;
    if (d.startsWith(wp)) {
      const w = d.slice(wp.length).split('/')[0];
      const r = proc.run('git', ['-C', main, 'worktree', 'list', '--porcelain'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
      if (r.stdout.toString('latin1').split('\n').some((l) => l === `worktree ${wp}${w}`)) ok = true;
    }
    if (!ok) return false;
  }
  while (d !== base) {
    if (!d.startsWith(`${base}/`)) return false;
    if (isLink(d)) return false;
    d = path.dirname(d);
  }
  return true;
}

/**
 * `find_approval ID KIND BOUND [DELIVERY]`: the newest unconsumed approval file bound to BOUND, or null. Inside a ledgered run only the
 * approvals the ledger names count.
 * @param {Context} ctx @param {string} id @param {string} kind @param {string} bound @param {string} [delivery]
 */
export function findApproval(ctx, id, kind, bound, delivery = '') {
  const dir = approvalsDir(ctx, id);
  const re = new RegExp(`^[0-9]{3}-${kind.replace(/:/g, '-')}\\.yaml$`);
  let all;
  try { all = readdirSync(dir).filter((n) => re.test(n)).sort().reverse(); } catch { all = []; }
  if (all.length > 0 && id !== '-' && gatesEnforced(ctx, runDir(ctx, id))) {
    all = boundNames(ctx, runDir(ctx, id), 'approvals', 'approval$', all).sort().reverse();
  }
  for (const n of all) {
    const f = `${dir}/${n}`;
    if (!safeStateFile(ctx, f)) continue;
    if (gateField(ctx, f, 'consumed') === 'false' && gateField(ctx, f, 'bound') === bound && (delivery === '' || gateField(ctx, f, 'delivery') === delivery)) return f;
  }
  return null;
}

/** `hash_file FILE` of a file that exists. @param {string} file */
export function hashOf(file) { return sha256File(file); }

/** `batch_approval`: the batch approval file, valid while SUMMARY.md has the hash it is bound to. @param {Context} ctx @returns {string | null} */
export function batchApproval(ctx) {
  const s = `${sharedDirOf(ctx, 'batch')}/SUMMARY.md`;
  if (!isFile(s)) return null;
  const f = findApproval(ctx, '-', 'batch', hashOf(s));
  if (f === null) return null;
  if (gateField(ctx, f, 'answered_by') !== 'user') return null;
  const src = gateField(ctx, f, 'source');
  return src === 'prompt_capture' || src === 'tty' ? f : null;
}

// ---- DESIGN.md pattern justifications (A200) ---------------------------------------------------------------------------------

/** `design_md_candidates` */
export const DESIGN_MD_CANDIDATES = ['DESIGN.md', 'docs/design/DESIGN.md', 'docs/DESIGN.md', 'design/DESIGN.md'];

const reHeading = new RegExp(`^${WS}?${WS}?${WS}?#+${WS}`);
const reItem = new RegExp(`^${WS}*[-*+]${WS}+\`?[a-z][a-z0-9-]*\`?${WS}*:`);

/** @param {string} line the heading is the "pattern justifications" one */
function isJustifications(line) {
  const h = line.replace(new RegExp(`^${WS}*#+${WS}*`), '').replace(new RegExp(`${WS}*#*${WS}*$`), '');
  return h.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)) === 'pattern justifications';
}

/**
 * The lines of the "Pattern justifications" section that are `- id: reason` items.
 * @param {string} text @returns {string[]}
 */
function justificationItems(text) {
  /** @type {string[]} */ const out = [];
  let inside = false;
  for (const line of textLines(text)) {
    if (reHeading.test(line)) { inside = isJustifications(line); continue; }
    if (inside && reItem.test(line)) out.push(line);
  }
  return out;
}

/** The sorted unique pattern ids of a DESIGN.md. @param {string} text */
export function rationaleIds(text) {
  const ids = justificationItems(text).map((l) => l.replace(new RegExp(`^${WS}*[-*+]${WS}+`), '').replace(new RegExp(`${WS}*:[^]*$`), '').replace(/`/g, ''));
  return [...new Set(ids)].sort();
}

/** `rationale_line_in ID FILE`: "ID: reason" of the first non-empty justification of ID. @param {string} id @param {string} text */
export function rationaleLineIn(id, text) {
  for (const l0 of justificationItems(text)) {
    const l = l0.replace(new RegExp(`^${WS}*[-*+]${WS}+`), '');
    const k = l.replace(new RegExp(`${WS}*:[^]*$`), '').replace(/`/g, '');
    const v = l.replace(/^[^:]*:/, '').replace(new RegExp(`^${WS}*`), '').replace(new RegExp(`${WS}+$`), '');
    if (k === id && v !== '') return `${id}: ${v}`;
  }
  return '';
}
