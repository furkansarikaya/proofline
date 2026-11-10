// @ts-check
// ONE hermetic git for every call on a checkout (A248, Part of #165; hardens A238/A218). A filter driver (`filter.<n>.clean|smudge|process`) or an `includeIf` that a
// repository config defines is code git runs on every file it reads or writes. deliver-merged looks for such drivers, and every git call on a checkout it
// touches (the main tree, the run's worktree) carries the blanking: the file system monitor off and each driver's three commands set empty, through the
// ENVIRONMENT (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n, GIT_CONFIG_VALUE_n), where a name is a key and not a `-c name=value` text that an `=` in the name would cut.
import { existsSync } from 'node:fs';
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
 * the tree git runs in, so one tree sees a driver the other does not) AND of every populated submodule below them, recursively (A248 round 3): git starts a git in a checked out
 * submodule for a status, a diff, an add or a switch; that child reads the SUBMODULE's own configuration and inherits our environment, so the submodule's drivers are blanked by
 * name too, and no `submodule.<n>.ignore`, `diff.ignoreSubmodules` or `status.ignoreSubmodules` (a config or a `.gitmodules` can set the first per submodule) can matter.
 * Names are the union, `includes` is true when any tree or submodule has an include. Only configuration is read (`git config`, `ls-files --stage`): no work tree file, so no filter.
 * @param {string} gitBin @param {string[]} trees @param {(tree: string) => { cwd?: string, env: Record<string, string> }} where
 * @returns {{ names: string[], includes: boolean, submodules: string[] }}
 */
export function repoDrivers(gitBin, trees, where) {
  /** @type {Set<string>} */ const names = new Set();
  /** @type {Set<string>} */ const seen = new Set();
  /** @type {string[]} */ const submodules = [];
  let includes = false;
  /** @param {string} tree @param {number} depth */
  const visit = (tree, depth) => {
    if (seen.has(tree) || depth > 8) return;
    seen.add(tree);
    const w = where(tree);
    const q = (/** @type {string[]} */ a) => proc.run(gitBin, ['-C', tree, '-c', 'core.fsmonitor=false', ...a], { cwd: w.cwd, env: w.env, stdio: ['ignore', 'pipe', 'ignore'] });
    const d = parseDrivers(q(['config', '--show-scope', '--name-only', '-z', '--get-regexp', DRIVER_KEYS]).stdout.toString('latin1'));
    for (const n of d.names) names.add(n);
    if (d.includes) includes = true;
    for (const rel of gitlinkNames((a) => q(a).stdout, tree)) {
      const sub = Buffer.concat([Buffer.from(`${tree}/`), rel]).toString('utf8');
      submodules.push(sub);
      visit(sub, depth + 1);
    }
  };
  for (const tree of trees) visit(tree, 0);
  return { names: [...names], includes, submodules };
}

/**
 * The checked out submodules of TREE (a gitlink whose folder has its own `.git`), from the index alone (`ls-files --stage -z` reads no work tree file). The paths are bytes: a
 * non-ASCII name must reach the file system as the bytes git printed (a latin1 or utf8 round trip would name another file and the guard would fail open).
 * @param {(args: string[]) => Buffer} run git in TREE, its stdout @param {string} tree @returns {Buffer[]} the names, relative to TREE
 */
function gitlinkNames(run, tree) {
  const buf = run(['ls-files', '--stage', '-z']);
  /** @type {Buffer[]} */ const out = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 0) continue;
    const rec = buf.subarray(start, i);
    start = i + 1;
    const tab = rec.indexOf(9);
    if (tab < 0 || !/^160000 [0-9a-f]+ [0-3]$/.test(rec.subarray(0, tab).toString('latin1'))) continue;
    const name = rec.subarray(tab + 1);
    if (existsSync(Buffer.concat([Buffer.from(`${tree}/`), name, Buffer.from('/.git')]))) out.push(Buffer.from(name));
  }
  return out;
}

/**
 * The environment entries that set the file system monitor off and blank each driver. Added after any GIT_CONFIG_COUNT the base environment already has, so a
 * count in the caller's environment is kept and cannot hide ours.
 * @param {Record<string, string | undefined>} base @param {string[]} names @returns {Record<string, string>}
 */
export function hermeticEnv(base, names) {
  /** @type {Record<string, string>} */ const out = {};
  // GIT_CONFIG_PARAMETERS (the `-c` carrier) is applied by git AFTER GIT_CONFIG_COUNT, so a caller's value could undo the blanking: it is dropped
  for (const [k, v] of Object.entries(base)) if (v !== undefined && k !== 'GIT_CONFIG_PARAMETERS') out[k] = v;
  const cnt = out['GIT_CONFIG_COUNT'];
  let n = cnt !== undefined && /^\d+$/.test(cnt) && Number(cnt) < 10000 ? Number(cnt) : 0;
  /** @param {string} k @param {string} v */
  const put = (k, v) => { out[`GIT_CONFIG_KEY_${n}`] = k; out[`GIT_CONFIG_VALUE_${n}`] = v; n += 1; };
  put('core.fsmonitor', 'false');
  // A checked out submodule is entered by git for a status, a diff, an add or a switch, and the child reads the SUBMODULE's own configuration. That is met by blanking the
  // submodule's drivers by name (repoDrivers; the child inherits this environment), NOT by an ignore setting: `submodule.<n>.ignore=none` (config or `.gitmodules`) overrides
  // `diff.ignoreSubmodules` and `status.ignoreSubmodules`. `short` and `recurse=false` keep git from starting a child DIFF in a submodule (diff.submodule=diff: its diff program
  // is not a driver we can blank) and from writing a submodule on a switch.
  put('diff.submodule', 'short'); put('submodule.recurse', 'false');
  // a signature is checked by a PROGRAM (gpg.program, gpg.ssh.program, gpg.x509.program): a merge with verifySignatures or a log with showSignature runs the one the config names,
  // and a hosting service signs its merge commits. Verification is off, signing is off, and the programs are empty (git then cannot start a program called "", never the config's)
  put('merge.verifySignatures', 'false'); put('log.showSignature', 'false'); put('commit.gpgSign', 'false'); put('tag.gpgSign', 'false');
  for (const k of ['gpg.program', 'gpg.openpgp.program', 'gpg.ssh.program', 'gpg.x509.program', 'gpg.ssh.defaultKeyCommand']) put(k, '');
  put('core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'); // a hook (post-checkout, reference-transaction ...) is repository code too
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
  // `git status` starts a git in each checked out submodule, and that reads the SUBMODULE's own configuration (its filter drivers): submodules are never entered (S2)
  const a = args[0] === 'status' && !args.some((x) => x.startsWith('--ignore-submodules')) ? ['status', '--ignore-submodules=all', ...args.slice(1)] : args;
  return proc.run(opt.bin ?? 'git', ['-C', tree, ...a], {
    cwd: opt.cwd ?? ctx.cwd, env: hermeticEnv(opt.env ?? ctx.childEnv(), ctx.gitBlank), input: opt.input, stdio: opt.stdio ?? [opt.input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
  });
}

/**
 * The checked out submodules of TREE (a gitlink whose folder has its own `.git`): git starts its own `status` in each of them and that reads the SUBMODULE's
 * configuration, which `repoDrivers` does not see. Callers run status with `--ignore-submodules=all` and treat a populated one as something they do not inspect.
 * @param {Context} ctx @param {string} tree @returns {string[]}
 */
export function populatedGitlinks(ctx, tree) {
  return gitlinkNames((a) => hgit(ctx, tree, a).stdout, tree).map((n) => n.toString('utf8'));
}
