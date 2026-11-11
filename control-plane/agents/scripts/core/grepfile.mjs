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
export function grepText(env, pattern, text, ci = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'proofline-grep-'));
  try {
    writeFileSync(path.join(dir, 'pat'), patternBytes(pattern));
    writeFileSync(path.join(dir, 'txt'), Buffer.from(text, 'latin1'));
    return proc.run('grep', [ci ? '-Eiq' : '-Eq', '-f', 'pat', '--', 'txt'], { cwd: dir, env, stdio: ['ignore', 'ignore', 'ignore'] }).status === 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * `grep -Eiq -e PATTERN` over a line on stdin: the pattern is a file of a private folder.
 * @param {Record<string, string | undefined>} env @param {string} pattern byte string @param {string} line
 */
export function grepLineCi(env, pattern, line) {
  const dir = mkdtempSync(path.join(tmpdir(), 'proofline-grep-'));
  try {
    writeFileSync(path.join(dir, 'pat'), patternBytes(pattern));
    return proc.run('grep', ['-Eiq', '-f', 'pat'], { cwd: dir, env, input: Buffer.from(line, 'latin1'), stdio: ['pipe', 'ignore', 'ignore'] }).status === 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
