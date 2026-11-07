// @ts-check
// The known-issues commands (A202, item 27; A222: they run in Node): known-issue-propose, known-issue-apply, known-issue-list, known-issue-candidates.
// A record (gate, place, finding text, follow-up task) exists only after the user's own `approve known issue` (kind known-issue, bound to the sha256 of
// the one proposed record). The data rules are in kirules.mjs; where a listed finding stops being blocking is knownissues.mjs.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { findApproval, hashOf, sharedDirOf } from '../approvals.mjs';
import { consumeApproval, requestApproval, requireLead } from '../approve.mjs';
import { fail } from '../errors.mjs';
import { KiError, appendRecord, candidates, canon, followupState, listRecords, listable } from '../kirules.mjs';
import { readBytes, gateField, validTaskId } from '../records.mjs';

/** @typedef {import('../context.mjs').Context} Context */

/** @param {string} p */
function isDirectory(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

/** `ki_run_dir RUN-ID`: the run's folder in this tree or in its task worktree; null when there is none. @param {Context} ctx @param {string} id */
function runFolder(ctx, id) {
  if (!validTaskId(id)) return null;
  if (isDirectory(ctx.runDir(id))) return ctx.runDir(id);
  const wt = `${ctx.sharedMain()}/.agents/local/worktrees/${id}/.agents/runs/${id}`;
  return isDirectory(wt) ? wt : null;
}

/** `known-issue-propose RUN FINDING-ID --followup TASK`: writes the one proposed record and asks the user (kind known-issue). @param {Context} ctx @param {string[]} args */
function propose(ctx, args) {
  requireLead(ctx);
  const [run = '', fid = ''] = args;
  if (args.length < 2) fail('usage: agent.sh known-issue-propose <RUN-ID> <FINDING-ID> --followup <TASK-ID>');
  let fu = '';
  for (let i = 2; i < args.length;) {
    if (args[i] !== '--followup') fail(`unknown argument: ${args[i]}`);
    fu = args[i + 1] ?? '';
    i += 2;
  }
  if (fu === '') fail('a known issue needs a follow-up task (--followup <TASK-ID>): a record without one is not valid');
  if (!validTaskId(fu)) fail(`invalid follow-up task id: ${fu}`);
  const rd = runFolder(ctx, run);
  if (rd === null) fail(`no run ${run} on this machine`);
  let rec = '';
  let names = [];
  try { names = readdirSync(`${rd}/gates`).filter((n) => /^[0-9]{3}-.*\.yaml$/.test(n)).sort(); } catch { names = []; }
  for (const n of names) if (canon(ctx, `${rd}/gates/${n}`, fid) !== null) rec = `${rd}/gates/${n}`;
  if (rec === '') fail(`no blocking finding ${fid} in a gate record of run ${run}`);
  const c = canon(ctx, rec, fid);
  if (c === null) fail(`no blocking finding ${fid} in a gate record of run ${run}`);
  const why = listable(ctx, c.gate, c.place);
  if (why !== null) { ctx.err(`known-issues: ${why}\n`); fail('this finding cannot be listed'); }
  switch (followupState(ctx, fu)) {
    case 'backlog': case 'todo': case 'in-progress': break;
    case 'done': fail(`the follow-up task ${fu} is already done`); break;
    default: fail(`the follow-up task ${fu} is not an open markdown task file of the project (create it first; known issues need the markdown task adapter)`);
  }
  const dir = sharedDirOf(ctx, 'known-issues');
  mkdirSync(dir, { recursive: true });
  const row = `${c.gate}\t${c.place}\t${c.text}\t${fu}\n`;
  writeFileSync(`${dir}/PROPOSAL.tsv`, Buffer.from(row, 'latin1'));
  ctx.forget('file:');
  ctx.out(row);
  return requestApproval(ctx, '-', 'known-issue');
}

/** `known-issue-apply`: writes the record only with the user's recorded approval of exactly the proposal. @param {Context} ctx */
function apply(ctx) {
  requireLead(ctx);
  const pf = `${sharedDirOf(ctx, 'known-issues')}/PROPOSAL.tsv`;
  const text = readBytes(pf) ?? '';
  if (text === '') fail('no known-issue proposal (agent.sh known-issue-propose)');
  const app = findApproval(ctx, '-', 'known-issue', hashOf(pf));
  if (app === null) fail('a known issue needs the user\'s approval: \'agent.sh request-approval - known-issue\' (known-issue-propose does it), relay it; the reply "approve known issue" records the approval');
  if (gateField(ctx, app, 'answered_by') !== 'user') fail("the approval is not the user's");
  const [g = '', p = '', t = '', f = ''] = (text.split('\n')[0] ?? '').split('\t');
  consumeApproval(ctx, '-', app);
  let id = '';
  try { id = appendRecord(ctx, g, p, t, f, app.slice(app.lastIndexOf('/') + 1)); } catch (e) {
    if (e instanceof KiError) { ctx.err(`known-issues: ${e.message}\n`); fail('the record was not written'); }
    throw e;
  }
  rmSync(pf, { force: true });
  ctx.forget('file:');
  ctx.out(`known issue recorded: ${id} (${g} ${p}, follow-up ${f})\n`);
  return 0;
}

/** @param {Context} ctx */
function list(ctx) { ctx.out(listRecords(ctx)); return 0; }

/** @param {Context} ctx */
function candidatesCommand(ctx) { ctx.out(candidates(ctx)); return 0; }

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const KI_HANDLERS = {
  'known-issue-propose': propose,
  'known-issue-apply': (ctx) => apply(ctx),
  'known-issue-list': (ctx) => list(ctx),
  'known-issue-candidates': (ctx) => candidatesCommand(ctx),
};
