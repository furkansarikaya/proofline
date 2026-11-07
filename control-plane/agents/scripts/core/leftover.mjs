// @ts-check
// Leftover worktrees (A215, A225). If the process of a standalone delivery dies after its merge proof but before `deliver-step cleanup` or `deliver-merged`
// finished (for example after the cleanup approval was consumed), the run's worktree stays behind and the second `deliver-step cleanup` is refused
// ("approval already used"). `proofline doctor` finds such a worktree here and PROPOSES the command that removes it; nothing in this module removes anything.
// A worktree is a leftover when its run is DONE and the merge is on record: a merged.tsv row of the task, a consumed cleanup approval of the run, or the delivered
// commit (the head of the delivery summary) reachable from the local canonical branch. A DONE run whose delivery is still in progress is not one.
import { readdirSync } from 'node:fs';
import { isDir } from './paths.mjs';
import * as proc from './proc.mjs';
import { fileText, gateField, readBytes, sectionValue, textLines } from './records.mjs';
import { rwValid } from './worktree.mjs';

/** @typedef {import('./context.mjs').Context} Context */
/** @typedef {{ id: string, dir: string, reason: string, command: string }} Leftover */

/** The registered worktrees of the project under .agents/local/worktrees/<ID>. @param {Context} ctx @returns {Array<{ id: string, dir: string }>} */
function taskWorktrees(ctx) {
  // -z: a folder name may hold a newline; the fields are NUL-separated
  const r = proc.run('git', ['-C', ctx.root, 'worktree', 'list', '--porcelain', '-z'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  const rows = r.stdout.toString('utf8').split('\0').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  const main = rows[0] ?? '';
  const base = `${main}/.agents/local/worktrees/`;
  return rows.filter((d) => main !== '' && d.startsWith(base) && !d.slice(base.length).includes('/')).map((d) => ({ id: d.slice(base.length), dir: d }));
}

/** @param {Context} ctx @param {string} wt @param {string} id @returns {string} why the merge counts as proved, or '' */
function mergeEvidence(ctx, wt, id) {
  const merged = fileText(ctx, `${ctx.sharedMain()}/.agents/local/batch/merged.tsv`);
  if (merged !== null && textLines(merged).some((l) => l.split('\t')[0] === id)) return 'its merge is recorded in the batch';
  const ad = `${wt}/.agents/runs/${id}/approvals`;
  /** @type {string[]} */ let names = [];
  try { names = readdirSync(ad).filter((n) => /^[0-9]{3}-cleanup\.yaml$/.test(n)); } catch { names = []; }
  if (names.some((n) => gateField(ctx, `${ad}/${n}`, 'consumed') === 'true')) return 'its cleanup approval was consumed';
  const sum = textLines(readBytes(`${wt}/.agents/local/deliver/${id}/SUMMARY.md`) ?? '');
  const head = (sum.find((l) => l.startsWith('head: ')) ?? '').slice(6);
  const branch = ctx.config().get('canonical_branch', 'main');
  if (/^[0-9a-f]{7,64}$/.test(head)) {
    const a = proc.run('git', ['-C', ctx.root, 'merge-base', '--is-ancestor', head, `refs/heads/${branch}`], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'ignore', 'ignore'] });
    if (a.status === 0) return `its delivered commit is on ${branch}`;
  }
  return '';
}

/** A word for a POSIX shell: unchanged when it holds only safe characters, else single-quoted with a quote written as '\'' . @param {string} s */
export function shQuote(s) {
  if (/^[A-Za-z0-9_.,:=@%+/-]+$/.test(s) && !s.startsWith('-')) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The worktrees of runs that are DONE and merged but still present. The proposed command is for the user to run (it archives the run's records first).
 * @param {Context} ctx @returns {Leftover[]}
 */
export function leftoverWorktrees(ctx) {
  // (quoting is a second line of defence: a valid id has only letters, digits, `_` and `-`)
  /** @type {Leftover[]} */ const out = [];
  for (const w of taskWorktrees(ctx)) {
    // the folder name is data a task could have chosen, and the command is pasted into a shell: only a name `worktree-remove` itself accepts is proposed
    if (!rwValid(w.id)) continue;
    if (!isDir(`${w.dir}/.agents/runs/${w.id}`)) continue;
    if (sectionValue(ctx, `${w.dir}/.agents/runs/${w.id}`, 'handoff', 'state') !== 'DONE') continue;
    const why = mergeEvidence(ctx, w.dir, w.id);
    if (why === '') continue;
    out.push({ id: w.id, dir: w.dir, reason: why, command: `sh .agents/scripts/agent.sh worktree-remove ${shQuote(w.id)} --force` });
  }
  return out;
}

/** `cli leftover-worktrees`: one line per leftover, `ID TAB folder TAB why TAB command`. @param {Context} ctx @param {string[]} args */
export function leftoverCommand(ctx, args) {
  void args;
  for (const l of leftoverWorktrees(ctx)) ctx.out(`${l.id}\t.agents/local/worktrees/${l.id}\t${l.reason}\t${l.command}\n`);
  return 0;
}
