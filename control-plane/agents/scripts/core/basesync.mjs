// @ts-check
// The canonical branch against its remote (A357, issue 338 B10). A merged pull request leaves the LOCAL canonical branch behind its remote, and the next run's worktree then
// started on a stale base (a restart of a task). `syncCanonical` fetches the branch from `origin`, and when the local branch is strictly behind it fast-forwards it (in the
// working tree that has it checked out, by `merge --ff-only`, so a local change in the way refuses instead of being overwritten; with `update-ref` when no working tree has it). A
// local branch that is ahead (unpushed commits) is left alone, a diverged one is a refusal, a project without `origin` or without that branch there is nothing to do. The fetch
// is a plain `fetch` of one branch into its tracking ref, with the hooks off and the cleaned tool environment, no prompt; when it fails the last known tracking ref is used.
// Nothing is ever pushed, reset or forced.
import { cleanToolEnv } from './platform.mjs';
import { hgit } from './hgit.mjs';
import { hooksOff } from './hooksoff.mjs';
import * as proc from './proc.mjs';

/** @typedef {import('./context.mjs').Context} Context */
/** @typedef {{ state: 'no-remote' | 'current' | 'ahead' | 'fast-forwarded' | 'behind' | 'diverged', ok: boolean, notes: string[], message: string }} Synced */

/**
 * @param {Context} ctx @param {string} tree the main working tree @param {string} branch the canonical branch (a plain branch name)
 * @returns {Synced} ok false: the branch is behind and could not be moved, or diverged (message says why); notes: what happened, for the user
 */
export function syncCanonical(ctx, tree, branch) {
  /** @type {string[]} */ const notes = [];
  /** @param {Synced['state']} state @param {boolean} ok @param {string} [message] @returns {Synced} */
  const done = (state, ok, message = '') => ({ state, ok, notes, message });
  if (!/^[A-Za-z0-9_./-]+$/.test(branch) || branch.startsWith('-')) return done('no-remote', true);
  // not ctx.childEnv(): that needs an installed project, and `proofline merge` runs in any repository
  const env = { ...ctx.env, LC_ALL: 'C', RTK_DISABLED: '1' };
  /** @param {string[]} a */
  const g = (a) => { const r = hgit(ctx, tree, a, { env }); return { status: r.status, out: r.stdout.toString('latin1').replace(/\n+$/, '') }; };
  if (g(['remote', 'get-url', 'origin']).status !== 0) return done('no-remote', true);
  const f = proc.run('git', ['-C', tree, '-c', `core.hooksPath=${hooksOff()}`, 'fetch', '--no-tags', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    cwd: tree, env: { ...cleanToolEnv(ctx, { remote: true }), GIT_TERMINAL_PROMPT: '0' }, input: '', stdio: ['pipe', 'pipe', 'pipe'], timeoutMs: 60000,
  });
  if (f.status !== 0) notes.push(`could not fetch origin (${f.stderr.toString('utf8').trim().split('\n')[0] ?? ''}): the last known origin/${branch} is used`);
  const remote = g(['rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
  if (remote.status !== 0 || remote.out === '') return done('no-remote', true);
  const local = g(['rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`]);
  if (local.status !== 0 || local.out === '') return done('no-remote', true);
  if (local.out === remote.out) return done('current', true);
  const isAnc = (/** @type {string} */ a, /** @type {string} */ b) => g(['merge-base', '--is-ancestor', a, b]).status === 0;
  if (isAnc(remote.out, local.out)) return done('ahead', true);
  if (!isAnc(local.out, remote.out)) return done('diverged', false, `the local ${branch} and origin/${branch} have diverged (each has commits the other lacks): proofline does not rebase or reset; bring them together yourself (for example \`git pull --rebase\` or a merge), then run it again`);
  const where = g(['for-each-ref', '--format=%(worktreepath)', `refs/heads/${branch}`]).out;
  if (where !== '') {
    const m = hgit(ctx, where, ['merge', '--ff-only', '-q', remote.out], { env });
    if (m.status !== 0) return done('behind', false, `the local ${branch} is behind origin/${branch} and could not be fast-forwarded in ${where} (a local change is in the way, or the tree is mid-operation): commit or stash it and run it again, or run \`git merge --ff-only origin/${branch}\` there`);
  } else if (g(['update-ref', '-m', 'proofline: fast-forward to origin', `refs/heads/${branch}`, remote.out, local.out]).status !== 0) {
    return done('behind', false, `the local ${branch} is behind origin/${branch} and could not be fast-forwarded (git update-ref failed)`);
  }
  notes.push(`fast-forwarded ${branch} to origin/${branch} (${remote.out.slice(0, 7)})`);
  return done('fast-forwarded', true);
}
