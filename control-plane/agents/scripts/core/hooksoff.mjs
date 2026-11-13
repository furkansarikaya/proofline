// @ts-check
// The value of `core.hooksPath` that turns every git hook of a repository off (A264, security round 1).
// POSIX: `/dev/null` (git finds no hook below it), byte-identical to what the code always wrote.
// Windows: `NUL` is NOT usable. It is a RELATIVE path, git looks for `<top of the work tree>/NUL/<hook>`, and Windows treats a device name as a device only as the LAST component of a
// path, so `NUL\post-index-change` is an ordinary file below an ordinary folder called `NUL`, which a worker can create in its own worktree and fill with hooks (the execute bit does not
// exist there). Git for Windows special-cases only the exact names `nul` and `/dev/null`. So on win32 the value is an ABSOLUTE path to a folder the core owns, that no worker can
// write (`<main>/.agents/local`, as the approvals and the records are) and that is EMPTY: `<main>/.agents/local/hooks-off`. It is made on first use and checked before EVERY use (a real
// folder, not a link, its real path is the expected one, nothing in it); when it cannot be provided the git command is refused (fail closed). `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`
// may stay `NUL` (pathin.nullDevice): there the whole value is the device, not a folder below the work tree.
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { fail } from './errors.mjs';
import { posixForm, samePath } from './pathin.mjs';

/** @typedef {{ real: (p: string) => string, mkdir: (p: string) => void, isRealDir: (p: string) => boolean, entries: (p: string) => string[] }} HooksFs */
/** @type {HooksFs} */
const NODE_FS = {
  real: (p) => realpathSync.native(p),
  mkdir: (p) => { mkdirSync(p, { recursive: true }); },
  isRealDir: (p) => { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); },
  entries: (p) => readdirSync(p),
};

/**
 * The hooks-off folder of MAIN on win32 (forward slashes, drive-absolute), or a refusal. Pure over the file system passed in.
 * @param {string} main the main working tree @param {HooksFs} [fsx] @returns {string}
 */
export function hooksOffDir(main, fsx = NODE_FS) {
  const drive = /^[A-Za-z]:\//;
  try {
    const root = posixForm(fsx.real(main), 'win32');
    if (!drive.test(root)) fail(`the main tree ${root} is not on a local drive`);
    const dir = `${root.replace(/\/+$/, '')}/.agents/local/hooks-off`;
    fsx.mkdir(dir);
    if (!fsx.isRealDir(dir)) fail(`${dir} is not a real folder`);
    const real = posixForm(fsx.real(dir), 'win32');
    if (!drive.test(real) || !samePath(real, dir, 'win32')) fail(`${dir} resolves to ${real}`);
    if (fsx.entries(dir).length > 0) fail(`${dir} must be empty`);
    return real;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return fail(`git hooks cannot be turned off: ${why}; the git command was not run (remove whatever is in <main>/.agents/local/hooks-off and make it an empty folder)`);
  }
}

/**
 * `core.hooksPath` value that disables hooks for a git run in the tree of CTX. @param {{ sharedMain?: () => string, root: string }} ctx @param {string} [platform] @param {HooksFs} [fsx]
 */
export function hooksOff(ctx, platform = process.platform, fsx) {
  if (platform !== 'win32') return '/dev/null';
  // the main tree of a run; the contexts of `init` and the code audit (a user's own checkout, no worker, no run) have no such notion and use their root
  return hooksOffDir(typeof ctx.sharedMain === 'function' ? ctx.sharedMain() : ctx.root, fsx);
}
