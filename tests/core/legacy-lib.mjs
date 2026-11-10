// @ts-check
// Shared helpers of the Node tests that replace the legacy shell suites (tests/legacy-port-map.tsv names which). A project is a throwaway copy of a recipe's template: the fixture STATE
// is built by the fixture verbs (tests/lib/recipe.mjs over the harness; the Node core is installed beside agent.sh like a real install), once per distinct recipe and code state (the
// template cache of the harness: atomic publish, shared by every test file of a run and a later run); every ASSERTED action is a plain call of the real control plane
// (`sh .agents/scripts/agent.sh`) made here, with the role, the stdin and the environment of the case.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { A, accepted, cached, codeKey, copyOf } from '../lib/harness.mjs';
import { buildRecipe, runIn } from '../lib/recipe.mjs';
import { repo } from './helpers.mjs';

export const scripts = path.join(repo, 'control-plane/agents/scripts');
/** @type {Map<string, string>} */ const cache = new Map();

/**
 * The template of a recipe (sh text over the fixture verbs): the project with the Node core beside agent.sh. Built once and kept on disk under the temp folder, keyed by the recipe and
 * the code it was made from.
 * @param {string} recipe
 */
export function template(recipe) {
  const hit = cache.get(recipe);
  if (hit) return hit;
  const key = `rcp-${codeKey()}-${createHash('sha256').update(recipe).digest('hex').slice(0, 20)}`;
  const dir = cached(key, (work) => buildRecipe(recipe, work));
  cache.set(recipe, dir);
  return dir;
}

/** A fresh copy of a recipe's template. @param {string} recipe */
export function project(recipe) { return copyOf(template(recipe)); }

/** @typedef {import('../lib/harness.mjs').Result} Result */

/** The fixture verbs run in the project (state building only; the assertions are the caller's). @param {string} dir @param {string} snippet @returns {Result} */
export function verbs(dir, snippet) { return runIn(dir, snippet); }

export { A, accepted, approveAsUser, gateStatus, pipe, read, refused, say, waitUntil } from '../lib/harness.mjs';
export { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync };

/** Recipes (sh text over the fixture verbs) shared by several files. */
export const IMPLEMENTED = "worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'; A handoff LC IMPLEMENTED >/dev/null";

/** `rec GATE RESULT CONFIDENCE ROW...` of the fixture verbs (a gate result through the protocol). @param {string} dir @param {string} gate @param {string} result @param {string[]} rows */
export function rec(dir, gate, result, ...rows) {
  return verbs(dir, `rec ${gate} ${result} high ${rows.map((r) => `'${r}'`).join(' ')}`);
}
