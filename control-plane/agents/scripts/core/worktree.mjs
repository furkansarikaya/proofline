// @ts-check
// One worktree per run (A169, A185, A225): `worktree-add`, `worktree-path`, `worktree-remove` and the preparation of a run worktree (the former
// worktree-prep.sh). The preparation knows no ecosystem: what to prepare is data (worktree_deps.folders and prune of ecosystems.json, the config
// worktree.copy_files).
//   1 Dependency folders: each git-ignored folder a package manager fills (node_modules) that exists in the main tree is COPIED into the worktree
//     (a copy-on-write clone where the file system has one), so a task that changes dependencies changes only its own worktree. A link into the main
//     tree is never made; a link inside a copy that resolves into the main tree is re-pointed at the same path of the worktree. A folder that git
//     tracks, or does not ignore, is left alone.
//   2 Local files: the untracked files named by worktree.copy_files (default .env*) are copied only when git IGNORES them in the main tree and in the
//     worktree; every copied path is listed in <worktree>/.agents/local/worktree-copied, which the pre-commit hook reads and refuses to let into a commit.
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, appendFileSync, chmodSync, constants } from 'node:fs';
import path from 'node:path';
import { bytes } from './config.mjs';
import { ecosystemRowsAt } from './ecodata.mjs';
import { fail } from './errors.mjs';
import { wtLinked } from './commands/runcmds.mjs';
import { isDir, isFile } from './paths.mjs';
import * as proc from './proc.mjs';
import { hgit } from './hgit.mjs';
import { archiveRun } from './runend.mjs';
import { pathMatches } from './scope.mjs';
import { requireLead } from './approve.mjs';
import { textLines } from './records.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** `rw_valid_id`: a task id that names a worktree folder. @param {string} id */
export const rwValid = (id) => /^[A-Za-z0-9_-]+$/.test(id) && !/^[^A-Za-z0-9]/.test(id) && !id.includes('..');
/** The shared folders that live in the main tree and are never linked into a worktree (A185). */
const SHARED = ['batch', 'approvals', 'metrics', 'friction', 'prompts'];

