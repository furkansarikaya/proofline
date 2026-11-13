// @ts-check
// ONE hermetic git for every call on a checkout (A248, Part of #165; hardens A238/A218). A filter driver (`filter.<n>.clean|smudge|process`) or an `includeIf` that a
// repository config defines is code git runs on every file it reads or writes. deliver-merged looks for such drivers, and every git call on a checkout it
// touches (the main tree, the run's worktree) carries the blanking: the file system monitor off and each driver's three commands set empty, through the
// ENVIRONMENT (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n, GIT_CONFIG_VALUE_n), where a name is a key and not a `-c name=value` text that an `=` in the name would cut.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { hooksOff } from './hooksoff.mjs';
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
 * A folder is visited once, by its real path (a gitlink that is a symlink to `.` or to a parent would otherwise multiply the visits exponentially), at most `MAX_TREES` folders in
 * all and 8 levels deep; when a bound is hit `includes` is set (the caller then treats the checkout like one with a driver: it fails closed) and `capped` is true. The folder a
 * `gitdir:` file or a symlink points to IS followed (git reads it too); only these bounds stop the search.
 * @param {number} [max] the folder bound (tests lower it) @param {boolean} [subs] also search the populated submodules (default true; false reads the trees' own configuration only)
 * @returns {{ names: string[], includes: boolean, submodules: string[], capped: boolean }}
 */
export function repoDrivers(gitBin, trees, where, max = MAX_TREES, subs = true) {
  /** @type {Set<string>} */ const names = new Set();
  /** @type {Set<string>} */ const seen = new Set();
  /** @type {string[]} */ const submodules = [];
  let includes = false;
  let capped = false;
  /** @param {string} tree @param {number} depth */
  const visit = (tree, depth) => {
    let real = tree;
    try { real = realpathSync(tree); } catch { /* not there: searched under its own name */ }
    if (seen.has(real)) return;
    if (depth > 8 || seen.size >= max) { capped = true; includes = true; return; }
    seen.add(real);
    const w = where(tree);
    const q = (/** @type {string[]} */ a) => proc.run(gitBin, ['-C', tree, '-c', 'core.fsmonitor=false', ...a], { cwd: w.cwd, env: w.env, stdio: ['ignore', 'pipe', 'ignore'] });
    const d = parseDrivers(q(['config', '--show-scope', '--name-only', '-z', '--get-regexp', DRIVER_KEYS]).stdout.toString('latin1'));
    for (const n of d.names) names.add(n);
    if (d.includes) includes = true;
    if (subs) for (const rel of gitlinkNames((a) => q(a).stdout, tree)) {
      const sub = Buffer.concat([Buffer.from(`${tree}/`), rel]).toString('utf8');
      submodules.push(sub);
      visit(sub, depth + 1);
    }
  };
  for (const tree of trees) visit(tree, 0);
  return { names: [...names], includes, submodules, capped };
}

/** The most folders (trees and submodules) one search visits. */
export const MAX_TREES = 256;

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
 * @param {Record<string, string | undefined>} base @param {string[]} names @param {string} [hooks] the `core.hooksPath` value that turns hooks off (hooksoff.mjs: `/dev/null`, on Windows a core-owned empty folder) @returns {Record<string, string>}
 */
export function hermeticEnv(base, names, hooks = '/dev/null') {
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
  put('core.hooksPath', hooks); // a hook (post-checkout, reference-transaction ...) is repository code too
  // auto-maintenance runs after a merge, a commit or a fetch (`maintenance run --auto`, `gc --auto`) and `gc.recentObjectsHook` is a program the repack runs
  put('gc.auto', '0'); put('maintenance.auto', 'false'); put('receive.autogc', 'false'); put('gc.recentObjectsHook', '');
  // an EMPTY command does not disable a driver that is `required` (git-lfs sets it): git then fails the whole call. `required=false` makes the blanked driver a no-op
  for (const name of names) { for (const v of ['clean', 'smudge', 'process']) put(`filter.${name}.${v}`, ''); put(`filter.${name}.required`, 'false'); }
  out['GIT_CONFIG_COUNT'] = String(n);
  return out;
}

/**
 * The git directory of TREE and the common one (a linked worktree keeps `commondir`), or null when `.git` is not understood. @param {string} tree @returns {{ gitDir: string, common: string } | null}
 */
function gitDirs(tree) {
  try {
    let gitDir = `${tree}/.git`;
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir: (.*)\r?\n?$/.exec(readFileSync(gitDir, 'utf8'));
      if (m === null) return null;
      gitDir = path.resolve(tree, m[1]);
    }
    let common = gitDir;
    try { common = path.resolve(gitDir, readFileSync(`${gitDir}/commondir`, 'utf8').trim()); } catch { /* an ordinary git directory has no commondir */ }
    return { gitDir, common };
  } catch { return null; }
}

