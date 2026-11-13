// @ts-check
// Real paths and "is this path inside that folder" for the checks that keep a cited file inside a run (A260, Windows port W1). Stored paths and the containment checks of the core are
// POSIX text (`<run>/reports/x`, `real.startsWith(`${runReal}/`)`); on Windows `realpathSync` answers `C:\Users\RUNNER~1\...\run`, so every such check refused a file that was inside the run
// ("ARTIFACT path must be inside the run"). `realpathPosix` is the one place that turns a real path into the POSIX form (forward slashes, upper-case drive letter, the long name of an 8.3
// short name: `realpathSync.native` expands `RUNNER~1`, so two spellings of one folder compare equal); `inside` is the strict containment test on that form.
// On every other platform both are exactly what the code did before: `realpathSync` unchanged, `startsWith(`${base}/`)` with a case-sensitive compare. Pure where it can be: the platform and
// the realpath function are parameters, so the Windows rules are tested on any host.
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import { asciiLower, asciiUpper } from './shellglob.mjs';

/**
 * A path in the form the core stores and compares: win32 only, the `\\?\` prefix dropped, an upper-case ASCII drive letter and forward slashes; every other platform gets P back
 * unchanged (a backslash is an ordinary file name character there).
 * @param {string} p @param {string} [platform]
 */
export function posixForm(p, platform = process.platform) {
  if (platform !== 'win32') return p;
  return p.replace(/^\\\\[?.]\\(?=[A-Za-z]:[\\/])/, '').replace(/^([a-z]):/, (_m, d) => `${asciiUpper(d)}:`).split('\\').join('/');
}

/**
 * Do two paths name the same place by their text? Off Windows exactly `a === b`. On win32 both go through `posixForm`, a trailing slash does not matter and ASCII case is ignored
 * (the rule of `inside`; NTFS folds case, a non-ASCII difference is a different path).
 * @param {string} a @param {string} b @param {string} [platform]
 */
export function samePath(a, b, platform = process.platform) {
  if (platform !== 'win32') return a === b;
  const n = (/** @type {string} */ x) => asciiLower(posixForm(x, platform)).replace(/\/+$/, '');
  return n(a) === n(b);
}

/**
 * The real path of P in the form the core stores and compares paths in. Throws when P does not exist, like `realpathSync`.
 * @param {string} p
 * @param {{ platform?: string, real?: (p: string) => string }} [io]
 */
export function realpathPosix(p, io = {}) {
  const platform = io.platform ?? process.platform;
  if (platform !== 'win32') return (io.real ?? realpathSync)(p);
  const r = (io.real ?? realpathSync.native)(p);
  return posixForm(r, platform);
}

/**
 * The path of CHILD relative to BASE (`a/b` for `<base>/a/b`) when CHILD is strictly inside BASE, else null. Both are real paths in the form of `realpathPosix`. The boundary is a whole path
 * component (`/run2` is not inside `/run`), BASE itself is not inside BASE, and no `..` is interpreted: the callers pass real paths, where symbolic links and `..` are already resolved.
 * Case is ignored only on win32 and only for ASCII letters (`asciiLower`): NTFS folds case with its own table, not Unicode's, so U+212A (Kelvin sign), U+0131 (dotless i) and U+017F (long s) must never match `k`, `i`, `s`; a non-ASCII difference is a different path. Everywhere else case matters, as before.
 * @param {string} base @param {string} child @param {string} [platform] @returns {string | null}
 */
export function inside(base, child, platform = process.platform) {
  const prefix = platform === 'win32' && base.endsWith('/') ? base : `${base}/`;   // off Windows exactly `${base}/`, as the call sites had it
  if (child.length <= prefix.length) return null;
  const head = child.slice(0, prefix.length);
  const same = platform === 'win32' ? asciiLower(head) === asciiLower(prefix) : head === prefix;
  return same ? child.slice(prefix.length) : null;
}

/**
 * Whether a cited path is an absolute path of the host: a leading `/` everywhere; on win32 also `C:\x`, `C:/x` and a UNC path `\\srv\share`. Off Windows `C:\x` is an ordinary relative text, as before.
 * @param {string} p @param {string} [platform]
 */
