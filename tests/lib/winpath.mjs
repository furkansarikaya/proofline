// @ts-check
// Three small helpers for tests that must give the same answer on Windows and on POSIX (A261, Windows port W2). They change nothing off Windows: `launch` is the program and its arguments as
// given, `posix` returns its argument, `nullDevice()` is `os.devNull`.
//  - `launch(program, args)`: a Node script with a `#!/usr/bin/env node` first line (`bin/proofline`) cannot be started by its path on Windows (no shebang, ENOENT); there it is started as
//    `node <script>`. Elsewhere the script is started by its own path, as before, so the shebang and the execute bit stay covered.
//  - `posix(p)`: the form the core stores and prints paths in (forward slashes, upper-case drive letter); temp folders and `path.join` answer `C:\Users\...` on Windows. Use it on the
//    EXPECTED or the observed side when only the test is biased towards POSIX text; the product's own values are compared as the product gives them.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { tempDir } from './tempdir.mjs';
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

/**
 * Does the shell command COMMAND (run by `sh -c`, the shell git uses for a driver or a config program) create FILE? The in-test premise of every negative assertion "the program never ran"
 * (A264): when a Windows backslash path was written into the command, `sh` read it as an escape and made no file, so the negative assertion passed for the wrong reason. The file is removed.
 * @param {string} command @param {string} file
 */
export function shellMakes(command, file) {
  rmSync(file, { force: true });
  spawnSync('sh', ['-c', command], { stdio: 'ignore' });
  const made = existsSync(file);
  rmSync(file, { force: true });
  return made;
}

/**
 * The platform `grep` as the REFERENCE of a pattern test: `grep FLAGS -e RE` fed INPUT. On Windows the MSYS `grep` re-parses a command-line pattern (`a{2,3}b` arrives as `a3b`, A250) and,
 * in text mode, drops the carriage return of a CRLF line (so `x.$` would not match `x\r`, which POSIX grep matches). There the pattern goes in a file (`-f`, as the core does) and `-U`
 * keeps the bytes as they are. Elsewhere exactly `grep FLAGS -e RE`.
 * @param {string[]} flags @param {string} re @param {string | Buffer} input @param {import('node:child_process').SpawnSyncOptions} [opts]
 */
export function refGrep(flags, re, input, opts = {}) {
  if (process.platform !== 'win32') return spawnSync('grep', [...flags, '-e', re], { ...opts, input });
  const dir = tempDir('refgrep-');
  try {
    const file = path.join(dir, 'pat');
    writeFileSync(file, `${re}\n`);
    return spawnSync('grep', [...flags, '-U', '-f', posix(file)], { ...opts, input });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