/**
 * Does the index of TREE hold a gitlink (mode 160000)? Answered by reading the index file itself (versions 2 and 3, no split or sparse index, SHA-1 or SHA-256 object ids), so a repository WITHOUT
 * submodules costs no process. The trailing checksum must verify (SHA-1 over everything but the last 20 bytes, else SHA-256 over everything but the last 32): that tells the object id
 * width, and a file that is cut, rewritten halfway or not understood (version 4, an extension that does not fit, `index.skipHash`) answers `null`, NEVER `false` (the caller then asks git).
 * @param {string} tree @returns {boolean | null}
 */
export function indexHasGitlinks(tree) {
  try {
    const d = gitDirs(tree);
    if (d === null) return null;
    const b = readFileSync(`${d.gitDir}/index`);
    if (b.length < 32 || b.toString('latin1', 0, 4) !== 'DIRC') return null;
    const version = b.readUInt32BE(4);
    if (version !== 2 && version !== 3) return null;
    // the width of an object id, from the checksum that closes the file
    let hl = 0;
    for (const [alg, w] of /** @type {const} */ ([['sha1', 20], ['sha256', 32]])) {
      if (b.length >= 12 + w && createHash(alg).update(b.subarray(0, b.length - w)).digest().equals(b.subarray(b.length - w))) { hl = w; break; }
    }
    if (hl === 0) return null;
    const end = b.length - hl;
    const n = b.readUInt32BE(8);
    let p = 12;
    for (let i = 0; i < n; i++) {
      if (p + 42 + hl > end) return null;
      if ((b.readUInt32BE(p + 24) >>> 12) === 0xe) return true;
      const flags = b.readUInt16BE(p + 40 + hl);
      let fixed = 42 + hl;
      if (flags & 0x4000) { if (version < 3) return null; fixed += 2; }
      const nul = b.indexOf(0, p + fixed);
      if (nul < 0 || nul >= end) return null;
      p += Math.ceil((nul + 1 - p) / 8) * 8; // the entry is padded with NULs to a multiple of 8 bytes (at least one)
    }
    // extensions (4 byte name, 4 byte size, data): a split index (`link`) keeps entries in another file; one that does not fit is not understood
    while (p < end) {
      if (p + 8 > end) return null;
      const ext = b.toString('latin1', p, p + 4);
      if (ext === 'link' || ext === 'sdir') return null; // a split index keeps entries in another file, a sparse index folds whole directories (a gitlink may be inside one)
      p += 8 + b.readUInt32BE(p + 4);
      if (p > end) return null;
    }
    return false;
  } catch { return null; }
}

/**
 * May the repository configuration of TREE hold a filter driver or an include (local or worktree scope), or does the call carry configuration in its environment? Answered by reading
 * the two files (`config`, `config.worktree`), no process: a text without a `[filter` or `[include` section has neither. Anything not understood answers true (the caller asks git).
 * @param {string} tree @param {Record<string, string>} env @returns {boolean}
 */
