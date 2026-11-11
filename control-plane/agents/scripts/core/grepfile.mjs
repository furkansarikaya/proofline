// @ts-check
// `grep -E` with a pattern that never travels as a command-line argument. The Windows MSYS grep, awk and git grep re-parse their command line
// and drop the backslashes of an argument (`(a|b)\(` becomes an unmatched group); a pattern read from a file or from stdin is taken byte for
// byte on every platform (A250, the same reason `config-check` reads its patterns from stdin, A246). On POSIX the answers are those of
// `grep -E -e PATTERN`: the file holds the pattern bytes plus one newline, so a pattern with a line end is several patterns, as `-e` does.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as proc from './proc.mjs';

/** The pattern as the bytes a `-f` file or stdin carries. @param {string} pattern a byte string (latin1) @returns {Buffer} */
export function patternBytes(pattern) { return Buffer.from(`${pattern}\n`, 'latin1'); }

/**
 * `grep -Eq[i] -e PATTERN` over a text (some line matches): the pattern and the text are files of a private folder that is the child's working
 * directory (relative names, so MSYS has no path to convert), removed afterwards.
 * @param {Record<string, string | undefined>} env @param {string} pattern byte string @param {string} text byte string @param {boolean} [ci]
 */
export function grepText(env, pattern, text, ci = false) { return grepTextStatus(env, pattern, text, ci) === 0; }

/** The exit status of that grep: 0 a line matches, 1 none does, 2 or more the platform grep cannot use the pattern. @param {Record<string, string | undefined>} env @param {string} pattern @param {string} text @param {boolean} [ci] */
export function grepTextStatus(env, pattern, text, ci = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'proofline-grep-'));
  try {
    writeFileSync(path.join(dir, 'pat'), patternBytes(pattern));
    writeFileSync(path.join(dir, 'txt'), Buffer.from(text, 'latin1'));
    return proc.run('grep', [ci ? '-Eiq' : '-Eq', '-f', 'pat', '--', 'txt'], { cwd: dir, env, stdio: ['ignore', 'ignore', 'ignore'] }).status;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * The lines of a text that `grep -E -e PATTERN` selects (none when the platform grep cannot use the pattern). Same private folder and relative names as grepTextStatus.
 * @param {Record<string, string | undefined>} env @param {string} pattern byte string @param {string} text byte string @returns {string[]}
 */
export function grepTextLines(env, pattern, text) {
  const dir = mkdtempSync(path.join(tmpdir(), 'proofline-grep-'));
  try {
    writeFileSync(path.join(dir, 'pat'), patternBytes(pattern));
    writeFileSync(path.join(dir, 'txt'), Buffer.from(text, 'latin1'));
    const r = proc.run('grep', ['-E', '-f', 'pat', '--', 'txt'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status !== 0) return [];
    const ls = r.stdout.toString('latin1').split('\n');
    if (ls[ls.length - 1] === '') ls.pop();
    return ls;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * `grep -Eiq -e PATTERN` over a line on stdin: the pattern is a file of a private folder.
 * @param {Record<string, string | undefined>} env @param {string} pattern byte string @param {string} line
 */
export function grepLineCi(env, pattern, line) { return grepLineCiStatus(env, pattern, line) === 0; }

/** The exit status of that grep (2 or more: the pattern is unusable). @param {Record<string, string | undefined>} env @param {string} pattern @param {string} line */
export function grepLineCiStatus(env, pattern, line) {
  const dir = mkdtempSync(path.join(tmpdir(), 'proofline-grep-'));
  try {
    writeFileSync(path.join(dir, 'pat'), patternBytes(pattern));
    return proc.run('grep', ['-Eiq', '-f', 'pat'], { cwd: dir, env, input: Buffer.from(line, 'latin1'), stdio: ['pipe', 'ignore', 'ignore'] }).status;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Is a git.forbidden_identities entry shaped like a shell glob (caseMatch)? An entry is a glob OR an ERE; BSD grep rejects an ERE that starts with a repetition
 * operator (`*@x.com`, `*+bot@x.com`, `*[a-z]@x.com`), so "grep cannot use it" is a failure only for an entry that is not glob-shaped: one with an unescaped `*` or `?`
 * or a bracket class. Accepted limit: an ERE typo that also holds a star (`(a.*`) is read as a glob and matches nothing.
 * @param {string} p
 */
export function globShaped(p) {
  const bare = p.replace(/\\[^]/g, '');
  return /[*?]/.test(bare) || /\[[^\]]+\]/.test(bare);
}

/**
 * Does an entry that is not glob-shaped look like an ERE with a typo (an unbalanced `(`, `)`, `[` or `{`)? Only such an entry fails closed when grep rejects it. Every other string
 * is a valid literal for caseMatch (`+x@y.com`, `{dev}@x.com` are exact addresses that BSD grep or ugrep refuse as an ERE), so it blocks exactly that identity and never everyone (A250).
 * @param {string} p
 */
export function ereTypo(p) {
  const bare = p.replace(/\\[^]/g, '');
  let depth = 0;
  for (const c of bare) { if (c === '(') depth++; else if (c === ')' && --depth < 0) return true; }
  if (depth !== 0) return true;
  const open = bare.indexOf('[');
  if (open >= 0 && bare.indexOf(']', open + 1) < 0) return true;
  const brace = bare.indexOf('{');
  return brace >= 0 && bare.indexOf('}', brace + 1) < 0;
}

/**
 * The entries of git.forbidden_identities from the value the one config reader returns (the hooks, config-check and doctor all use this): split on white space; one
 * surrounding `"` or `'` is dropped from EACH token (the reader only drops a pair around the whole value, so `"a" "b"` arrives as `a" "b`); an inline list `[a, "b"]` is split on
 * commas and white space. @param {string | null} value @returns {string[]}
 */
export function forbiddenTokens(value) {
  let v = value ?? '';
  const inner = /^\[([^]*)\]$/.exec(v.trim());
  const split = inner !== null && /[,\s"']/.test(inner[1]);
  if (split && inner !== null) v = inner[1];
  return v.split(split ? /[,\s]+/ : /[ \t\n]+/).map((x) => x.replace(/^["']/, '').replace(/["']$/, '')).filter((x) => x !== '');
}
