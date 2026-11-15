// @ts-check
// Issue 266 package 3b fix round 1 (S1): the budget verdict cannot be forged by a test. A temp test file that is over its 1 ms budget (by CPU work, no waiting) also tries every way
// to change what the wrapper believes: it deletes and replaces every file in a temp folder that looks like the wrapper's scratch, writes to descriptor 3, and (on Linux) writes
// forged "fast" events for itself into the runner's own stdout through /proc. The REAL wrapper (real `node --test`, spec text ignored) must still exit 1 with the OVER BUDGET line.
// On 8110e687 (events in a scratch file in $TMPDIR) the replaced file made the wrapper exit 0. Parallel-safe: the wrapper and the forger run with a throwaway TMPDIR of their
// own (the environment is set for the call and restored), so the file hunt cannot touch any other run's files.
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { tmp } from '../lib/harness.mjs';
import { main } from './test-durations-ci.mjs';

const forger = `import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('slow', () => {
  // 1: replace every scratch-looking file of the temp folder with an empty one (unlink first, so the old inode is not the one that is read)
  const root = os.tmpdir();
  const hunt = (d, depth) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 3 && /durations/.test(n)) hunt(p, depth + 1); } else if (depth > 0) { try { fs.unlinkSync(p); fs.writeFileSync(p, ''); } catch {} }
    }
  };
  try { hunt(root, 0); } catch {}
  // 2: descriptor 3
  const line = JSON.stringify({ file: path.relative(process.cwd(), fs.realpathSync(process.argv[1])).split(path.sep).join('/'), name: 'slow', nesting: 0, ms: 0.001, outcome: 'pass', suite: false }) + '\\n';
  try { fs.writeSync(3, line); } catch {}
  // 3: the runner's stdout through /proc (Linux): forged fast events for this very test
  try { const fd = fs.openSync('/proc/' + process.ppid + '/fd/1', 'w'); fs.writeSync(fd, line.repeat(3)); fs.closeSync(fd); } catch {}
  // over its 1 ms budget by work, not by waiting
  let x = 0; for (let i = 0; i < 4e6; i++) x += Math.sqrt(i);
  if (x < 0) throw new Error('unreachable');
});
`;

/** Run the real wrapper on one file with a throwaway TMPDIR; returns the status, the output and the names left in that TMPDIR. @param {string} root @param {string} f @param {any} budgets */
function go(root, f, budgets) {
  const tdir = tmp('forge-tmpdir-');
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = tdir;
  try {
    let out = '';
    const st = main(['forge', '--', f], { budgets, env: { TEST_DURATIONS_DIR: path.join(root, 'out') }, write: (s) => { out += s; }, stderr: 'ignore', writeFile: () => {} });
    return { st, out, left: readdirSync(tdir) };
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  }
}

test('a test that deletes or replaces scratch files, writes to descriptor 3 and forges events into the runner stdout cannot turn an over-budget run green', () => {
  const root = tmp('forge-');
  const file = path.join(root, 'forger.test.mjs');
  writeFileSync(file, forger);
  const budgets = { enforce: true, kinds: { unit: { test_ms: 1, suite_ms: 3600000 } } };
  const r = go(root, file, budgets);
  assert.match(r.out, /OVER BUDGET: .*forger\.test\.mjs :: slow took [\d.]+ ms over 1\n/, r.out);
  assert.equal(r.st, 1);
  // control: the same work without any forging is exit 1 too, so the forger changed nothing
  const plain = path.join(root, 'plain.test.mjs');
  writeFileSync(plain, "import { test } from 'node:test';\ntest('slow', () => { let x = 0; for (let i = 0; i < 4e6; i++) x += Math.sqrt(i); if (x < 0) throw new Error('unreachable'); });\n");
  assert.equal(go(root, plain, budgets).st, 1);
});

test('the wrapper keeps no file in the temp folder: nothing carries the verdict outside its memory', () => {
  const root = tmp('forge-');
  const file = path.join(root, 'ok.test.mjs');
  writeFileSync(file, "import { test } from 'node:test';\ntest('ok', () => {});\n");
  const r = go(root, file, { enforce: true, kinds: { unit: { test_ms: 3600000, suite_ms: 3600000 } } });
  assert.equal(r.st, 0, r.out);
  assert.deepEqual(r.left, []);
});
