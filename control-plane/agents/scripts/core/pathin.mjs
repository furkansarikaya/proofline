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
