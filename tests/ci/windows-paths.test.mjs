// @ts-check
// Every tracked path must be a valid path on Windows: a reserved device name (CON PRN AUX NUL COM1-9 LPT1-9, with or without an extension) in any
// component, a character that Windows forbids (< > : " | ? * backslash, a control character), a component ending in a dot or a space, a case-only
// collision with another path, and a path longer than 240 characters (the checkout adds a prefix) all make `git clone` fail on Windows, as
// `tests/golden/capture/nul/` once did (the hook-windows job failed at checkout).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '..', '..');
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** The problems of a list of paths. @param {string[]} files @returns {string[]} */
export function windowsPathProblems(files) {
  /** @type {string[]} */ const bad = [];
  /** @type {Map<string, string>} */ const seen = new Map();
  for (const p of files) {
    for (const c of p.split('/')) {
      if (RESERVED.test(c.replace(/\..*$/, ''))) bad.push(`${p}: ${c} is a reserved device name on Windows`);
      else if (/[<>:"|?*\\\u0000-\u001f]/.test(c)) bad.push(`${p}: ${JSON.stringify(c)} has a character Windows forbids`);
      else if (/[. ]$/.test(c)) bad.push(`${p}: ${JSON.stringify(c)} ends in a dot or a space`);
    }
    if (p.length > 240) bad.push(`${p.slice(0, 60)}...: ${p.length} characters (limit 240)`);
    const k = p.toLowerCase();
    const other = seen.get(k);
    if (other !== undefined && other !== p) bad.push(`${p} and ${other} differ only by case`);
    seen.set(k, p);
  }
  return bad;
}

test('the checks themselves catch the known bad shapes', () => {
  const bad = windowsPathProblems(['a/nul/x', 'a/NUL.txt', 'a/com1.json', 'a/b:c', 'a/b?', 'a/x.', 'a/y ', 'a/Q', 'a/q', `a/${'z'.repeat(250)}`, 'ok/nul-byte/x', 'ok/console.txt']);
  assert.equal(bad.filter((l) => /reserved/.test(l)).length, 3);
  assert.equal(bad.filter((l) => /forbids/.test(l)).length, 2);
  assert.equal(bad.filter((l) => /dot or a space/.test(l)).length, 2);
  assert.equal(bad.filter((l) => /differ only by case/.test(l)).length, 1);
  assert.equal(bad.filter((l) => /limit 240/.test(l)).length, 1);
  assert.equal(bad.length, 9);
});

test('no tracked path is invalid, case-colliding or too long for Windows', () => {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) { assert.fail(`git ls-files failed: ${r.stderr}`); }
  assert.deepEqual(windowsPathProblems(r.stdout.split('\0').filter(Boolean)), []);
});
