// @ts-check
// Finding a platform tool (gh, glab, az) on Windows (A252, package 180-B). Pure: the file system is passed in, so the rules run (and are tested) on any host.
// Decision: a `.cmd` or `.bat` shim is REFUSED, never run. Node cannot start one without `cmd.exe`, and `cmd.exe` re-parses its command line (`& | ^ % " <` act
// again, the cause of CVE-2024-27980); no escaping is verified here, and a pull-request title or branch name reaches the arguments. Only a real `.exe` or `.com`
// found through PATHEXT, as an absolute drive path in a folder a model cannot write, is run, with an argument array and no shell. Unsure means refused (fail
// closed), with a text that says how to point PATH at the real program. Not tried on a Windows host (denenmedi).
import path from 'node:path';
import { asciiLower } from './shellglob.mjs';

const win = path.win32;

/** The extensions that may be started directly. */
const RUNNABLE = ['.exe', '.com'];
/** The shim extensions that are refused. */
const SHIMS = ['.cmd', '.bat'];

/**
 * @typedef {object} WinFs
 * @property {(p: string) => boolean} isFile
 * @property {(p: string) => string} real the real path of a file (symlinks and 8.3 names resolved); throws when it cannot
 * @property {(p: string) => boolean} refusedDir true when the folder is one a model can write (project, working directory, temporary folder)
 */

/** A Windows absolute path with a drive letter (`C:\x`, `C:/x`); UNC, drive-relative (`C:x`) and rooted (`\x`) paths are not. @param {string} p */
export function isDriveAbsolute(p) { return /^[A-Za-z]:[\\/]/.test(p) && win.isAbsolute(p); }

/** A tool name that is one plain file name: no separator, no drive colon, no shell metacharacter, no control character. @param {string} name */
export function plainToolName(name) { return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..'); }

/**
 * The candidate file names of NAME for a PATHEXT value: runnable extensions first, then the shims (found only to be refused). A name with an extension of its
 * own is taken as spelled. Extensions are compared case-insensitively; an unknown PATHEXT entry is ignored; an unset PATHEXT means the Windows default.
 * @param {string} name @param {string | undefined} pathext @returns {Array<{ file: string, ext: string }>}
 */
export function candidates(name, pathext) {
  const own = asciiLower(win.extname(name));
  if (RUNNABLE.includes(own) || SHIMS.includes(own)) return [{ file: name, ext: own }];
  const listed = (pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => asciiLower(e.trim()));
  return [...RUNNABLE, ...SHIMS].filter((e) => listed.includes(e)).map((e) => ({ file: `${name}${e}`, ext: e }));
}

/**
 * The refusal text for a tool that only exists as a shim.
 * @param {string} name @param {string} shim
 */
export function shimMessage(name, shim) {
  const hint = asciiLower(name) === 'az'
    ? 'the Azure CLI installs only az.cmd: finish the merge in Azure DevOps (merge: manual)'
    : `install the real ${name}.exe and put its folder on PATH ahead of the shim (for gh: C:\\Program Files\\GitHub CLI)`;
  return `unreadable (${name} is only a .cmd/.bat shim at ${shim}; proofline does not run a shim through cmd.exe: ${hint})`;
}

/**
 * The tool NAME on the Windows PATH of ENV: `{ path }` (absolute, real, runnable), `{ shim }` when the first folder that holds it holds only a `.cmd`/`.bat`,
 * `{ shadowed }` when it is inside a folder a model can write, `{ unreadable }` for none, a relative PATH entry only, or anything unsure.
 * @param {NodeJS.ProcessEnv} env @param {string} name @param {WinFs} fs
 * @returns {{ path: string } | { shim: string } | { shadowed: string } | { unreadable: string }}
 */
export function resolveWindowsTool(env, name, fs) {
  if (!plainToolName(name)) return { unreadable: 'unreadable' };
  for (const entry of (env.PATH ?? env.Path ?? '').split(';')) {
    const dir = entry.replace(/^"(.*)"$/, '$1');
    if (!isDriveAbsolute(dir)) continue;                        // empty (the current directory), relative, UNC and rooted entries are never searched
    /** @type {string | null} */ let shim = null;
    for (const { file, ext } of candidates(name, env.PATHEXT)) {
      const full = win.join(dir, file);
      let found = false;
      try { found = fs.isFile(full); } catch { found = false; }
      if (!found) continue;
      if (SHIMS.includes(ext)) { shim ??= full; continue; }
      let real;
      try { real = fs.real(full); } catch { return { unreadable: 'unreadable' }; }
      if (!isDriveAbsolute(real) || !RUNNABLE.includes(asciiLower(win.extname(real)))) return { unreadable: 'unreadable' };
      if (fs.refusedDir(win.dirname(real)) || fs.refusedDir(dir)) return { shadowed: real };
      return { path: real };
    }
    if (shim !== null) return { shim };                         // the first folder holding any form decides, as Windows does: a shim here is refused, an .exe further on is not used
  }
  return { unreadable: 'unreadable' };
}
