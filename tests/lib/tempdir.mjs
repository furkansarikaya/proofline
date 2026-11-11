// @ts-check
// The one way a test makes a temporary folder that lives for the whole process (A253): `proofline-t-<prefix><6 random>` under the temp folder, removed when the process exits and on
// SIGINT/SIGTERM, found again by `node tests/lib/clean-temp.mjs` after a kill. A census test (tests/lib/census.test.mjs) fails on a test file that calls `mkdtemp*` anywhere else.
// No imports from the harness: a test that only needs a folder does not load the control plane.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** @type {Set<string>} */ const dirs = new Set();
let installed = false;
const removeAll = () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the assertions decided the result */ } } dirs.clear(); };

/**
 * Remove DIR when this process ends: at exit, and on SIGINT/SIGTERM (a killed run left 14 GB behind, A253). The signal handler removes synchronously and then sends the signal again
 * with its default action restored, so the exit status is the signal's, as without the handler. One handler serves every folder of the process.
 * @param {string} dir
 */
export function removeAtExit(dir) {
  dirs.add(dir);
  if (installed) return;
  installed = true;
  process.on('exit', removeAll);
  for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.once(sig, () => { removeAll(); process.kill(process.pid, sig); });
}

/** A new empty folder `proofline-t-<prefix>XXXXXX` that goes with the process. @param {string} [prefix] */
export function tempDir(prefix = '') {
  const dir = mkdtempSync(path.join(tmpdir(), `proofline-t-${prefix.replace(/^proofline-/, '')}`));
  removeAtExit(dir);
  return dir;
}
