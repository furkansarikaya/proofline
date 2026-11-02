// @ts-check
// Absolute Node ports of approval-load-test.sh fp_run_folder and fp_cache_integrity (A202-28) and timeouts-test.sh warn_line (A202-29): the content
// fingerprint ignores the run folder and sees product changes; the big-file cache never reaches a sealing fingerprint; a step that used 80% of its time gets
// exactly one TIME line. The expectations are the recorded properties of the shell suites; nothing is compared with a shell at test time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { A, project } from './legacy-lib.mjs';

const RECIPE = 'scaffold orchestrated no COMPLEX ""';

/** @param {string} dir @param {string[]} args @returns {string} stdout (trimmed), the command must succeed */
function run(dir, args) {
  const r = A(dir, args);
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.text}`);
  return r.out.trim();
}

test('fp_run_folder: the content fingerprint does not read the run folder, and still sees product changes', () => {
  const dir = project(RECIPE);
  writeFileSync(path.join(dir, '.gitignore'), '.agents/local/\n');
  const before = run(dir, ['fingerprint', 'LC']);
  // thirty big, distinct files in a run folder that is NOT git-ignored
  const screens = path.join(dir, '.agents/runs/LC/reviews/visual-proof/screens');
  mkdirSync(screens, { recursive: true });
  for (let i = 0; i < 30; i++) writeFileSync(path.join(screens, `shot-${i}.png`), Buffer.from(createHash('sha256').update(String(i)).digest('hex').repeat(20000 / 64 + 1).slice(0, 20000)));
  const after = run(dir, ['fingerprint', 'LC']);
  assert.equal(after, before, 'a non-ignored run folder changed the content fingerprint');
  appendFileSync(path.join(dir, 'impl.txt'), 'changed\n');
  assert.notEqual(run(dir, ['fingerprint', 'LC']), after, 'a product change did not change the content fingerprint');
});

test('fp_cache_integrity: a forged or stale cache never reaches a sealing fingerprint; a same-size same-mtime edit is detected', () => {
  const dir = project(RECIPE);
  const impl = path.join(dir, 'impl.txt');
  writeFileSync(impl, 'a'.repeat(400000));
  const p0 = run(dir, ['patch-fingerprint', 'LC']);
  const cache = path.join(dir, '.agents/local/fp-cache');
  assert.ok(statSync(cache).size > 0, 'the big file was not remembered by the sealing command (cache empty)');
  // a forged cache line for the file's key must not reach a sealing command
  const lines = readFileSync(cache, 'utf8').split('\n').filter(Boolean);
  const key = /** @type {string} */ (lines[lines.length - 1]).split('\t')[0];
  appendFileSync(cache, `${key}\t${createHash('sha256').update('forged').digest('hex')}\n`);
  assert.equal(run(dir, ['patch-fingerprint', 'LC']), p0, 'a forged cache line changed a sealing fingerprint');
  // same size, same mtime, one byte different: the sealing check must see it
  const st = statSync(impl);
  writeFileSync(impl, `${'a'.repeat(399999)}b`);
  utimesSync(impl, st.atime, st.mtime);
  const p1 = run(dir, ['patch-fingerprint', 'LC']);
  assert.notEqual(p1, p0, 'an edit that kept size and mtime was not detected by the sealing fingerprint');
  // the read-only path rehashes too, so a display never shows the old hash
  A(dir, ['digest', 'LC']);
  assert.equal(run(dir, ['patch-fingerprint', 'LC']), p1, 'the fingerprint changed without a file change');
});

/** Set an existing nested key of .agents/config.yaml (the shell suite's setcfg). @param {string} dir @param {string} section @param {string} key @param {string} value */
function setcfg(dir, section, key, value) {
  const file = path.join(dir, '.agents/config.yaml');
  let inSec = false;
  const out = readFileSync(file, 'utf8').split('\n').map((l) => {
    if (/^[^ #]/.test(l)) inSec = l === `${section}:`;
    return inSec && l.startsWith(`  ${key}:`) ? `  ${key}: ${value}` : l;
  });
  writeFileSync(file, out.join('\n'));
}

test('warn_line: a step at 80% of its time gets one TIME line in next and wait-line; none before, none when dead; the wait instruction stays', async () => {
  const dir = project(RECIPE);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  try {
    /** @param {number} elapsed @param {number} limit */
    const mk = (elapsed, limit) => {
      mkdirSync(path.join(dir, '.agents/runs/LC/dispatch'), { recursive: true });
      writeFileSync(path.join(dir, '.agents/runs/LC/dispatch/001-reviewer-claude.running'),
        `pid=${child.pid}\nrole=reviewer\ntimeout=${limit}\nstarted_epoch=${Math.floor(Date.now() / 1000) - elapsed}\ndispatch in flight: LC reviewer on claude, started now.\n`);
    };
    const WAIT = /^next=wait: dispatch\.sh LC reviewer in flight/m;
    // a 10000 s limit: a slow machine that takes seconds between mk and the check still reads the same whole percent (85% holds for 8500 to 8599 s)
    mk(1000, 10000);
    let out = run(dir, ['next', 'LC']);
    assert.doesNotMatch(out, /^note=TIME/m, 'a step at 10% of its time was reported');
    assert.match(out, WAIT, 'next does not say a dispatch is in flight');
    mk(8500, 10000);
    out = run(dir, ['next', 'LC']);
    const notes = out.split('\n').filter((l) => l.startsWith('note=TIME'));
    assert.equal(notes.length, 1, `a step at 85% of its time is not reported with exactly one line: ${out}`);
    assert.ok(/** @type {string} */ (notes[0]).includes('has used 141m of its 166m limit (85%)'), `the line does not name the use: ${notes[0]}`);
    assert.match(out, WAIT, 'the warning replaced the wait instruction');
    assert.match(/** @type {string} */ (notes[0]), /never a pass/i);
    const wl = run(dir, ['wait-line', 'LC']);
    assert.ok(wl.includes('TIME: 85% of its 166m limit'), `wait-line does not carry the warning: ${wl}`);
    assert.equal(wl.split('\n').length, 1, 'wait-line is more than one line');
    // the threshold is config: 90 is not reached at 85%
    setcfg(dir, 'timeouts', 'warn_percent', '90');
    assert.doesNotMatch(run(dir, ['next', 'LC']), /^note=TIME/m, 'warn_percent 90 still warned at 85%');
    setcfg(dir, 'timeouts', 'warn_percent', '80');
  } finally { child.kill('SIGKILL'); }
  // a marker whose process is dead says nothing
  await new Promise((resolve) => child.once('close', resolve));
  assert.doesNotMatch(run(dir, ['next', 'LC']), /^note=TIME/m, 'a dead dispatch was reported as slow');
});
