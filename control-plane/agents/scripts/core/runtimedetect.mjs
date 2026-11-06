// @ts-check
// Which agent runtimes are usable on this machine (D6, D7; A222, the former scripts/runtime-detect.sh). Used by dispatch.sh (failover) and doctor.
//
//   cli runtime-detect                 one line per runtime: <runtime> installed=yes|no path=<p> version=<v>
//   cli runtime-detect has <runtime>   exit 0 when the runtime's binary is on PATH
//   cli runtime-detect bin <runtime>   print the binary used for the runtime
//
// Binaries: PROOFLINE_CLAUDE_BIN (default claude), PROOFLINE_CODEX_BIN (default codex). A runtime with a dispatch.command_template counts as
// installed when the template's first word is on PATH.
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isFile } from './paths.mjs';
import * as proc from './proc.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/**
 * `command -v NAME`: a name with a slash is a file path; any other name is searched on the PATH of the environment. The first executable regular
 * file, as it is spelled; null when there is none.
 * @param {string} name @param {NodeJS.ProcessEnv} env @returns {string | null}
 */
export function commandV(name, env) {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const dirs = name.includes('/') ? [''] : (env.PATH ?? '').split(path.delimiter);
  for (const entry of dirs) {
    for (const ext of exts) {
      const f = name.includes('/') ? `${name}${ext}` : `${entry === '' ? '.' : entry}/${name}${ext}`;
      try {
        if (!statSync(f).isFile()) continue;
        accessSync(f, constants.X_OK);
        return f;
      } catch { /* not here */ }
    }
  }
  return null;
}

/**
 * The first word of `dispatch.command_template.<rt>` (the same line scan the awk program made: a two-space `command_template:` line inside the
 * top-level `dispatch:` block, then the first word of the line `    <rt>: ...`).
 * @param {string} configFile @param {string} rt @returns {string}
 */
function templateWord(configFile, rt) {
  if (!isFile(configFile)) return '';
  let d = false; let c = false;
  for (const line of readFileSync(configFile, 'latin1').split('\n')) {
    if (line.startsWith('dispatch:')) { d = true; continue; }
    if (/^[^ #]/.test(line)) d = false;
    if (d && line.startsWith('  command_template:')) { c = true; continue; }
    if (d && /^ {2}[^ ]/.test(line)) c = false;
    if (d && c) {
      const f = line.split(/[ \t]+/).filter((x) => x !== '');
      if (f[0] === `${rt}:`) return f[1] ?? '';
    }
  }
  return '';
}

/** `bin_of RT`: the binary of a runtime, or null. @param {Context} ctx @param {string} rt @returns {string | null} */
export function binOf(ctx, rt) {
  if (rt === 'claude') return ctx.env.PROOFLINE_CLAUDE_BIN || 'claude';
  if (rt === 'codex') return ctx.env.PROOFLINE_CODEX_BIN || 'codex';
  const t = templateWord(ctx.configFile, rt);
  return t === '' ? null : t;
}

/** `has RT`: is the runtime's binary on the PATH? @param {Context} ctx @param {string} rt */
export function hasRuntime(ctx, rt) {
  const b = binOf(ctx, rt);
  return b !== null && commandV(b, ctx.env) !== null;
}

/**
 * The command: no argument lists the two built-in runtimes; `has RT` and `bin RT` answer for one.
 * @param {Context} ctx @param {string[]} args @returns {{ status: number, out: string, err: string }}
 */
export function runtimeDetect(ctx, args) {
  const op = args[0] ?? '';
  if (op === 'has' || op === 'bin') {
    const rt = args[1];
    if (rt === undefined || rt === '' || args.length !== 2) return { status: 2, out: '', err: `usage: runtime-detect ${op} <runtime>\n` };
    if (op === 'has') return { status: hasRuntime(ctx, rt) ? 0 : 1, out: '', err: '' };
    const b = binOf(ctx, rt);
    return b === null ? { status: 1, out: '', err: '' } : { status: 0, out: `${b}\n`, err: '' };
  }
  if (op !== '' || args.length > 0) return { status: 2, out: '', err: 'usage: runtime-detect [has|bin <runtime>]\n' };
  let out = '';
  for (const rt of ['claude', 'codex']) {
    const b = /** @type {string} */ (binOf(ctx, rt));
    const p = commandV(b, ctx.env);
    if (p === null) { out += `${rt} installed=no path=- version=-\n`; continue; }
    const r = proc.run(b, ['--version'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'], timeoutMs: 10000 });
    const v = r.stdout.toString('latin1').split('\n')[0] ?? '';
    out += `${rt} installed=yes path=${p} version=${v === '' ? 'unknown' : v}\n`;
  }
  return { status: 0, out, err: '' };
}
