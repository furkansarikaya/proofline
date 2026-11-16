// @ts-check
// Shared helpers of the Node tests that replace the legacy shell suites (tests/legacy-port-map.tsv names which). A project is a throwaway copy of a recipe's template: the fixture STATE
// is built by the fixture verbs (tests/lib/recipe.mjs over the harness; the Node core is installed beside agent.sh like a real install), once per distinct recipe and code state (the
// template cache of the harness: atomic publish, shared by every test file of a run and a later run); every ASSERTED action is a plain call of the real control plane
// (`sh .agents/scripts/agent.sh`) made here, with the role, the stdin and the environment of the case.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run as runCore } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { HOOKCMD_HANDLERS } from '../../control-plane/agents/scripts/core/commands/hookcmds.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { A, accepted, buildState, cached, cleanEnv, codeKey, copyOf, finishDone, gateStatus, must, passAll, qaBind, rec as harnessRec, scaffold, solo, toCodeDone, useCoreRun, worker } from '../lib/harness.mjs';
import { copyTree } from '../lib/prune.mjs';
import { buildRecipe, runIn } from '../lib/recipe.mjs';
import { repo } from './helpers.mjs';

useCoreRun(runCore);   // state building in process (buildState) runs the core's own run(argv, io)
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
  const opts = scaffoldOf(recipe);
  const key = `rcp-${codeKey()}-${createHash('sha256').update(recipe).digest('hex').slice(0, 20)}`;
  const dir = opts ? scaffolded(opts) : cached(key, (work) => buildRecipe(recipe, work));
  cache.set(recipe, dir);
  return dir;
}

/** The template of a plain scaffold (harness options), built IN PROCESS (A289) once per distinct options and code state. @param {import('../lib/harness.mjs').ScaffoldOptions} opts */
export function scaffolded(opts) {
  const key = `scf-${codeKey()}-${createHash('sha256').update(JSON.stringify(Object.entries(opts).sort())).digest('hex').slice(0, 20)}`;
  return cached(key, (work) => { buildState(() => { const built = scaffold(opts); copyTree(built, work); rmSync(built, { recursive: true, force: true }); }); });
}

/**
 * The scaffold options of a recipe that is nothing but `scaffold TOPOLOGY [LAYOUT [CLASS [AUTONOMY]]]` (the same arguments the fixture verb reads), or null for any other recipe,
 * which stays sh text over the fixture verbs. @param {string} recipe @returns {import('../lib/harness.mjs').ScaffoldOptions | null}
 */
function scaffoldOf(recipe) {
  const m = /^scaffold (orchestrated|standalone)(?: (yes|no)(?: (TRIVIAL|STANDARD|COMPLEX|CRITICAL)(?: (supervised|manual|autonomous))?)?)?$/.exec(recipe.trim());
  if (!m) return null;
  return { topology: m[1], layout: m[2] === 'yes' ? 'yes' : 'no', ...(m[3] ? { cls: m[3] } : {}), ...(m[4] ? { autonomy: m[4] } : {}) };
}

/** A fresh copy of a recipe's template. @param {string} recipe */
export function project(recipe) { return copyOf(template(recipe)); }

const ownSource = readFileSync(import.meta.filename, 'utf8');
/**
 * A template made of another template plus one more build step (A289): the parent is copied, `build` runs on the copy under `buildState` (the harness functions over the core's own `run`
 * in this process, real files and real git, no sh + node hop per call; worker-evidence still starts agent.sh for its stdin), and the result is kept like any template (atomic publish, shared by every test file and every later run). The scaffold and the earlier steps
 * are therefore built once per distinct prefix instead of once per distinct recipe. The key holds the content hash of the core and the libs (codeKey), of this file, the parent's own
 * key and the source of the step, so a changed core, lib or step builds a new template; a test takes a COPY of it (copyOf), never the template itself.
 * @param {string} parent a template folder (template(recipe) or an earlier stage) @param {string} name @param {(dir: string) => void} build @returns {string}
 */
export function stage(parent, name, build) {
  const key = `stg-${codeKey()}-${createHash('sha256').update(`${path.basename(parent)}\n${name}\n${ownSource}\n${build.toString()}`).digest('hex').slice(0, 20)}`;
  return cached(key, (work) => { copyTree(parent, work); rmSync(path.join(work, '.built'), { force: true }); buildState(() => build(work)); });
}