export function isAbsoluteInput(p, platform = process.platform) {
  return p.startsWith('/') || (platform === 'win32' && (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')));
}

/**
 * Is a path a cited artifact or evidence path may NOT be (A268): an absolute path of the host (`isAbsoluteInput`, so `C:/x`, `C:\\x` and a UNC path on win32 too) or one with a `..`. Off Windows exactly
 * `p.startsWith('/') || p.includes('..')`, as the call sites had it. On Windows `/etc/passwd` reaches the core as `C:/Program Files/Git/etc/passwd` (the shell converts an argument), and before
 * that was refused only later, for another reason (outside the paths of the gate).
 * @param {string} p @param {string} [platform]
 */
export function notRunRelative(p, platform = process.platform) { return isAbsoluteInput(p, platform) || p.includes('..'); }

/**
 * A path typed by the caller, as a path on disk (A267): an absolute one (`isAbsoluteInput`) stays, a relative one is taken from CWD. Before, only a leading `/` counted, so on Windows `C:\\x` was
 * joined to the working directory and read as a missing file. Off Windows this is `p.startsWith('/') ? p : `${cwd}/${p}``, as before.
 * @param {string} cwd @param {string} p @param {string} [platform]
 */
export function onDisk(cwd, p, platform = process.platform) { return isAbsoluteInput(p, platform) ? p : `${cwd}/${p}`; }

/**
 * Does the file name of an explorer's report carry the agent's token (A113), or does the report lie in the submit's own temporary folder TMP? A Windows path has both slashes, so on win32 the
 * backslash separates too (before, `C:\\...\\ag1-rep` never matched `/ag1-`); elsewhere a backslash is an ordinary name character and the text is compared as given.
 * @param {string} report @param {string} agent @param {string} tmp @param {string} [platform]
 */
export function reportNamesAgent(report, agent, tmp, platform = process.platform) {
  const sl = (/** @type {string} */ t) => (platform === 'win32' ? t.replace(/\\/g, '/') : t);
  const r = sl(report);
  return r.includes(`/${agent}-`) || r.startsWith(`${agent}-`) || r.startsWith(`${sl(tmp)}/`);
}

/**
 * Is DIR a run worktree of the main tree MAIN, that is under `<main>/.agents/local/worktrees/` (A263)? Off Windows exactly `real(dir).startsWith(`${main}/.agents/local/worktrees/`)`, the
 * expression every caller had (a failing `real` leaves DIR as given). On win32 git prints MAIN as `C:/Users/runneradmin/...` while the real path of DIR is `C:\Users\RUNNER~1\...`: both go
 * through `realpathPosix`/`posixForm` (forward slashes, upper-case drive, the long name) and meet by `inside` (a whole component, ASCII case folded), so a worktree is found there too.
 * A UNC path is never inside a drive path, so it is not a worktree. @param {string} main @param {string} dir
 * @param {string} [platform] @param {(p: string) => string} [real] the real path of a folder (default: `realpathSync` off Windows, `realpathPosix` on)
 */
export function inRunWorktrees(main, dir, platform = process.platform, real = platform === 'win32' ? realpathPosix : realpathSync) {
  if (main === '') return false;
  let d;
  try { d = real(dir); } catch { d = dir; }
  if (platform !== 'win32') return d.startsWith(`${main}/.agents/local/worktrees/`);
  return inside(`${posixForm(main, platform)}/.agents/local/worktrees`, posixForm(d, platform), platform) !== null;
}

/**
 * The text a program printed, with the line ends of the host turned into `\n`: a Windows program ends its lines with CRLF, and a version line read from it kept the CR (it showed as `?`,
 * A261). Off Windows the text is returned as it is. @param {string} text @param {string} [platform]
 */
export function eolText(text, platform = process.platform) { return platform === 'win32' ? text.replace(/\r\n/g, '\n') : text; }

/**
 * The address of a local remote as the core stores and shows it. Off Windows, and for anything that is not a drive-absolute path (`C:\x`, `C:/x`), exactly U. On win32 git answers a relative
 * remote resolved against the working folder with its `..` still in it (`C:\proj\.agents\local\worktrees\LC/../proj-lo.git`); that is folded (`path.win32.resolve`) and, when the folder exists,
 * made the long forward-slash real path, so the same remote has one spelling whatever folder asked (A261).
 * @param {string} u @param {string} [platform] @param {(p: string) => string} [real]
 */
export function localRemote(u, platform = process.platform, real = realpathPosix) {
  if (platform !== 'win32' || !/^[A-Za-z]:[\\/]/.test(u)) return u;
  const abs = win32.resolve(u);
  try { return real(abs); } catch { return posixForm(abs, platform); }
}

/**
 * An absolute path on a LOCAL drive, for the places that read a file or search a folder the environment names (the Claude and Codex homes, the session log, PATH entries, certificate files). Off Windows exactly
 * `startsWith('/')`, as before. On win32 only `C:\x` and `C:/x`: a UNC path (`\\srv\share`, `//srv/share`) would make Windows authenticate to a remote host when it is read, and a rooted `/x` is relative to the current drive (A261).
 * @param {string} p @param {string} [platform]
 */
export function isLocalAbsolute(p, platform = process.platform) {
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/');
}

/**
 * The folder a private scratch directory is made in (`content_fingerprint`): off Windows exactly what the code did before, `$TMPDIR` or `/tmp`; on win32 the account temporary folder of the
 * host (`os.tmpdir()`: TEMP, TMP, the user profile), because `/tmp` is no folder there (`\tmp\proofline-fp.XXXXXX` answered ENOENT). The caller still makes the directory with `mkdtemp`
 * (a unique name; mode 0700 on POSIX, and on Windows the protection is the access list of the parent, the per-user %LOCALAPPDATA%\\Temp, not a mode), so nothing a model names is followed. @param {string | undefined} tmpdirEnv `process.env.TMPDIR` @param {string} [platform] @param {string} [host] `os.tmpdir()`
 */
export function scratchRoot(tmpdirEnv, platform = process.platform, host = tmpdir()) {
  return platform === 'win32' ? host : (tmpdirEnv || '/tmp');
}

/**
 * The null device in the spelling git accepts (A264): `/dev/null` off Windows (exactly what the code wrote before), `NUL` on win32 (`os.devNull` is `\\.\nul` there and git refuses it). One
 * place for `core.hooksPath`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_GRAFT_FILE`.
 * @param {string} [platform]
 */
export function nullDevice(platform = process.platform) {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}
