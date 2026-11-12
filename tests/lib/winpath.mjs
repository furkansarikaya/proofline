// @ts-check
// Three small helpers for tests that must give the same answer on Windows and on POSIX (A261, Windows port W2). They change nothing off Windows: `launch` is the program and its arguments as
// given, `posix` returns its argument, `nullDevice()` is `os.devNull`.
//  - `launch(program, args)`: a Node script with a `#!/usr/bin/env node` first line (`bin/proofline`) cannot be started by its path on Windows (no shebang, ENOENT); there it is started as
//    `node <script>`. Elsewhere the script is started by its own path, as before, so the shebang and the execute bit stay covered.
//  - `posix(p)`: the form the core stores and prints paths in (forward slashes, upper-case drive letter); temp folders and `path.join` answer `C:\Users\...` on Windows. Use it on the
//    EXPECTED or the observed side when only the test is biased towards POSIX text; the product's own values are compared as the product gives them.
import { devNull } from 'node:os';
import { posixForm } from '../../control-plane/agents/scripts/core/pathin.mjs';

/** @param {string} program @param {string[]} args @param {string} [platform] @returns {{ program: string, args: string[] }} */
export function launch(program, args, platform = process.platform) {
  return platform === 'win32' ? { program: process.execPath, args: [program, ...args] } : { program, args };
}

/** @param {string} p @param {string} [platform] */
export function posix(p, platform = process.platform) {
  return posixForm(p, platform);
}

/** The null device in the spelling git accepts: `os.devNull` is `\\.\nul` on Windows and git refuses it (`unable to access '\\.\nul'`), `NUL` it takes; elsewhere `os.devNull` (`/dev/null`) unchanged.
 *  @param {string} [platform] @param {string} [host] */
export function nullDevice(platform = process.platform, host = devNull) {
  return platform === 'win32' ? 'NUL' : host;
}

/**
 * `test` or `describe` of node:test that is skipped on win32 with a reason (A262), for a file whose every test starts a shell-script fake runtime from a temporary folder: the platform
 * resolver runs only a real .exe outside every temporary folder there (A252), by design, so no such fake can be the program. Elsewhere the function is returned unchanged.
 * @template {Function} F @param {F} fn @param {string} reason @param {string} [platform] @returns {F}
 */
export function skipOnWin32(fn, reason, platform = process.platform) {
  if (platform !== 'win32') return fn;
  return /** @type {any} */ ((/** @type {string} */ name, /** @type {any} */ a, /** @type {any} */ b) => (typeof a === 'function' ? fn(name, { skip: reason }, a) : fn(name, { ...a, skip: reason }, b)));
}