function ownConfigMayHaveDrivers(tree, env) {
  for (const k of Object.keys(env)) if (/^GIT_(CONFIG_(COUNT|PARAMETERS|KEY_|VALUE_)|DIR$|COMMON_DIR$|WORK_TREE$|CONFIG$)/.test(k)) return true;
  const d = gitDirs(tree);
  if (d === null || existsSync(`${d.gitDir}/config.worktree`)) return true;
  try { return /\[\s*(filter|include)/i.test(readFileSync(`${d.common}/config`, 'latin1')); } catch { return true; }
}

/** A signature of the files that decide the drivers (the index, the config, HEAD, config.worktree): the cache of `blankNames` is keyed by it, so a git call that changes any of them (a switch that brings a gitlink) is seen. @param {string} tree */
function stateSig(tree) {
  const d = gitDirs(tree);
  if (d === null) return 'none';
  const f = (/** @type {string} */ x) => { try { const t = statSync(x); return `${t.size}.${t.mtimeMs}.${t.ino}`; } catch { return '-'; } };
  return [f(`${d.gitDir}/index`), f(`${d.common}/config`), f(`${d.gitDir}/HEAD`), f(`${d.gitDir}/config.worktree`)].join('|');
}

/** The names found for a context that has no `once` (a stand-in in a test), per context and tree. @type {WeakMap<object, Map<string, string[]>>} */
const lazyFallback = new WeakMap();

/**
 * The driver names to blank for a git call on TREE: `ctx.gitBlank` (what deliver-merged found in both its trees) plus the repository drivers of TREE ITSELF (always, round 5) and of all its populated
 * submodules (when its index holds a gitlink), found HERE, lazily, once per context, tree and STATE of the tree (`ctx.once` keyed by the stat signature of the index, the config, HEAD and config.worktree, so a git call that brings a gitlink or a driver is seen by the next one; `ctx.forget('')` or `ctx.forget('git:blank')` drop it too). So no call of `git()` or `hgit()` can start a child in a submodule before its drivers are blanked, whichever command made it (A248 round 3/4).
 * The search reads configuration and the index only through its own raw `git config` and `ls-files --stage` (never through `git()` or `hgit()`: no recursion, no status, no filter).
 * @param {Context} ctx @param {string} tree @param {string} bin @param {Record<string, string | undefined>} env the environment of the call, for the search too
 * @returns {string[]}
 */
export function blankNames(ctx, tree, bin, env) {
  /** @type {Record<string, string>} */ const e = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== 'GIT_INDEX_FILE') e[k] = v;
  const make = () => {
    const gl = indexHasGitlinks(tree);
    // the tree's OWN drivers are always searched (round 5): a local `filter.<n>.clean` runs on every file git reads whether or not a submodule exists. A text read of the two config files
    // says when there is nothing to find, so a repository without drivers, includes and gitlinks still starts no process
    if (gl === false && !ownConfigMayHaveDrivers(tree, e)) return [];
    /** @type {string[]} */ let trees = [tree];
    // an `includeIf onbranch:` include is judged by the branch of the tree git runs in: the main tree and the run's worktree can see different drivers
    if (ownConfigMayHaveDrivers(tree, e) && tree === ctx.root && typeof ctx.sharedMain === 'function') trees = [...new Set([tree, ctx.sharedMain()])];
    return repoDrivers(bin, trees, () => ({ cwd: ctx.cwd, env: e }), MAX_TREES, gl !== false).names;
  };
  const key = `git:blank:${tree}:${stateSig(tree)}`;
  /** @type {string[]} */ let lazy;
  if (typeof ctx.once === 'function') lazy = ctx.once(key, make);
  else {
    let m = lazyFallback.get(ctx);
    if (m === undefined) { m = new Map(); lazyFallback.set(ctx, m); }
    let v = m.get(key);
    if (v === undefined) { v = make(); m.set(key, v); }
    lazy = v;
  }
  const base = ctx.gitBlank ?? [];
  return lazy.length === 0 ? base : [...new Set([...base, ...lazy])];
}

/**
 * One git call on TREE with the blanking of `ctx.gitBlank` plus what `blankNames` finds in TREE and its submodules, and the file system monitor off.
 * @param {Context} ctx @param {string} tree @param {string[]} args
 * @param {{ bin?: string, env?: Record<string, string | undefined>, cwd?: string, input?: string | Buffer, stdio?: Array<'pipe' | 'ignore' | 'inherit'> }} [opt]
 */
export function hgit(ctx, tree, args, opt = {}) {
  // `git status` starts a git in each checked out submodule, and that reads the SUBMODULE's own configuration (its filter drivers): submodules are never entered (S2)
  const a = args[0] === 'status' && !args.some((x) => x.startsWith('--ignore-submodules')) ? ['status', '--ignore-submodules=all', ...args.slice(1)] : args;
  const bin = opt.bin ?? 'git';
  const env = opt.env ?? ctx.childEnv();
  return proc.run(bin, ['-C', tree, ...a], {
    cwd: opt.cwd ?? ctx.cwd, env: hermeticEnv(env, blankNames(ctx, tree, bin, env), hooksOff(ctx)), input: opt.input, stdio: opt.stdio ?? [opt.input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
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
