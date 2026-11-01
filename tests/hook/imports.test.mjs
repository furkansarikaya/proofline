// @ts-check
// Every module of the Node hook imports cleanly, in the plugin layout (adapters/claude/hooks) and in the layout `proofline init` installs
// (.agents/hooks beside .agents/scripts): a missing import fails here, at once, not when a hook event first runs.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { installMinimal } from '../equivalence/fixture.mjs';

const hooks = resolve(import.meta.dirname, '../../adapters/claude/hooks');
const base = mkdtempSync(join(tmpdir(), 'hook-imports.'));
after(() => rmSync(base, { recursive: true, force: true }));

/** @param {string} dir @returns {string[]} every .mjs under dir, relative */
function mjs(dir, rel = '') {
  /** @type {string[]} */ const out = [];
  for (const n of readdirSync(join(dir, rel)).sort()) {
    const r = rel === '' ? n : `${rel}/${n}`;
    if (statSync(join(dir, r)).isDirectory()) out.push(...mjs(dir, r)); else if (n.endsWith('.mjs')) out.push(r);
  }
  return out;
}

/** @param {string} root @param {string} label */
async function importAll(root, label) {
  const files = mjs(root);
  assert.ok(files.length >= 20 && files.includes('lib/yield.mjs') && files.includes('lib/tree.mjs'), `${label}: found ${files.length} modules`);
  // worker.mjs is a worker_threads entry: it needs workerData and runs only inside a Worker (the hook starts it from the guards)
  for (const f of files.filter((x) => x !== 'lib/worker.mjs')) {
    await import(pathToFileURL(join(root, f)).href).catch((e) => assert.fail(`${label}: ${f} does not import: ${e.message}`));
  }
}

test('the plugin layout: every module under adapters/claude/hooks imports', async () => { await importAll(hooks, 'plugin'); });

test('the installed layout: the hook tree as the installer copies it (.agents/hooks) imports, with the project core beside it', async () => {
  const dir = join(base, 'proj');
  mkdirSync(dir);
  installMinimal(dir);
  const dest = join(dir, '.agents/hooks');
  mkdirSync(dest, { recursive: true });
  for (const f of ['proofline-hook.mjs', 'command-scan.mjs']) cpSync(join(hooks, f), join(dest, f));
  for (const d of ['events', 'guards', 'lib']) cpSync(join(hooks, d), join(dest, d), { recursive: true });
  await importAll(dest, 'installed');
  // the plugin-side tree comparison needs nothing of the project: yield.mjs and tree.mjs import from the hook folder only
  const { yieldsToOtherWiring } = await import(pathToFileURL(join(dest, 'lib/yield.mjs')).href);
  assert.equal(yieldsToOtherWiring(`${dest}/`, 'pretool', 'claude', {}), false);
});
