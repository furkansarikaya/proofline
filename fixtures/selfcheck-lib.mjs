// @ts-check
// Shared helpers of the selfcheck.mjs files (a selfcheck is a test of the fixture: it takes the built directory as its argument, prints
// `selfcheck: <message>` on stderr and exits 1 on the first broken fact, prints its `... ok` line when all facts hold). The Node form of
// the `fail`, `grep -q`, `[ -f ]` and `git` idioms of the shell selfchecks.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, run } from '../tests/lib/fixture.mjs';

export { fail, run };

/** Enter the built directory given as the argument (the shell selfchecks did `cd "$1"`). @returns {string} its absolute path */
export function enter() {
  const dir = process.argv[2];
  if (!dir) fail('usage: node selfcheck.mjs <built-dir>');
  process.chdir(path.resolve(dir));
  return process.cwd();
}

/** git without the user's or the system's configuration. @param {string[]} args @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} [o] */
export const git = (args, o = /** @type {any} */ ({})) => run('git', args, { ...o, env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', ...o.env } });

/** Trimmed stdout of a git command. @param {string[]} args */
export const gitOut = (args) => git(args).out.trim();

/** The repository root from the import.meta.url of a fixture's selfcheck.mjs. @param {string} metaUrl */
export const repoRootOf = (metaUrl) => path.resolve(path.dirname(fileURLToPath(metaUrl)), '..', '..');

export const exists = (/** @type {string} */ p) => existsSync(p);
export const isFile = (/** @type {string} */ p) => { try { return statSync(p).isFile(); } catch { return false; } };
export const isDir = (/** @type {string} */ p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
export const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');

/** `grep -q PATTERN FILE`: a string is a literal substring (grep -F), a RegExp is matched with the m flag added. A missing file does not match.
 *  @param {string} file @param {string | RegExp} pat */
export function has(file, pat) {
  let text; try { text = read(file); } catch { return false; }
  return typeof pat === 'string' ? text.includes(pat) : new RegExp(pat.source, pat.flags.includes('m') ? pat.flags : `${pat.flags}m`).test(text);
}

/** Does `node <args>` exit 0 (output discarded)? @param {string[]} args @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} [o] */
export const nodeOk = (args, o = /** @type {any} */ ({})) => run(process.execPath, args, o).status === 0;

/** Does this Node have the experimental node:sqlite (>= 22.5)? */
export const hasSqlite = () => run(process.execPath, ['--experimental-sqlite', '--no-warnings', '-e', "require('node:sqlite')"]).status === 0;

