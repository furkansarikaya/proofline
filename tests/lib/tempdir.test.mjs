// @ts-check
// tests/lib/tempdir.mjs (A253): what the folder of `tempDir()` survives and what it does not. Each case runs a child process, because the removal happens when a process ends.
// No durations: the parent waits for the child's first line (the folder) and then for its exit.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { removeTree } from './prune.mjs';

const MODULE = JSON.stringify(new URL('./tempdir.mjs', import.meta.url).href);
/** @type {Set<import('node:child_process').ChildProcess>} */ const children = new Set();
after(() => { for (const c of children) c.kill('SIGKILL'); });   // a child that swallowed its signal (the regression this file guards) must not outlive the run

/**
 * Runs SCRIPT (an ES module body that has `tempDir` and prints the folder as its first line) and resolves with the folder and the process once the first line arrived.
 * @param {string} script @returns {Promise<{ dir: string, ended: Promise<{ code: number | null, signal: string | null }>, child: import('node:child_process').ChildProcess }>}
 */
function start(script) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { tempDir } from ${MODULE};\n${script}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.add(child);
  const ended = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  return new Promise((res) => { let s = ''; child.stdout?.on('data', (d) => { s += d; if (s.includes('\n')) res({ dir: s.trim(), ended: /** @type {any} */ (ended), child }); }); });
}

test('a tree with a read-only subfolder is removed at a normal exit', async () => {
  const { dir, ended, child } = await start(`
    import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
    const d = tempDir('ro-'); mkdirSync(d + '/sub'); writeFileSync(d + '/sub/f', 'x'); chmodSync(d + '/sub', 0o500);
    process.stdout.write(d + '\\n'); process.stdin?.pause(); setImmediate(() => process.exit(0));`);
  try {
    assert.deepEqual(await ended, { code: 0, signal: null });
    assert.equal(existsSync(dir), false, 'the read-only subfolder did not keep the folder');
  } finally { child.kill('SIGKILL'); try { removeTree(dir); } catch { /* gone */ } }
});

for (const sig of /** @type {const} */ (['SIGTERM', 'SIGINT'])) {
  test(`${sig}: the folder is removed and the process still ends by that signal`, { timeout: 20000 }, async () => {   // the timeout only ends a run in which the signal was swallowed; nothing waits for it
    const { dir, ended, child } = await start(`
      import { writeFileSync } from 'node:fs';
      const d = tempDir('sig-'); writeFileSync(d + '/f', 'x');
      process.stdout.write(d + '\\n'); setInterval(() => {}, 1 << 30);`);
    try {
      assert.ok(existsSync(path.join(dir, 'f')));
      child.kill(sig);
      assert.deepEqual(await ended, { code: null, signal: sig });
      assert.equal(existsSync(dir), false);
    } finally { child.kill('SIGKILL'); try { removeTree(dir); } catch { /* gone */ } }
  });
}
