// @ts-check
// ONE hermetic git for every call on a checkout (A248, Part of #165; hardens A238/A218). A filter driver (`filter.<n>.clean|smudge|process`) or an `includeIf` that a
// repository config defines is code git runs on every file it reads or writes. deliver-merged looks for such drivers, and every git call on a checkout it
// touches (the main tree, the run's worktree) carries the blanking: the file system monitor off and each driver's three commands set empty, through the
// ENVIRONMENT (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n, GIT_CONFIG_VALUE_n), where a name is a key and not a `-c name=value` text that an `=` in the name would cut.
import * as proc from './proc.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The keys that matter, lower-cased by git for the section and the variable (the sub-section keeps its case). */
export const DRIVER_KEYS = '^(filter\\..*\\.(smudge|process|clean)|includeif\\..*\\.path)$';

/**
 * Read the driver names and the includes out of `git config --show-scope --name-only -z --get-regexp` output: NUL separated `scope, key` pairs, so a value
 * (never asked for) cannot make a name, and a name with an `=`, a space or a dot is still one name: the sub-section is what is between the first dot and the last one.
 * Only the repository's own scopes count: a system or global driver is the administrator's or the user's own (A238).
 * @param {string} raw latin1 output @returns {{ names: string[], includes: boolean }}
 */
export function parseDrivers(raw) {
  const f = raw.split('\0');
  /** @type {Set<string>} */ const names = new Set();
  let includes = false;
  for (let i = 0; i + 1 < f.length; i += 2) {
    if (!/^(local|worktree|command)$/.test(f[i])) continue;
    const key = f[i + 1];
    const m = /^filter\.(.*)\.(?:smudge|process|clean)$/is.exec(key);
    if (m) { if (m[1] !== '') names.add(m[1]); continue; }
    if (/^includeif\..*\.path$/is.test(key)) includes = true;
  }
  return { names: [...names], includes };
}

/**
 * The repository-controlled drivers visible from each of TREES (the main tree AND the run's worktree: an `includeIf onbranch:` include is judged by the branch checked out in
 * the tree git runs in, so one tree sees a driver the other does not). Names are the union, `includes` is true when any tree has an include.
 * @param {string} gitBin @param {string[]} trees @param {(tree: string) => { cwd?: string, env: Record<string, string> }} where
 * @returns {{ names: string[], includes: boolean }}
 */
export function repoDrivers(gitBin, trees, where) {
  /** @type {Set<string>} */ const names = new Set();
  let includes = false;
  for (const tree of new Set(trees)) {
    const w = where(tree);
    const r = proc.run(gitBin, ['-C', tree, '-c', 'core.fsmonitor=false', 'config', '--show-scope', '--name-only', '-z', '--get-regexp', DRIVER_KEYS], { cwd: w.cwd, env: w.env, stdio: ['ignore', 'pipe', 'ignore'] });
    const d = parseDrivers(r.stdout.toString('latin1'));
    for (const n of d.names) names.add(n);
    if (d.includes) includes = true;
  }
  return { names: [...names], includes };
}

/**
 * The environment entries that set the file system monitor off and blank each driver. Added after any GIT_CONFIG_COUNT the base environment already has, so a
 * count in the caller's environment is kept and cannot hide ours.
 * @param {Record<string, string | undefined>} base @param {string[]} names @returns {Record<string, string>}
 */
export function hermeticEnv(base, names) {
  /** @type {Record<string, string>} */ const out = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  const have = Number(out['GIT_CONFIG_COUNT']);
  let n = Number.isInteger(have) && have > 0 && have < 10000 ? have : 0;
  /** @param {string} k @param {string} v */
  const put = (k, v) => { out[`GIT_CONFIG_KEY_${n}`] = k; out[`GIT_CONFIG_VALUE_${n}`] = v; n += 1; };
  put('core.fsmonitor', 'false');
  for (const name of names) for (const v of ['clean', 'smudge', 'process']) put(`filter.${name}.${v}`, '');
  out['GIT_CONFIG_COUNT'] = String(n);
  return out;
}

/**
 * One git call on TREE with the blanking of `ctx.gitBlank` (the driver names deliver-merged found) and the file system monitor off.
 * @param {Context} ctx @param {string} tree @param {string[]} args
 * @param {{ bin?: string, env?: Record<string, string | undefined>, cwd?: string, input?: string | Buffer, stdio?: Array<'pipe' | 'ignore' | 'inherit'> }} [opt]
 */
export function hgit(ctx, tree, args, opt = {}) {
  return proc.run(opt.bin ?? 'git', ['-C', tree, ...args], {
    cwd: opt.cwd ?? ctx.cwd, env: hermeticEnv(opt.env ?? ctx.childEnv(), ctx.gitBlank), input: opt.input, stdio: opt.stdio ?? ['ignore', 'pipe', 'ignore'],
  });
}
