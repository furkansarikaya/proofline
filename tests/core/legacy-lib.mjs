// @ts-check
// Shared helpers of the Node tests that replace the legacy shell suites (tests/legacy-port-map.tsv names which). A project is a throwaway copy of a recipe's template: the fixture STATE
// is built by the fixture verbs (tests/lib/recipe.mjs over the harness; the Node core is installed beside agent.sh like a real install), once per distinct recipe and code state (the
// template cache of the harness: atomic publish, shared by every test file of a run and a later run); every ASSERTED action is a plain call of the real control plane
// (`sh .agents/scripts/agent.sh`) made here, with the role, the stdin and the environment of the case.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOOKCMD_HANDLERS } from '../../control-plane/agents/scripts/core/commands/hookcmds.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { A, accepted, cached, cleanEnv, codeKey, copyOf } from '../lib/harness.mjs';
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

/**
 * `agent.sh language-check FILE` run IN THIS PROCESS: the same command handler the core dispatches to (hookcmds `language-check`), over the project's real files and its real
 * git (the committed-text lookup still starts git), with the hardened environment of every child. It saves the sh + node start of a round trip, so a table of spellings or
 * quote forms is checked without a process per row; one row per table still goes through `A` (the command line). A relative FILE resolves against the project, as it does
 * for the launcher, which runs in the project folder. @param {string} dir @param {string[]} args @returns {Result}
 */
export function languageIn(dir, args) {
  const out = /** @type {Buffer[]} */ ([]); const err = /** @type {Buffer[]} */ ([]);
  const io = { env: cleanEnv(), cwd: dir, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) }, scriptPath: `${dir}/.agents/scripts/agent.sh` };
  const ctx = new Context(io, io.scriptPath);
  const before = process.cwd();
  let status;
  try { process.chdir(dir); status = HOOKCMD_HANDLERS['language-check'](ctx, args); } finally { process.chdir(before); }
  ctx.flush();
  const o = Buffer.concat(out).toString('utf8'); const e = Buffer.concat(err).toString('utf8');
  return { status, out: o, err: e, text: o + e };
}

/** The fixture verbs run in the project (state building only; the assertions are the caller's). @param {string} dir @param {string} snippet @returns {Result} */
export function verbs(dir, snippet) { return runIn(dir, snippet); }

export { A, accepted, approveAsUser, gateStatus, pipe, read, refused, say } from '../lib/harness.mjs';
export { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync };

/** Recipes (sh text over the fixture verbs) shared by several files. */
export const IMPLEMENTED = "worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'; A handoff LC IMPLEMENTED >/dev/null";

/** `rec GATE RESULT CONFIDENCE ROW...` of the fixture verbs (a gate result through the protocol). @param {string} dir @param {string} gate @param {string} result @param {string[]} rows */
export function rec(dir, gate, result, ...rows) {
  return verbs(dir, `rec ${gate} ${result} high ${rows.map((r) => `'${r}'`).join(' ')}`);
}