/** The worker evidence and IMPLEMENTED (RED, GREEN, handoff), in process (the same harness functions the fixture verbs call; a refusal throws). @param {string} d */
export function implemented(d) {
  buildState(() => {
    worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
    must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  });
}
/** A recipe's template followed by the worker evidence and IMPLEMENTED, built once per recipe (shared by every file that asks for the same prefix). @param {string} recipe */
export const implementedOn = (recipe) => stage(template(recipe), 'implemented', implemented);
/** The standalone run driven to CODE_DONE, and from there to DONE (the shared prefixes of the lifecycle, classify and freeze files). */
export const codeDoneStandalone = () => stage(template('scaffold standalone'), 'to_code_done standalone', toCodeDoneStandalone);
export const doneStandalone = () => stage(codeDoneStandalone(), 'finish_done', finishDoneStep);
/** @param {string} d */ function toCodeDoneStandalone(d) { toCodeDone(d, 'standalone'); }
/** @param {string} d */ function finishDoneStep(d) { finishDone(d); }
/** A fix round: back to IMPLEMENTING, one more worker line, IMPLEMENTED again. @param {string} d @param {string} line the line appended to impl.txt (it may hold the two characters backslash and n) */
export function fixRound(d, line) { buildState(() => { must(d, ['handoff', 'LC', 'IMPLEMENTING']); worker(d, 'FIX', 'pass', 'impl.txt', line); must(d, ['handoff', 'LC', 'IMPLEMENTED']); }); }
/** `A freeze|refreeze ...` of the fixture library: the QA plan is bound to the current PLAN.md first, then the real command. @param {string} d @param {string[]} args */
export function qaA(d, ...args) { qaBind(d, 'LC'); return A(d, args); }

/** @typedef {import('../lib/harness.mjs').Result} Result */

/**
 * A command handler of the core run IN THIS PROCESS, over the project's real files and its real git (the handlers still start git), with the hardened environment of every child:
 * the handler the dispatcher would call, without the sh + node start of a round trip. For STATE BUILDING and for tables of spellings; a call that asserts a refusal or the
 * command line itself goes through `A`. A relative path argument resolves against the project, as for the launcher, which runs in the project folder.
 * @param {Record<string, (ctx: Context, args: string[]) => number>} handlers @param {string} name @param {string} dir @param {string[]} args @returns {Result}
 */
function handlerIn(handlers, name, dir, args) {
  const out = /** @type {Buffer[]} */ ([]); const err = /** @type {Buffer[]} */ ([]);
  const io = { env: cleanEnv(), cwd: dir, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) }, scriptPath: `${dir}/.agents/scripts/agent.sh` };
  const ctx = new Context(io, io.scriptPath);
  const before = process.cwd();
  let status;
  try { process.chdir(dir); status = handlers[name](ctx, args); } finally { process.chdir(before); }
  ctx.flush();
  const o = Buffer.concat(out).toString('utf8'); const e = Buffer.concat(err).toString('utf8');
  return { status, out: o, err: e, text: o + e };
}

/** `agent.sh language-check FILE` in this process (hookcmds `language-check`); one row per table still goes through `A`. @param {string} dir @param {string[]} args @returns {Result} */
export function languageIn(dir, args) { return handlerIn(HOOKCMD_HANDLERS, 'language-check', dir, args); }

/** The status of a gate (`gate.X` of `pipeline LC`) read through the core in this process (the command's own code over the real files); a test's first read goes through `A`. @param {string} dir @param {string} gate */
export const gateStatusIn = (dir, gate) => buildState(() => gateStatus(dir, gate));

/** The fixture verbs run in the project (state building only; the assertions are the caller's). @param {string} dir @param {string} snippet @returns {Result} */
export function verbs(dir, snippet) { return runIn(dir, snippet); }

export { A, accepted, approveAsUser, buildState, copyOf, finishDone, gateStatus, gfail, gpass, must, passAll, pipe, read, refused, say, solo, wclose, wopen, worker } from '../lib/harness.mjs';
export { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync };

/** Recipes (sh text over the fixture verbs) shared by several files. */
export const IMPLEMENTED = "worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'; A handoff LC IMPLEMENTED >/dev/null";

/** `rec GATE RESULT ROW...` in process (confidence high): the result file for the gate, recorded as its owner through the real `record`; a refusal throws. @param {string} dir @param {string} gate @param {string} result @param {string[]} rows */
export function rec(dir, gate, result, ...rows) { return buildState(() => harnessRec(dir, gate, result, rows)); }
