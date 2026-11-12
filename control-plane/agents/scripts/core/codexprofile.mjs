// @ts-check
// The extra grants of the Codex permission profile of a run in a linked worktree (A199, A203, A263). Pure: git, the real path and the file system come in through `io`, so the
// Windows rules run (and are tested with a fake file system) on any host.
//
// The grants are exactly three, whatever the platform: the main tree's `.agents/local/locks` (a worktree's lock commands write there), the worktree's own git folder, and the
// common objects folder. Nothing is added and no deny is dropped; the profile of the run itself (the `.agents` read, the run folder, locks and submissions) is built by the caller.
// Off Windows the function does what the code in `codexProfileArgs` did: text compared as POSIX, `git rev-parse` answers starting with `/`. On win32 git answers `C:/Users/...`
// while `realpath` answers `C:\Users\RUNNER~1\...`; both go through `posixForm`/`realpathPosix` once (one snapshot of each real path), are compared by whole components with the ASCII
// case folded (`inside`), and only a DRIVE-absolute path is ever granted (a UNC path, a rooted `\x`, a device path is not: the grant is then left out, which is the restrictive side).
// The grants are written with forward slashes; the caller still refuses a profile that holds a backslash.
import { inside, isLocalAbsolute, posixForm } from './pathin.mjs';

/**
 * @typedef {object} ProfileIo
 * @property {(args: string[]) => string} git `git -C <root> ARGS` standard output without its last line end, '' when git failed
 * @property {(p: string) => string} real the real path of P (`realpathSync`; on win32 the native form); P itself when it cannot be resolved
 * @property {(p: string) => boolean} isDir @property {(p: string) => boolean} isFile
 * @property {(p: string) => void} mkdirp
 */

/**
 * The text after the `":workspace_roots"={...}` table: `,"<path>"="write"` per extra grant, '' when ROOT is not a linked worktree of proofline.
 * @param {string} root the run's root (the worktree) @param {ProfileIo} io @param {string} [platform] @returns {string}
 */
export function worktreeGrants(root, io, platform = process.platform) {
  const win = platform === 'win32';
  /** The form a path is compared and written in: POSIX text off Windows (as is), `C:/x` on win32. @param {string} p */
  const form = (p) => (win ? posixForm(p, platform) : p);
  /** Is P an absolute path git or the file system gave back? Off Windows a leading `/`; on win32 only a drive path. @param {string} p */
  const absolute = (p) => (win ? isLocalAbsolute(p, platform) : p.startsWith('/'));
  /** Off Windows no further test (the old code had none); on win32 the path must be drive-absolute. @param {string} p */
  const grantable = (p) => !win || isLocalAbsolute(p, platform);
  let abs = '';
  if (!io.isFile(`${root}/.git`)) return abs;
  const first = io.git(['worktree', 'list', '--porcelain']).split('\n')[0] ?? '';
  const main = first.startsWith('worktree ') ? form(first.slice('worktree '.length)) : '';
  const realRoot = form(io.real(root));   // one snapshot of the root's real path
  const underMain = win
    ? main !== '' && absolute(main) && absolute(realRoot) && inside(`${main}/.agents/local/worktrees`, realRoot, platform) !== null
    : main !== '' && realRoot.startsWith(`${main}/.agents/local/worktrees/`);
  if (underMain) {
    io.mkdirp(`${main}/.agents/local/locks`);
    abs += `,"${main}/.agents/local/locks"="write"`;
  }
  let g = form(io.git(['rev-parse', '--git-dir']));
  if (g !== '' && !absolute(g)) g = `${form(root)}/${g}`;
  if (g !== '' && grantable(g) && io.isDir(g)) {
    g = form(io.real(g));
    if (grantable(g) && /\/worktrees\//.test(g)) {
      abs += `,"${g}"="write"`;
      let o = form(io.git(['rev-parse', '--git-common-dir']));
      if (!absolute(o)) o = `${form(root)}/${o}`;
      if (grantable(o) && io.isDir(`${o}/objects`)) {
        const obj = form(io.real(`${o}/objects`));
        if (grantable(obj)) abs += `,"${obj}"="write"`;
      }
    }
  }
  return abs;
}
