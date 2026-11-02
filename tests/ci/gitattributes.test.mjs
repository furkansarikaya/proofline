// @ts-check
// .gitattributes pins line endings so that a Windows checkout (core.autocrlf=true) is byte-identical to a Linux one: tests compare bytes (golden captures,
// the process-budget tables, recorded hook output). Every golden file must be exempt from conversion (-text), everything else is written with LF, and the
// index must hold no CRLF line.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const repo = resolve(import.meta.dirname, '../..');
const git = (/** @type {string[]} */ ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 });
const files = (/** @type {string} */ prefix) => git('ls-files', '-z', '--', prefix).split('\0').filter(Boolean);
/** @param {string[]} paths @param {string} attr @returns {Map<string, string>} */
function attrs(paths, attr) {
  const out = execFileSync('git', ['-C', repo, 'check-attr', '-z', attr, '--stdin'], { input: paths.join('\0') + '\0', encoding: 'utf8', maxBuffer: 1 << 26 });
  const f = out.split('\0');
  /** @type {Map<string, string>} */ const m = new Map();
  for (let i = 0; i + 2 < f.length; i += 3) m.set(f[i], f[i + 2]);
  return m;
}

test('every file under tests/golden is exempt from conversion (text unset)', () => {
  const g = files('tests/golden');
  assert.ok(g.length > 40, `${g.length} golden files`);
  for (const [f, v] of attrs(g, 'text')) assert.equal(v, 'unset', `${f}: text is ${v}, expected -text`);
});
test('the other byte-compared data directories are exempt too', () => {
  for (const d of ['tests/enforcement/a132-commands', 'tests/e2e/replies', 'tests/skills/fixtures', 'fixtures']) {
    const fs = files(d);
    assert.ok(fs.length > 0, d);
    for (const [f, v] of attrs(fs, 'text')) assert.equal(v, 'unset', `${f}: text is ${v}`);
  }
});
test('scripts, tables, JSON and Markdown are written with LF whatever core.autocrlf says', () => {
  const sample = ['tests/bench/hook-budgets.tsv', 'tests/ci/shell-allowlist.txt', 'adapters/claude/hooks/hooks.json', 'tests/hook/harness.mjs', 'README.md', '.github/workflows/ci.yml'];
  for (const [f, v] of attrs(sample, 'eol')) assert.equal(v, 'lf', f);
  for (const [f, v] of attrs(sample, 'text')) assert.equal(v, 'auto', f);
});
test('the index holds no CRLF line (git ls-files --eol)', () => {
  const bad = git('ls-files', '--eol').split('\n').filter((l) => /^i\/(crlf|mixed)/.test(l));
  assert.deepEqual(bad, []);
});
test('.gitattributes starts with the default rule', () => {
  assert.match(readFileSync(join(repo, '.gitattributes'), 'utf8'), /^\* text=auto eol=lf$/m);
});
