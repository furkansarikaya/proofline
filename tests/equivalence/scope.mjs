// @ts-check
// What a run of the rig covers (issue #166: "replay only touched commands per pull request, full replay nightly").
//   EQUIVALENCE_FULL=1        the heavy extras as well: the slow cases (timeouts, hook-timeouts) and the trace replay of every moved command's cases;
//                             the alternating-engine lifecycle and the downgrade test (needs history for bc072f3: CI fetch-depth 0) are acceptance tests and always run; every command counts as touched. CI sets it on schedule and workflow_dispatch.
//   EQUIVALENCE_COMMANDS=a,b  the touched commands, by hand (a developer's own choice; wins over the diff)
//   otherwise                 the touched commands come from the files changed against the merge base with origin/main (or main): a file under
//                             core/ that belongs to one command family narrows the set, any other control-plane or rig file means every command.
import { spawnSync } from 'node:child_process';
import { MOVED } from './cases/moved-commands.mjs';
import { STAGE2 } from './cases/stage2-commands.mjs';
import { repoRoot } from './fixture.mjs';

/** Every command a case can be attached to: the ten of stage 1 and the 41 of stage 2 (later stages add theirs here). */
export const ALL_COMMANDS = Object.freeze([...MOVED, ...STAGE2]);
export const FULL = process.env.EQUIVALENCE_FULL === '1';
export const SKIP_HEAVY = FULL ? false : 'heavy set: runs with EQUIVALENCE_FULL=1 (the nightly job)';

/** core/ files that serve one family of the ten commands; a change there touches only those. */
const FAMILY = /** @type {[RegExp, string[]][]} */ ([
  [/core\/timeouts\.mjs$/, ['timeouts', 'hook-timeouts', 'verify-timeout', 'tm-scaled']],
  [/core\/commands\/config-check\.mjs$/, ['config-check']],
]);
/** core/commands/<name>.mjs holds the command <name> (stage 2 and later): a change there touches that command only. */
const OWN = /core\/commands\/([a-z][a-z0-9-]*)\.mjs$/;

function changedFiles() {
  for (const base of ['origin/main', 'main']) {
    const mb = spawnSync('git', ['merge-base', 'HEAD', base], { cwd: repoRoot, encoding: 'utf8' });
    if (mb.status !== 0) continue;
    const d = spawnSync('git', ['diff', '--name-only', mb.stdout.trim()], { cwd: repoRoot, encoding: 'utf8' });
    if (d.status === 0) return d.stdout.split('\n').filter(Boolean);
  }
  return null;
}

/** @returns {string[]} the touched commands */
export function touchedCommands() {
  if (FULL) return [...ALL_COMMANDS];
  const env = process.env.EQUIVALENCE_COMMANDS;
  if (env) return env.split(',').filter((c) => ALL_COMMANDS.includes(c));
  const files = changedFiles();
  if (!files) return [...ALL_COMMANDS];
  const hit = new Set();
  for (const f of files) {
    if (!/^(control-plane\/agents\/|tests\/equivalence\/|tests\/bench\/)/.test(f)) continue;
    const fam = FAMILY.find(([re]) => re.test(f));
    const own = OWN.exec(f)?.[1];
    if (fam) fam[1].forEach((c) => hit.add(c));
    else if (own && ALL_COMMANDS.includes(own)) hit.add(own);
    else return [...ALL_COMMANDS];
  }
  return [...hit];
}
