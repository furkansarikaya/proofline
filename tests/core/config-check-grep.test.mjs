// @ts-check
// `config-check` hands the regular expressions of the config to the platform's `grep -E` to be validated. On Windows the MSYS grep re-parses its
// command line and eats the backslashes of an argument (`(a|b)\(` arrived as `(a|b)(`: "Unmatched ( or \(" for the shipped `validation.code_patterns`,
// nightly hook-windows A246), so a pattern must never be an argument: it goes to grep on its standard input (`-f -`).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, newRepo, tmp } from '../lib/harness.mjs';

test('config-check passes every regular expression to grep on stdin, never as an argument, and still rejects an invalid one', { skip: process.platform === 'win32' }, () => {
  const dir = newRepo();
  const shim = tmp('shim');
  const log = path.join(shim, 'argv.log');
  const real = ['/usr/bin/grep', '/bin/grep'].find((p) => { try { readFileSync(p); return true; } catch { return false; } }) ?? 'grep';
  mkdirSync(shim, { recursive: true });
  writeFileSync(path.join(shim, 'grep'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(path.join(shim, 'grep'), 0o755);
  const env = { PATH: `${shim}:${process.env.PATH}` };
  const ok = A(dir, ['config-check'], { env });
  assert.equal(ok.status, 0, ok.text);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(calls.length >= 1, 'grep was started');
  for (const c of calls) assert.match(c, /^-Eq -f -$/, `a grep call carries the pattern in its arguments: ${c}`);
  // an invalid expression is still found (grep exits 2)
  const cfg = path.join(dir, '.agents/config.yaml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^(\s*code_patterns:).*$/m, '$1 "(unclosed"'));
  const bad = A(dir, ['config-check'], { env });
  assert.notEqual(bad.status, 0);
  assert.match(bad.text, /invalid regular expression for validation\.code_patterns/);
});
