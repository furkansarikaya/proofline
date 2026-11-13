// @ts-check
// The extra grants of the Codex permission profile of a run in a linked worktree (A199, A203, A263). Pure: git, the real path and the file system come in through `io`, so the
// Windows rules run (and are tested with a fake file system) on any host.
//
// The grants are exactly three, whatever the platform: the main tree's `.agents/local/locks` (a worktree's lock commands write there), the worktree's own git folder, and the common
// objects folder. Nothing is added and no deny is dropped; the profile of the run itself (the `.agents` read, the run folder, locks and submissions) is built by the caller.
//
// TRUST (A263, security round 1). The worker can write the worktree's own git folder (that is one of the grants), and with it the `commondir` file that tells git where the common
// folder is, and perhaps the `.git` file of the worktree. So nothing git answers from those files is a trust anchor. The anchor is the PATH of the worktree itself: a proofline run
// worktree is `<main>/.agents/local/worktrees/<id>`, so the main tree is that path without its tail. Every grant is then checked against the main tree: git's first worktree must be the
// main tree, the worktree's git folder must be a folder under `<main>/.git/worktrees/`, and the objects folder git reports must be the very folder `<main>/.git/objects` (canonical
// paths, whole components, one snapshot of each real path). A mismatch is not repaired and not skipped: the dispatch stops (`ProfileRefused`). A worktree that is not at that place
// (a user's own worktree elsewhere) gets none of the three grants: the restrictive side.
// Off Windows the honest layout gives exactly the text the code of `codexProfileArgs` gave before. On win32 git answers `C:/Users/...` while `realpath` answers `C:\Users\RUNNER~1\...`;
// both go through `posixForm`/`inside` (ASCII case folded), only DRIVE-absolute paths are granted (UNC, rooted and device paths are not), the grants are written with forward slashes.
import { inside, isLocalAbsolute, posixForm } from './pathin.mjs';
import { asciiLower } from './shellglob.mjs';

/** A worktree whose git folder, main tree or objects folder is not where the path of the worktree says: the profile is not built. */
export class ProfileRefused extends Error {}

/**
 * @typedef {object} ProfileIo
 * @property {(args: string[]) => string} git `git -C <root> ARGS` standard output without its last line end, '' when git failed
 * @property {(p: string) => string} real the real path of P (`realpathSync`; on win32 the native form); P itself when it cannot be resolved
 * @property {(p: string) => boolean} isDir @property {(p: string) => boolean} isFile
 * @property {(p: string) => void} mkdirp
 * @property {(p: string) => string[]} readdir the names in a folder, [] when it cannot be read
 * @property {(p: string) => string} readText a small text file, '' when it cannot be read
 */

/**
 * The text after the `":workspace_roots"={...}` table: `,"<path>"="write"` per extra grant, '' when ROOT is no proofline run worktree. Throws `ProfileRefused` for a layout that is not the honest one.
 * @param {string} root the run's root (the worktree) @param {ProfileIo} io @param {string} [platform] @returns {string}
 */
export function worktreeGrants(root, io, platform = process.platform) {
  const win = platform === 'win32';
  /** The form a path is compared and written in: POSIX text off Windows (as is), `C:/x` on win32. @param {string} p */
  const form = (p) => (win ? posixForm(p, platform) : p);
  /** Is P an absolute path? Off Windows a leading `/`; on win32 only a drive path. @param {string} p */
  const absolute = (p) => (win ? isLocalAbsolute(p, platform) : p.startsWith('/'));
  /** The same place: exact text off Windows, the `samePath` rule (forward slashes, ASCII case folded) on win32. @param {string} a @param {string} b */
  const same = (a, b) => (win ? asciiLower(a).replace(/\/+$/, '') === asciiLower(b).replace(/\/+$/, '') : a === b);
  if (!io.isFile(`${root}/.git`)) return '';
  const realRoot = form(io.real(root));   // one snapshot of the root's real path
  const probe = win ? asciiLower(realRoot) : realRoot;
  const m = /^(.+)\/\.agents\/local\/worktrees\/[^/]+$/.exec(probe);
  if (m === null || !absolute(realRoot)) return '';   // not a proofline run worktree: no grant
  const main = realRoot.slice(0, m[1].length);
  const first = io.git(['worktree', 'list', '--porcelain']).split('\n')[0] ?? '';
  const listed = first.startsWith('worktree ') ? form(first.slice('worktree '.length)) : '';
  if (listed === '' || !same(form(io.real(listed)), main)) throw new ProfileRefused(`the main tree git reports for ${root} is not the one its path says (${main}); the Codex profile is not built`);
  io.mkdirp(`${main}/.agents/local/locks`);
  let abs = `,"${main}/.agents/local/locks"="write"`;
  let g = form(io.git(['rev-parse', '--git-dir']));
  /** A path git answered that is rooted or UNC on win32 (no drive) is not a relative one: the profile is not built. @param {string} p */
  const rel = (p) => {
    if (win && p.startsWith('/')) throw new ProfileRefused(`git answered a path without a drive for ${root} (${p}); the Codex profile is not built`);
    return `${form(root)}/${p}`;
  };
  if (g !== '' && !absolute(g)) g = rel(g);
  if (g !== '' && io.isDir(g)) {
    g = form(io.real(g));
    // the worktree's own git folder is a folder under <main>/.git/worktrees/, and THIS worktree's: the main tree's records say so (below)
    if (!absolute(g) || inside(`${main}/.git/worktrees`, g, platform) === null) throw new ProfileRefused(`the git folder of ${root} (${g}) is not under ${main}/.git/worktrees; the Codex profile is not built`);
    // The `.git` file of the worktree is worker-writable, so it cannot say which entry is ours (it could name another run's folder). Each entry `<main>/.git/worktrees/<name>/` keeps a `gitdir`
    // file with the path of the `.git` file of the worktree it belongs to (git wrote it, the worker cannot reach it): exactly ONE entry must name our `.git` file, and it must be the folder
    // git reported. A worker that rewrites its own entry's `gitdir` only makes itself not match.
    const ownGit = form(io.real(`${root}/.git`));   // one snapshot of the `.git` file's real path
    /** @type {string[]} */ const mine = [];
    for (const name of io.readdir(`${main}/.git/worktrees`)) {
      const first = io.readText(`${main}/.git/worktrees/${name}/gitdir`).split('\n')[0].replace(/\r$/, '');
      if (first !== '' && same(form(io.real(first)), ownGit)) mine.push(name);
    }
    if (mine.length !== 1) throw new ProfileRefused(`${mine.length} entries under ${main}/.git/worktrees name the .git file of ${root} (exactly one must); the Codex profile is not built`);
    if (!same(g, form(io.real(`${main}/.git/worktrees/${mine[0]}`)))) throw new ProfileRefused(`the git folder of ${root} (${g}) is not its entry ${mine[0]} under ${main}/.git/worktrees; the Codex profile is not built`);
    abs += `,"${g}"="write"`;
    let o = form(io.git(['rev-parse', '--git-common-dir']));
    if (!absolute(o)) o = rel(o);
    if (io.isDir(`${o}/objects`)) {
      const obj = form(io.real(`${o}/objects`));
      // the objects folder is the main tree's own: the common folder git names comes from a file the worker can write
      if (!io.isDir(`${main}/.git`) || !same(obj, form(io.real(`${main}/.git/objects`)))) throw new ProfileRefused(`the objects folder git reports for ${root} (${obj}) is not ${main}/.git/objects; the Codex profile is not built`);
      abs += `,"${obj}"="write"`;
    }
  }
  return abs;
}
