// @ts-check
// What a run of the rig covers (issue #166: "replay only touched commands per pull request, full replay nightly").
//   EQUIVALENCE_FULL=1        the heavy extras as well: the slow cases (timeouts, hook-timeouts) and the trace replay of every moved command's cases;
//                             the alternating-engine lifecycle and the downgrade test (needs history for bc072f3: CI fetch-depth 0) are acceptance tests and always run; every command counts as touched. CI sets it on schedule and workflow_dispatch.
//   EQUIVALENCE_COMMANDS=a,b  the touched commands, by hand (a developer's own choice; wins over the diff)
//   otherwise                 the touched commands come from the files changed against the merge base with origin/main (or main): a file under
//                             core/ that belongs to one command family narrows the set. Any other control-plane, rig or bench file (a shared library,
//                             the rig itself, a case table) selects the REPRESENTATIVE set: one command per family (REPRESENTATIVE) on the light fixture
//                             states only (LIGHT_STATES; the heavy states cost 80 to 90 seconds of fixture build each). The always-on acceptance tests (node
//                             absent, role table, lock interop, seam safety, glob differential, the closed normalisation list and the planted differences
//                             of the rig, the lifecycle, the downgrade, the cross-version approval) are not scoped at all. The full replay of every command
//                             on every state is the nightly and manual run (EQUIVALENCE_FULL=1), sharded by file in ci.yml.
import { spawnSync } from 'node:child_process';
import { MOVED } from './cases/moved-commands.mjs';
import { STAGE2 } from './cases/stage2-commands.mjs';
import { STAGE3 } from './cases/stage3-commands.mjs';
import { EXTRA_STATES, RUN_STATES, SCALE_STATES } from './cases/stage2-fixtures.mjs';
import { repoRoot } from './fixture.mjs';

/** Every command a case can be attached to: the ten of stage 1 and the 41 of stage 2 (later stages add theirs here). */
export const ALL_COMMANDS = Object.freeze([...MOVED, ...STAGE2, ...STAGE3]);
export const FULL = process.env.EQUIVALENCE_FULL === '1';
export const SKIP_HEAVY = FULL ? false : 'heavy set: runs with EQUIVALENCE_FULL=1 (the nightly job)';

/** core/ files that serve one family of the ten commands; a change there touches only those. */
const FAMILY = /** @type {[RegExp, string[]][]} */ ([
  [/core\/timeouts\.mjs$/, ['timeouts', 'hook-timeouts', 'verify-timeout', 'tm-scaled']],
  [/core\/commands\/config-check\.mjs$/, ['config-check']],
]);
/** core/commands/<name>.mjs holds the command <name> (stage 2 and later): a change there touches that command only. */
const OWN = /core\/commands\/([a-z][a-z0-9-]*)\.mjs$/;

/** One command per family, checked on the light states only when a shared file changed. */
export const REPRESENTATIVE = Object.freeze(['role', 'config-get', 'config-check', 'db-config', 'hook-config', 'timeouts', 'help',
  'status', 'effective', 'fingerprint', 'pipeline', 'next', 'summary', 'plan-section', 'digest', 'verify-gates', 'verify-seal', 'verify-freeze', 'freshness',
  'debt', 'questions', 'validate', 'report-facts', 'ci-check',
  'next-user', 'worktree-root', 'in-knowledge-scope', 'request-approval', 'approve', 'language-check', 'window-open'].filter((c) => ALL_COMMANDS.includes(c)));
/** The cheap fixture states (under 5 seconds a case); every other state is heavy. */
export const LIGHT_STATES = Object.freeze(['empty', 'gates-frozen', 'intake-unclassified', 'gates-pending-plan']);
const STATE_NAMES = new Set([...RUN_STATES, ...EXTRA_STATES, ...SCALE_STATES]);

function changedFiles() {
  for (const base of ['origin/main', 'main']) {
    const mb = spawnSync('git', ['merge-base', 'HEAD', base], { cwd: repoRoot, encoding: 'utf8' });
    if (mb.status !== 0) continue;
    const d = spawnSync('git', ['diff', '--name-only', mb.stdout.trim()], { cwd: repoRoot, encoding: 'utf8' });
    if (d.status === 0) return d.stdout.split('\n').filter(Boolean);
  }
  return null;
}

/**
 * The selection for a list of changed files (pure, tested): `full` commands run on every state of their cases; `representative` commands run on the
 * light states only. A file nobody maps to a command family selects the representative set, never every command.
 * @param {string[]} files
 * @returns {{ full: string[], representative: string[] }}
 */
export function selectScope(files) {
  const full = new Set(); let shared = false;
  for (const f of files) {
    if (!/^(control-plane\/agents\/|tests\/equivalence\/|tests\/bench\/)/.test(f)) continue;
    const fam = FAMILY.find(([re]) => re.test(f));
    const own = OWN.exec(f)?.[1];
    if (fam) fam[1].forEach((c) => full.add(c));
    else if (own && ALL_COMMANDS.includes(own)) full.add(own);
    else shared = true;
  }
  return { full: [...full], representative: shared ? REPRESENTATIVE.filter((c) => !full.has(c)) : [] };
}

/** @type {{ full: string[], representative: string[] } | undefined} */
let memo;
/** The selection of this run. */
export function scope() {
  if (memo) return memo;
  if (FULL) return (memo = { full: [...ALL_COMMANDS], representative: [] });
  const env = process.env.EQUIVALENCE_COMMANDS;
  if (env) return (memo = { full: env.split(',').filter((c) => ALL_COMMANDS.includes(c)), representative: [] });
  const files = changedFiles();
  return (memo = files ? selectScope(files) : { full: [...ALL_COMMANDS], representative: [] });
}

/** Is a case in this run's scope? A case of a `full` command always; a case of a `representative` command only on a light state (a case that names no fixture state is cheap and counts as light). @param {{ name: string, steps: { args?: string[] }[] }} c @param {{ full: string[], representative: string[] }} [sel] */
export function caseInScope(c, sel = scope()) {
  const cmds = c.steps.flatMap((x) => (x.args && x.args[0] ? [x.args[0]] : []));
  if (cmds.some((m) => sel.full.includes(m))) return true;
  if (!cmds.some((m) => sel.representative.includes(m))) return false;
  const state = /^[a-z-]+: ([a-z0-9-]+)/.exec(c.name)?.[1];
  return !state || !STATE_NAMES.has(state) || LIGHT_STATES.includes(state);
}

/** @returns {string[]} the touched commands (the full and the representative ones) */
export function touchedCommands() {
  const sel = scope();
  return [...new Set([...sel.full, ...sel.representative])];
}
