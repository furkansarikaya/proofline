// @ts-check
// Shared helpers of the Node tests that replace the legacy shell suites (tests/legacy-port-map.tsv names which). A project is a throwaway copy of a
// scaffold: the fixture STATE is built by the self-test library's own verbs (scaffold, worker, rec, gpass ...) driven by the real core, once per
// distinct recipe per process (a temporary dependency: the cleanup replaces the recipes by native builders); every ASSERTED action is a plain call of
// the real control plane (`sh .agents/scripts/agent.sh`, the Node core) made here, with the role, the stdin and the environment of the case.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { A, accepted, cleanEnv } from '../lib/harness.mjs';
import { repo } from './helpers.mjs';

export const scripts = path.join(repo, 'control-plane/agents/scripts');
const EQ_LIB = path.join(scripts, 'test-lib.sh');
const base = mkdtempSync(path.join(tmpdir(), 'legacy-'));
after(() => { rmSync(base, { recursive: true, force: true }); });
/** @type {Map<string, string>} */ const cache = new Map();
let counter = 0;

/** A fingerprint of the code a template is made of (the self-test library, agent.sh and the core): a changed file makes a new template. */
const codeKey = (() => {
  const h = createHash('sha256');
  const walk = (/** @type {string} */ d) => { for (const n of readdirSync(d).sort()) { const f = path.join(d, n); const st = statSync(f); if (st.isDirectory()) walk(f); else h.update(`${f}:${st.size}:${st.mtimeMs}\n`); } };
  for (const f of ['test-lib.sh', 'agent.sh', 'proofline-core.mjs']) { const p = path.join(scripts, f); if (existsSync(p)) { const st = statSync(p); h.update(`${p}:${st.size}:${st.mtimeMs}\n`); } }
  walk(path.join(scripts, 'core'));
  return h.digest('hex').slice(0, 12);
})();
const diskCache = path.join(tmpdir(), `legacy-templates-${process.getuid?.() ?? 0}`);

/**
 * The template of a recipe (a shell snippet of test-lib verbs): the project with the Node core beside agent.sh. Built once and kept on disk under
 * the temp folder, keyed by the recipe and the code it was made from, so every test file of a run (and a later run) reuses it.
 * @param {string} recipe
 */
export function template(recipe) {
  const hit = cache.get(recipe);
  if (hit) return hit;
  const key = createHash('sha256').update(`${codeKey}\n${recipe}`).digest('hex').slice(0, 20);
  const keep = path.join(diskCache, key);
  if (existsSync(`${keep}.built`)) { cache.set(recipe, keep); return keep; }
  mkdirSync(diskCache, { recursive: true });
  const out = mkdtempSync(path.join(diskCache, `build-${key}-`));
  // set -e: a step of the recipe that fails (a commit, a classify, a freeze ...) fails the build with its own message; without it the scaffold went on and the template
  // was kept at whatever state it had reached (a run that never got to IMPLEMENTING), for every test file of the run
  const r = spawnSync('sh', ['-c', `set -e; . "$EQ_LIB"; ${recipe}\ncp -R "$PWD/." "$EQ_OUT/"`, EQ_LIB], { env: cleanEnv({ EQ_LIB, EQ_OUT: out }), encoding: 'utf8', timeout: 900000 });
  if (r.status !== 0) throw new Error(`recipe failed (${r.status}): ${recipe}\n${r.stderr}${r.stdout}`);
  cpSync(path.join(scripts, 'proofline-core.mjs'), path.join(out, '.agents/scripts/proofline-core.mjs'));
  cpSync(path.join(scripts, 'core'), path.join(out, '.agents/scripts/core'), { recursive: true });
  appendFileSync(path.join(out, '.git/info/exclude'), '.agents/scripts/proofline-core.mjs\n.agents/scripts/core/\n.agents/local/\n');
  try { renameSync(out, keep); } catch { rmSync(out, { recursive: true, force: true }); /* another process finished first */ }
  writeFileSync(`${keep}.built`, '');
  cache.set(recipe, keep);
  return keep;
}

/** A fresh copy of a recipe's template. @param {string} recipe */
export function project(recipe) {
  const dir = path.join(base, `p${++counter}`);
  cpSync(template(recipe), dir, { recursive: true });
  return dir;
}

/** @typedef {import('../lib/harness.mjs').Result} Result */

/** The fixture verbs of the self-test library run in the project (state building only; the assertions are the caller's). @param {string} dir @param {string} snippet @returns {Result} */
export function verbs(dir, snippet) {
  const r = spawnSync('sh', ['-c', `cd "$DIR" && . "$EQ_LIB" && RID=LC && ${snippet}`, EQ_LIB], { env: cleanEnv({ EQ_LIB, DIR: dir }), encoding: 'utf8', timeout: 600000 });
  return { status: r.status, out: r.stdout, err: r.stderr, text: r.stdout + r.stderr };
}

export { A, accepted, approveAsUser, gateStatus, pipe, read, refused, say, waitUntil } from '../lib/harness.mjs';
export { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync };

/** Recipes (shell text for the self-test library) shared by several files. */
export const IMPLEMENTED = "worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'; A handoff LC IMPLEMENTED >/dev/null";

/** `rec GATE RESULT CONFIDENCE ROW...` of the self-test library (a gate result through the protocol). @param {string} dir @param {string} gate @param {string} result @param {string[]} rows */
export function rec(dir, gate, result, ...rows) {
  return verbs(dir, `rec ${gate} ${result} high ${rows.map((r) => `'${r}'`).join(' ')}`);
}
