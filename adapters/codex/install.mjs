#!/usr/bin/env node
// Terminal / Codex installer (D8; Node since A234, it was install.sh): clone the repository, run this script, then run `proofline init` in each
// project. No `curl | bash`: it only links bin/proofline from this checkout onto your PATH.
//
//   node adapters/codex/install.mjs [--dir DIR] [--yes]
//
//   --dir DIR  directory for the `proofline` symlink (default ~/.local/bin)
//   --yes      no questions; also appends `export PATH=...` to your shell's rc file when DIR is not on PATH.
//              Without --yes no shell rc file is ever edited.
//
// Codex discovers the skills from each project's .agents/skills/ (installed by `proofline init`); there is
// nothing to install into ~/.codex.
import '../../control-plane/agents/scripts/core/node-check.mjs';
import { accessSync, appendFileSync, constants, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLine } from '../../control-plane/agents/scripts/core/cliio.mjs';

const USAGE = `Usage: node adapters/codex/install.mjs [--dir DIR] [--yes]

  --dir DIR  directory for the proofline symlink (default ~/.local/bin)
  --yes      no questions; also appends \`export PATH=...\` to your shell's rc file when DIR is not on PATH.
             Without --yes no shell rc file is ever edited.
`;

/**
 * @param {string[]} argv @param {{ env?: NodeJS.ProcessEnv, repo?: string, ask?: (q: string) => string | null, interactive?: boolean, out?: (l: string) => void, err?: (l: string) => void }} [o]
 * @returns {number} the exit status
 */
export function install(argv, o = {}) {
  const env = o.env ?? process.env;
  const repo = o.repo ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const out = o.out ?? ((l) => process.stdout.write(`${l}\n`));
  const err = o.err ?? ((l) => process.stderr.write(`${l}\n`));
  const interactive = o.interactive ?? (process.stdin.isTTY === true || env.PROOFLINE_PROMPT === '1');
  const ask = o.ask ?? ((q) => { process.stdout.write(q); return readLine(0); });
  const target = join(repo, 'bin', 'proofline');
  let dir = env.HOME ? join(env.HOME, '.local', 'bin') : '';
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') { if (i + 1 >= argv.length) { err('install.mjs: --dir needs a directory'); return 2; } dir = argv[++i]; }
    else if (a === '--yes' || a === '-y') yes = true;
    else if (a === '-h' || a === '--help') { out(USAGE.trimEnd()); return 0; }
    else { err(`install.mjs: unknown argument: ${a}`); return 2; }
  }
  try { if (!statSync(target).isFile()) throw new Error('not a file'); accessSync(target, constants.X_OK); } catch {
    err(`install.mjs: ${target} is missing or not executable (is this a proofline checkout?)`); return 1;
  }
  if (dir === '') { err('install.mjs: no install directory (HOME is unset; pass --dir)'); return 2; }

  if (!yes) {
    if (!interactive) { err('install.mjs: not a terminal; pass --yes to link without asking (or --dir DIR)'); return 1; }
    const a = ask(`Directory for the proofline symlink [${dir}]: `);
    if (a !== null && a !== '') dir = a;
    const b = ask(`Link ${dir}/proofline -> ${target} ? [y/N]: `);
    if (!['y', 'Y', 'yes'].includes(b ?? '')) { out('nothing installed'); return 1; }
  }

  try { mkdirSync(dir, { recursive: true }); } catch { return 1; }
  const link = join(dir, 'proofline');
  let st = null; try { st = lstatSync(link); } catch { /* no such name */ }
  if (st && !st.isSymbolicLink()) { err(`install.mjs: ${link} exists and is not a symlink; remove it first`); return 1; }
  try {
    if (st) unlinkSync(link);
    symlinkSync(target, link);
  } catch (e) { err(`install.mjs: cannot link ${link}: ${/** @type {Error} */ (e).message}`); return 1; }
  out(`linked ${link} -> ${target}`);

  if (!(`:${env.PATH ?? ''}:`).includes(`:${dir}:`)) {
    const line = `export PATH="${dir}:$PATH"`;
    if (yes) {
      const home = env.HOME ?? '';
      const sh = env.SHELL ?? '';
      const rc = sh.endsWith('zsh') ? `${home}/.zshrc` : sh.endsWith('bash') ? `${home}/.bashrc` : `${home}/.profile`;
      let text = null; try { text = readFileSync(rc, 'utf8'); } catch { /* no rc file yet */ }
      if (text !== null && text.split('\n').includes(line)) out(`${dir} is already on PATH in ${rc}`);
      else { try { appendFileSync(rc, `\n# proofline\n${line}\n`); out(`added to ${rc}: ${line} (open a new shell)`); } catch { /* unwritable rc file: nothing is claimed */ } }
    } else {
      out(`${dir} is not on your PATH. Add this to your shell rc file (not edited without --yes):`);
      out(`  ${line}`);
    }
  }
  out('');
  out('next, in each project you want proofline in:');
  out('  cd <project> && proofline init');
  out('then: proofline doctor');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = install(process.argv.slice(2));
