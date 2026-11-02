// @ts-check
// Known issues (A202), the part the status block reads: the data rules stay in known-issues.sh (run as a child, like the task adapters, until its
// own stage); the decision whether a blocking finding is a listed known issue is made here (`ki_untouched`, `finding_known_issue`, `ki_gate_facts`).
import { readdirSync, statSync } from 'node:fs';
import { git, sortUnique, trackedPaths, untrackedPaths } from './git.mjs';
import { blockingFindingIds, gateLatestFile, requiredGates } from './gates.mjs';
import { isFile } from './paths.mjs';
import * as proc from './proc.mjs';
import { gateField, sectionValue } from './records.mjs';
import { riskGateFocuses } from './signals.mjs';
import { normRelPath, scopeEntryCovers } from './taskfile.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** `[ -s LIST.tsv ]` of the shared known-issues folder. @param {Context} ctx */
export function knownIssuesListed(ctx) {
  try { return statSync(`${ctx.sharedMain()}/.agents/local/known-issues/LIST.tsv`).size > 0; } catch { return false; }
}

/** `ki ARGS...`: known-issues.sh with the environment agent.sh gave it. @param {Context} ctx @param {string[]} args @returns {{ status: number, out: string }} */
export function ki(ctx, args) {
  const main = ctx.sharedMain();
  const script = `${ctx.trustedScripts}/known-issues.sh`;
  if (!isFile(script)) return { status: 127, out: '' };
  /** @type {string[]} */ const runs = [`${main}/.agents/runs`];
  try {
    for (const n of readdirSync(`${main}/.agents/local/worktrees`).sort()) {
      try { if (statSync(`${main}/.agents/local/worktrees/${n}/.agents/runs`).isDirectory()) runs.push(`${main}/.agents/local/worktrees/${n}/.agents/runs`); } catch { /* none */ }
    }
  } catch { /* no worktrees */ }
  const env = {
    ...ctx.childEnv(),
    KI_DIR: `${main}/.agents/local/known-issues`, KI_APPROVALS: `${main}/.agents/local/approvals`,
    KI_TASKS: `${main}/${ctx.config().get('tasks.dir', '.agents/tasks')}`, KI_ADAPTER: ctx.config().get('tasks.adapter', 'markdown'),
    KI_MAIN: main, KI_RUNS: `${runs.join(' ')} `,
  };
  const r = proc.run('sh', [script, ...args], { cwd: ctx.cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
  return { status: r.status, out: r.stdout.toString('latin1') };
}

/**
 * `ki_untouched ID PLACE`: true only when the run's frozen scope does not cover the place and the diff since the run's base does not hold it.
 * @param {Context} ctx @param {string} dir @param {string} place
 */
function kiUntouched(ctx, dir, place) {
  const scope = sectionValue(ctx, dir, 'freeze', 'scope_paths');
  if (scope === '') return false;
  const lower = (/** @type {string} */ s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  for (const e of scope.split(',').filter((x) => x !== '')) if (scopeEntryCovers(lower(e), lower(place))) return false;
  const base = sectionValue(ctx, dir, 'repository', 'base_sha');
  if (base === '') return false;
  const d = git(ctx, ['diff', '--no-renames', '--name-only', base]);
  if (d.status !== 0) return false;
  const all = sortUnique([...d.out.split('\n').filter((l) => l !== ''), ...trackedPaths(ctx), ...untrackedPaths(ctx)]).map(lower);
  const want = lower(normRelPath(place));
  if (want === '') return false;
  return !all.some((p) => p.replace(/^\.\//, '') === want);
}

/**
 * `finding_known_issue ID RECORD FINDING-ID`: "KI-n<TAB>follow-up..." when the blocking finding is an active record the task does not touch, else null.
 * @param {Context} ctx @param {string} id @param {string} rec @param {string} fid
 */
function findingKnownIssue(ctx, id, rec, fid) {
  if (!knownIssuesListed(ctx)) return null;
  const gate = gateField(ctx, rec, 'gate');
  if (gate === 'SECRETS' || gate === 'SECURITY') return null;
  const c = ki(ctx, ['canon', rec, fid]);
  if (c.status !== 0) return null;
  const row = c.out.replace(/\n+$/, '').split('\t');
  const [g, p] = row;
  const t = row.slice(2).join('\t');
  const m = ki(ctx, ['lookup', g, p, t]);
  if (m.status !== 0) return null;
  const mrow = m.out.replace(/\n+$/, '');
  if (mrow.split('\t')[1] === id) return null;
  if (!kiUntouched(ctx, `${ctx.root}/.agents/runs/${id}`, p.split(':')[0])) return null;
  return mrow;
}

/** `ki_gate_facts ID GATE`: "KI-n:FINDING:follow-up" for the gate's current blocking findings that are listed known issues. @param {Context} ctx @param {string} id @param {string} gate @returns {string[]} */
function gateFacts(ctx, id, gate) {
  const dir = `${ctx.root}/.agents/runs/${id}`;
  /** @type {string[]} */ const out = [];
  for (const fc of ['-', ...riskGateFocuses(ctx, dir, gate)]) {
    const f = gateLatestFile(ctx, dir, gate, fc);
    if (f === '' || gateField(ctx, f, 'result') !== 'fail') continue;
    for (const x of blockingFindingIds(ctx, f)) {
      const m = findingKnownIssue(ctx, id, f, x);
      if (m === null) continue;
      const cols = m.split('\t');
      out.push(`${cols[0]}:${x}:${cols[1]}`);
    }
  }
  return out;
}

/** The known issues of a run's required gates, as the status block lists them. @param {Context} ctx @param {string} id @returns {string[]} */
export function knownIssueFacts(ctx, id) {
  if (!knownIssuesListed(ctx)) return [];
  const dir = `${ctx.root}/.agents/runs/${id}`;
  return requiredGates(ctx, dir).flatMap((g) => gateFacts(ctx, id, g));
}
