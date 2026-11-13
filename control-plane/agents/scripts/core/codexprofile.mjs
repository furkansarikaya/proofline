// @ts-check
// The extra grants of the Codex permission profile of a run in a linked worktree (A199, A203, A263). Pure: git, the real path and the file system come in through `io`, so the
// Windows rules run (and are tested with a fake file system) on any host.
//
// The grants are exactly three, whatever the platform: the main tree's `.agents/local/locks` (a worktree's lock commands write there), the worktree's own git folder, and the common
// objects folder. Nothing is added and no deny is dropped; the profile of the run itself (the `.agents` read, the run folder, locks and submissions) is built by the caller.
//
// TRUST (A263, security rounds 1 to 3). The worker can write the worktree's own git folder (one of the grants) and its `.git` file, so NOTHING read from those places decides a grant:
// not the `.git` file, not `commondir`, not the entry's `gitdir` file, not what `git rev-parse` derives from them. The anchors are (1) the PATH of the worktree itself: a proofline run
// worktree is `<main>/.agents/local/worktrees/<id>`, so the main tree is that path without its tail; (2) a RECORD the core wrote when it created the worktree (`worktree-add`, before any
// worker ran): `<main>/.agents/local/wt-entries/<id>.entry` holds the real path of the worktree's git folder, `<main>/.git/worktrees/<name>`. The record sits outside the worktree and
// outside every granted folder, so the Codex profile (its writes are the run's workspace, the run folder, locks, submissions and these three grants) does not let a worker write it, and
// the hook guard refuses a write to `.agents/local/` from a Claude worker. The git folder is granted only when the record exists as a regular file, the `.git` file of the worktree is a
// regular file (not a link) whose `gitdir:` line names exactly the recorded folder, that folder lies strictly under `<main>/.git/worktrees/` and is itself no link, and the objects folder is
// the very folder `<main>/.git/objects`. Any mismatch, or no record (a worktree made before A263 or by hand), is not repaired and not skipped: the dispatch stops (`ProfileRefused`). A
// worktree that is not at that place (a user's own worktree elsewhere) gets none of the three grants: the restrictive side.
// Off Windows the honest layout gives exactly the text the code of `codexProfileArgs` gave before. On win32 git answers `C:/Users/...` while `realpath` answers `C:\Users\RUNNER~1\...`;
// both go through `posixForm`/`inside` (ASCII case folded), only DRIVE-absolute paths are granted (UNC, rooted and device paths are not), the grants are written with forward slashes.
import { inside, isLocalAbsolute, posixForm } from './pathin.mjs';
import { asciiLower } from './shellglob.mjs';

/** A worktree whose git folder, main tree or objects folder is not where the path of the worktree and the core's record say: the profile is not built. */
export class ProfileRefused extends Error {}

/** Where the core keeps the record of a run worktree's git folder: outside the worktree and outside every granted folder. @param {string} main the main tree @param {string} id the run id */
export const entryRecordPath = (main, id) => `${main}/.agents/local/wt-entries/${id}.entry`;

/**
 * @typedef {object} ProfileIo
 * @property {(args: string[]) => string} git `git -C <root> ARGS` standard output without its last line end, '' when git failed
 * @property {(p: string) => string} real the real path of P (`realpathSync`; on win32 the native form); P itself when it cannot be resolved
 * @property {(p: string) => boolean} isDir @property {(p: string) => boolean} isFile (both follow links)
 * @property {(p: string) => boolean} isPlainFile P is a regular file and itself no link (`lstat`)
 * @property {(p: string) => void} mkdirp
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
  /** The first line of a small file, without its line end. @param {string} p */
  const firstLine = (p) => io.readText(p).split('\n')[0].replace(/\r$/, '');
  if (!io.isFile(`${root}/.git`)) return '';
  const realRoot = form(io.real(root));   // one snapshot of the root's real path
  const probe = win ? asciiLower(realRoot) : realRoot;
  const m = /^(.+)\/\.agents\/local\/worktrees\/[^/]+$/.exec(probe);
  if (m === null || !absolute(realRoot)) return '';   // not a proofline run worktree: no grant
  const main = realRoot.slice(0, m[1].length);
  const id = realRoot.slice(realRoot.lastIndexOf('/') + 1);
  const first = io.git(['worktree', 'list', '--porcelain']).split('\n')[0] ?? '';
  const listed = first.startsWith('worktree ') ? form(first.slice('worktree '.length)) : '';
  if (listed === '' || !same(form(io.real(listed)), main)) throw new ProfileRefused(`the main tree git reports for ${root} is not the one its path says (${main}); the Codex profile is not built`);
  // the `.git` file is the worker's: it must be the regular file git wrote, never a link to another worktree's `.git` file (round 3)
  if (!io.isPlainFile(`${root}/.git`)) throw new ProfileRefused(`${root}/.git is a link, not the file git wrote; the Codex profile is not built`);
  io.mkdirp(`${main}/.agents/local/locks`);
  let abs = `,"${main}/.agents/local/locks"="write"`;
  // the record of the core: the git folder this worktree was created with
  const recPath = entryRecordPath(main, id);
  if (!io.isPlainFile(recPath)) throw new ProfileRefused(`no record of the git folder of ${root} (${recPath}); the worktree was not made by worktree-add, or before A263: remove it and run worktree-add again; the Codex profile is not built`);
  const entry = form(firstLine(recPath));
  // the recorded folder is ONE folder directly under <main>/.git/worktrees/ and no link: its real path (one snapshot) is itself
  const sub = entry === '' || !absolute(entry) ? null : inside(`${main}/.git/worktrees`, entry, platform);
  if (sub === null || sub.includes('/')) throw new ProfileRefused(`the recorded git folder of ${root} (${entry}) is not a folder under ${main}/.git/worktrees; the Codex profile is not built`);
  const g = form(io.real(entry));
  if (!io.isDir(entry) || !same(g, entry)) throw new ProfileRefused(`the recorded git folder of ${root} (${entry}) is gone or a link (${g}); the Codex profile is not built`);
  // the `.git` file names exactly the recorded folder (whole path, canonical)
  const line = /^gitdir: (.+)$/.exec(firstLine(`${root}/.git`));
  let named = line === null ? '' : form(line[1]);
  if (named !== '' && !absolute(named)) {
    if (win && named.startsWith('/')) throw new ProfileRefused(`the .git file of ${root} names a path without a drive (${named}); the Codex profile is not built`);
    named = `${form(root)}/${named}`;
  }
  if (named === '' || !same(form(io.real(named)), entry)) throw new ProfileRefused(`the .git file of ${root} does not name its recorded git folder ${entry}; the Codex profile is not built`);
  abs += `,"${g}"="write"`;
  // the objects folder is the main tree's own; the common folder is never taken from a file the worker can write
  if (!io.isDir(`${main}/.git`)) throw new ProfileRefused(`${main}/.git is not a folder; the Codex profile is not built`);
  if (io.isDir(`${main}/.git/objects`)) {
    const obj = form(io.real(`${main}/.git/objects`));
    if (!absolute(obj)) throw new ProfileRefused(`the objects folder of ${main}/.git is not on a drive (${obj}); the Codex profile is not built`);
    abs += `,"${obj}"="write"`;
  }
  return abs;
}