/** `cd DIR && pwd -P`, or null. @param {string} d */
function physical(d) { try { return realpathSync(d); } catch { return null; } }
/** `rw_main`: the main working tree's folder. @param {Context} ctx */
export const rwMain = (ctx) => physical(ctx.root) ?? ctx.root;
/** `rw_dir ID` @param {Context} ctx @param {string} id */
export const rwDir = (ctx, id) => `${rwMain(ctx)}/.agents/local/worktrees/${id}`;
/** `rw_registered DIR`: git lists the folder as a worktree. @param {Context} ctx @param {string} dir */
export function rwRegistered(ctx, dir) {
  const r = proc.run('git', ['-C', ctx.root, 'worktree', 'list', '--porcelain'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  return r.stdout.toString('utf8').split('\n').some((l) => l === `worktree ${dir}`);
}
/** @param {Context} ctx @param {string[]} args @param {string} [cwd] */
function git(ctx, args, cwd = ctx.root) {
  return proc.run('git', ['-C', cwd, ...args], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
}

// ---- the preparation (worktree-prep.sh) --------------------------------------------------------------------------------------------------------

/** a folder name from data: relative, plain segments, never the git or control-plane folders @param {string} f */
function plainRel(f) {
  return !(f === '' || f.startsWith('/') || f.includes('..') || f.includes('//') || f === '.git' || f.startsWith('.git/') || f === '.agents' || f.startsWith('.agents/') || /[^A-Za-z0-9._/-]/.test(f));
}

/**
 * The flat ecosystem definition of the project (ecosystems.json; the control plane's own when the project has none): rows `<id> TAB <path> TAB <value>`.
 * @param {Context} ctx @param {string} main @returns {string[][] | null}
 */
function ecoRows(ctx, main) { return ecosystemRowsAt(`${main}/.agents`, path.join(ctx.trustedScripts, '..')); }

/** A copy of SRC at DST: copy-on-write where the file system has one, a plain copy otherwise; symbolic links stay links. @param {string} src @param {string} dst */
function cloneTree(src, dst) {
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true, dereference: false, errorOnExist: false, force: true });
}

/** `find DIR -type l` (links are not followed). @param {string} dir @returns {string[]} */
function findLinks(dir) {
  /** @type {string[]} */ const out = [];
  /** @param {string} d */
  const walk = (d) => {
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = `${d}/${e.name}`;
      if (e.isSymbolicLink()) out.push(p);
      else if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

/** A path with `.` and `..` segments folded textually (a `..` above the root stays at the root). @param {string} a */
function fold(a) {
  /** @type {string[]} */ const st = [];
  for (const s of a.split('/')) { if (s === '' || s === '.') continue; if (s === '..') { st.pop(); continue; } st.push(s); }
  return `/${st.join('/')}`;
}

/**
 * Step 1 of the preparation. A link inside the copy that resolves into the main tree (absolute, or relative and leaving the folder) is re-pointed at the
 * same path of the worktree, so nothing written through it reaches the main tree.
 * @param {Context} ctx @param {string} main @param {string} wt @param {string[][] | null} eco @returns {number} 0 or 1 (a copy failed)
 */
function prepDeps(ctx, main, wt, eco) {
  let rc = 0;
  if (eco === null) return rc;
  /** @type {string[]} */ const folders = [];
  for (const r of eco) if (r[0] !== '*' && r[1] === 'worktree_deps.folders' && r[2] !== undefined && !folders.includes(r[2])) folders.push(r[2]);
  for (const f of folders) {
    if (!plainRel(f)) { ctx.err(`worktree-prep: ignoring worktree_deps folder '${bytes(f)}' (not a plain relative name)\n`); continue; }
    let st;
    try { st = lstatSync(`${main}/${f}`); } catch { continue; }
    if (!st.isDirectory()) continue; // not a folder, or a link: `-d && ! -L`
    if (git(ctx, ['ls-files', '--error-unmatch', '--', f], main).status === 0) continue; // tracked: the checkout has it
    if (git(ctx, ['check-ignore', '-q', '--', `${f}/`], main).status !== 0 && git(ctx, ['check-ignore', '-q', '--', f], main).status !== 0) continue;
    try { if (lstatSync(`${wt}/${f}`).isSymbolicLink()) unlinkSync(`${wt}/${f}`); } catch { /* none */ } // a link of an earlier version: never kept
    if (existsSync(`${wt}/${f}`)) continue;
    try {
      cloneTree(`${main}/${f}`, `${wt}/${f}`);
    } catch {
      rmSync(`${wt}/${f}`, { recursive: true, force: true });
      ctx.err(`worktree-prep: could not copy ${bytes(f)} into the worktree\n`);
      rc = 1;
      continue;
    }
    for (const l of findLinks(`${wt}/${f}`)) {
      let t;
      try { t = readlinkSync(l); } catch { continue; }
      let a;
      if (t.startsWith('/')) a = t;
      else { const pd = physical(path.dirname(l)); a = `${pd ?? ''}/${t}`; }
      a = fold(a);
      if (a.startsWith(`${wt}/`)) continue;
      if (a.startsWith(`${main}/`)) {
        try { unlinkSync(l); symlinkSync(`${wt}/${a.slice(main.length + 1)}`, l); } catch { /* best effort, as ln -sfn */ }
      }
    }
  }
  return rc;
}

/** The candidates of step 2: the files of the main tree (depth at most 8, no pruned name, no link), as `find . -maxdepth 8 ... -type f` lists them. @param {string} main @param {Set<string>} prune */
function candidates(main, prune) {
  /** @type {string[]} */ const out = [];
  /** @param {string} d @param {string} rel @param {number} depth */
  const walk = (d, rel, depth) => {
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (prune.has(e.name)) continue;
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) { if (depth < 8) walk(`${d}/${e.name}`, r, depth + 1); } else if (e.isFile()) out.push(r);
    }
  };
  walk(main, '', 1);
  return out.sort();
}

/**
 * Step 2 of the preparation: the local files. @param {Context} ctx @param {string} main @param {string} wt @param {string} globs @param {string[][] | null} eco
 * @returns {number} 0 or 1 (a copy failed)
 */
function prepFiles(ctx, main, wt, globs, eco) {
  let rc = 0;
  if (globs === '' || globs === 'none') return rc;
  const prune = new Set(eco === null ? ['.git', '.agents'] : eco.filter((r) => r[0] === '*' && r[1] === 'prune').map((r) => r[2] ?? ''));
  const cands = candidates(main, prune).filter((p) => pathMatches(bytes(p), globs));
  const manifest = `${wt}/.agents/local/worktree-copied`;
  for (const p of cands) {
    if (existsSync(`${wt}/${p}`)) continue;
    if (git(ctx, ['ls-files', '--error-unmatch', '--', p], main).status === 0) continue; // tracked: the checkout has it
    if (git(ctx, ['check-ignore', '-q', '--', p], main).status !== 0) {
      ctx.err(`worktree-prep: ${bytes(p)} is not copied: git does not ignore it in the main tree (add it to .gitignore first; a copy could be committed)\n`);
      continue;
    }
    try {
      mkdirSync(path.dirname(`${wt}/${p}`), { recursive: true });
      const st = statSync(`${main}/${p}`);
      copyFileSync(`${main}/${p}`, `${wt}/${p}`);
      chmodSync(`${wt}/${p}`, st.mode & 0o7777);
      utimesSync(`${wt}/${p}`, st.atime, st.mtime);
    } catch {
      ctx.err(`worktree-prep: could not copy ${bytes(p)}\n`);
      rc = 1;
      continue;
    }
    if (git(ctx, ['check-ignore', '-q', '--', p], wt).status !== 0) {
      rmSync(`${wt}/${p}`, { force: true });
      ctx.err(`worktree-prep: ${bytes(p)} is not copied: git does not ignore it in the worktree\n`);
      continue;
    }
    mkdirSync(path.dirname(manifest), { recursive: true });
    appendFileSync(manifest, `${p}\n`);
  }
  if (isFile(manifest)) {
    const rows = [...new Set(textLines(readFileSync(manifest, 'utf8')))].sort((a, b) => (Buffer.from(a).compare(Buffer.from(b))));
    writeFileSync(`${manifest}.t`, `${rows.join('\n')}\n`);
    renameSync(`${manifest}.t`, manifest);
  }
  return rc;
}

/**
 * The preparation of a run worktree: dependency folders and local files. `depsOnly` is step 1 alone, into any folder (the throwaway export of the build record, core/buildrecord.mjs).
 * @param {Context} ctx @param {string} main @param {string} wt @param {string} globs @param {boolean} [depsOnly] @returns {number} 0, 1 (a copy failed), 2 (usage)
 */
export function prepareWorktree(ctx, main, wt, globs, depsOnly = false) {
  if (!isDir(main) || !isDir(wt)) { ctx.err('usage: worktree-prep.sh [--deps] <MAIN-ROOT> <WORKTREE> [COPY-GLOBS]\n'); return 2; }
  const m = physical(main) ?? main; const w = physical(wt) ?? wt;
  const eco = ecoRows(ctx, m);
  let rc = prepDeps(ctx, m, w, eco);
  if (depsOnly) return rc;
  rc = Math.max(rc, prepFiles(ctx, m, w, globs, eco));
  return rc;
}

/** `rw_prepare WORKTREE`: the shared folders exist, the runtime config git does not track, the carried commands, dependency folders and local env files. @param {Context} ctx @param {string} wt */
function rwPrepare(ctx, wt) {
  const m = rwMain(ctx);
  mkdirSync(`${wt}/.agents/local`, { recursive: true });
  for (const s of SHARED) mkdirSync(`${m}/.agents/local/${s}`, { recursive: true });
  // runtime hooks and settings that are ignored or untracked are not in a checkout; without them the session would run unconfined
  for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json', '.codex/config.toml']) {
    if (isFile(`${m}/${f}`) && !existsSync(`${wt}/${f}`)) { mkdirSync(path.dirname(`${wt}/${f}`), { recursive: true }); copyFileSync(`${m}/${f}`, `${wt}/${f}`); }
  }
  // A200: commands.build|test|lint written into the main tree (doctor --apply-commands, after the user's yes) are an uncommitted change a worktree made from the
  // committed branch does not have; carried over only when the commands block is the ONLY difference between the two configs
  const mc = `${m}/.agents/config.yaml`; const wc = `${wt}/.agents/config.yaml`;
  if (isFile(mc) && isFile(wc)) {
    const a = readFileSync(mc); const b = readFileSync(wc);
    if (!a.equals(b)) {
      const strip = (/** @type {Buffer} */ buf) => { let k = false; return buf.toString('latin1').split('\n').filter((l) => { if (l.startsWith('commands:')) { k = true; return false; } if (k && /^[^ #]/.test(l)) k = false; return !k; }).join('\n'); };
      if (strip(a) === strip(b)) copyFileSync(mc, wc);
    }
  }
  // dependency folders (data: worktree_deps in ecosystems.json) become the worktree's own copies, never links into the main tree, and the untracked local files of
  // worktree.copy_files (default .env*) are copied in
  const rc = prepareWorktree(ctx, m, wt, ctx.config().get('worktree.copy_files', '.env*'));
  if (rc !== 0) ctx.err('warning: worktree preparation reported a problem (the worktree is usable; dependencies or env files may be missing)\n');
}

// ---- the commands ---------------------------------------------------------------------------------------------------------------------------

/** `worktree-add ID`: a detached worktree at the canonical branch's local tip, prepared; prints its folder. An existing one is reused. @param {Context} ctx @param {string[]} args */
export function worktreeAdd(ctx, args) {
  requireLead(ctx);
  const id = args[0] ?? '';
  if (!rwValid(id)) fail('usage: agent.sh worktree-add <TASK-ID>');
  if (wtLinked(ctx)) {
    const first = git(ctx, ['worktree', 'list', '--porcelain']).stdout.toString('latin1').split('\n')[0] ?? '';
    fail(`worktree-add runs in the main working tree (${first.startsWith('worktree ') ? first.slice(9) : ''}), not inside a task worktree`);
  }
  const d = rwDir(ctx, id);
  if (rwRegistered(ctx, d) && isDir(d)) { rwPrepare(ctx, d); ctx.out(`${bytes(d)}\n`); return 0; }
  if (existsSync(d)) fail(`${bytes(d)} exists but is not a registered worktree; remove that folder, then run worktree-add again`);
  const branch = ctx.config().get('canonical_branch', '');
  if (branch === '') fail('canonical_branch not configured');
  const sha = git(ctx, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`]);
  if (sha.status !== 0) fail(`canonical branch not found locally: ${branch}`);
  mkdirSync(path.dirname(d), { recursive: true });
  // A248 round 6: `worktree add` checks out through a child git whose GIT_DIR is the NEW worktree's, where a `gitdir:` conditioned include can apply that the main tree does not
  // see. So the worktree is made WITHOUT a checkout, its drivers are found in the new worktree itself (hgit does it for the tree of the call), and the checkout runs through hgit there
  const add = hgit(ctx, ctx.root, ['worktree', 'add', '-q', '--no-checkout', '--detach', d, sha.stdout.toString('latin1').replace(/\n+$/, '')], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (add.stderr.length > 0) ctx.err(add.stderr.toString('latin1'));
  if (add.status !== 0) fail(`could not add the worktree ${bytes(d)}`);
  const co = hgit(ctx, d, ['reset', '--hard', '-q', '--no-recurse-submodules'], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (co.status !== 0) { ctx.err(co.stderr.toString('latin1')); hgit(ctx, ctx.root, ['worktree', 'remove', '--force', d]); fail(`could not check out the worktree ${bytes(d)}`); }
  rwPrepare(ctx, d);
  ctx.out(`${bytes(d)}\n`);
  return 0;
}

/** `worktree-path ID`: the folder of a registered run worktree (exit 1 when there is none). @param {Context} ctx @param {string[]} args */
export function worktreePath(ctx, args) {
  requireLead(ctx);
  const id = args[0] ?? '';
  if (!rwValid(id)) fail('usage: agent.sh worktree-path <TASK-ID>');
  const d = rwDir(ctx, id);
  if (!(rwRegistered(ctx, d) && isDir(d))) return 1;
  ctx.out(`${bytes(d)}\n`);
  return 0;
}

/**
 * `worktree-remove ID [--force]`: only a worktree under .agents/local/worktrees; refused while it still holds a run (its evidence), unless forced. The records are
 * archived before the worktree goes (A200).
 * @param {Context} ctx @param {string[]} args
 */
export function worktreeRemove(ctx, args) {
  requireLead(ctx);
  const id = args[0] ?? '';
  const usage = 'usage: agent.sh worktree-remove <TASK-ID> [--force]';
  if (!rwValid(id)) fail(usage);
  if (wtLinked(ctx)) fail('worktree-remove runs in the main working tree, not inside a task worktree');
  const opt = args[1] ?? '';
  if (opt !== '' && opt !== '--force') fail(usage);
  const force = opt === '--force';
  const d = rwDir(ctx, id);
  if (!rwRegistered(ctx, d)) { git(ctx, ['worktree', 'prune']); ctx.out(`no worktree for ${id}\n`); return 0; }
  const runsDir = `${d}/.agents/runs`;
  /** @type {string[]} */ let runs = [];
  try { runs = readdirSync(runsDir).filter((n) => !n.startsWith('.') && isDir(`${runsDir}/${n}`)).sort(); } catch { runs = []; }
  if (runs.length > 0 && !force) fail(`the worktree of ${id} still holds the run: ${runs.join(' ')} (its evidence goes with it). Finish or clean up the run first, or: agent.sh worktree-remove ${id} --force`);
  for (const r of runs) archiveRun(ctx, r, `${runsDir}/${r}`);
  const rm = hgit(ctx, ctx.root, ['worktree', 'remove', '--force', d], { stdio: ['ignore', 'ignore', 'ignore'] });
  if (rm.status !== 0) fail(`could not remove the worktree ${bytes(d)}`);
  git(ctx, ['worktree', 'prune']);
  try { rmdirSync(path.dirname(d)); } catch { /* not empty */ }
  ctx.out(`worktree removed: ${id}\n`);
  return 0;
}

/** The handlers of the worktree commands. @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const WORKTREE_HANDLERS = {
  'worktree-add': worktreeAdd,
  'worktree-path': worktreePath,
  'worktree-remove': worktreeRemove,
};
