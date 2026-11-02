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
import { storePrompt } from '../../control-plane/agents/scripts/core/capture.mjs';
import { cleanEnv } from '../hook/harness.mjs';
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
  for (const f of ['test-lib.sh', 'agent.sh', 'proofline-core.mjs', 'batch.sh']) { const p = path.join(scripts, f); if (existsSync(p)) { const st = statSync(p); h.update(`${p}:${st.size}:${st.mtimeMs}\n`); } }
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
  const r = spawnSync('sh', ['-c', `. "$EQ_LIB"; ${recipe}\ncp -R "$PWD/." "$EQ_OUT/"`, EQ_LIB], { env: cleanEnv({ EQ_LIB, EQ_OUT: out }), encoding: 'utf8', timeout: 900000 });
  if (r.status !== 0) throw new Error(`recipe failed (${r.status}): ${recipe}\n${r.stderr}${r.stdout}`);
  cpSync(path.join(scripts, 'proofline-core.mjs'), path.join(out, '.agents/scripts/proofline-core.mjs'));
  cpSync(path.join(scripts, 'core'), path.join(out, '.agents/scripts/core'), { recursive: true });
  if (existsSync(path.join(scripts, 'batch.sh'))) cpSync(path.join(scripts, 'batch.sh'), path.join(out, '.agents/scripts/batch.sh'));
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

/** @typedef {{ status: number | null, out: string, err: string, text: string }} Result */

/**
 * One call of the control plane in the project (the Node core), as the role, with the stdin and the environment given.
 * @param {string} dir @param {string[]} args @param {{ role?: string, input?: string, env?: Record<string, string> }} [o] @returns {Result}
 */
export function A(dir, args, o = {}) {
  const env = cleanEnv({ ...(o.role ? { AGENT_ROLE: o.role } : {}), ...(o.env ?? {}) });
  const r = spawnSync('sh', ['.agents/scripts/agent.sh', ...args], { cwd: dir, env, input: o.input ?? '', encoding: 'utf8', timeout: 300000 });
  return { status: r.status, out: r.stdout, err: r.stderr, text: r.stdout + r.stderr };
}

/** The fixture verbs of the self-test library run in the project (state building only; the assertions are the caller's). @param {string} dir @param {string} snippet @returns {Result} */
export function verbs(dir, snippet) {
  const r = spawnSync('sh', ['-c', `cd "$DIR" && . "$EQ_LIB" && RID=LC && ${snippet}`, EQ_LIB], { env: cleanEnv({ EQ_LIB, DIR: dir }), encoding: 'utf8', timeout: 600000 });
  return { status: r.status, out: r.stdout, err: r.stderr, text: r.stdout + r.stderr };
}

/** The command must fail, and (when given) its message must contain the text. @param {Result} r @param {string} what @param {string | RegExp} [msg] */
export function refused(r, what, msg) {
  if (r.status === 0) throw new Error(`${what}: the command succeeded\n${r.text}`);
  if (msg !== undefined && !(typeof msg === 'string' ? r.text.includes(msg) : msg.test(r.text))) throw new Error(`${what}: rejected for another reason: ${r.text.trim().split('\n').pop()}`);
}
/** @param {Result} r @param {string} what */
export function accepted(r, what) { if (r.status !== 0) throw new Error(`${what}: refused: ${r.text}`); return r; }

const now = () => Math.floor(Date.now() / 1000);
/** Wait until the wall clock has reached second T. @param {number} t */
export function waitUntil(t) { const c = new Int32Array(new SharedArrayBuffer(4)); while (now() < t) Atomics.wait(c, 0, 0, 25); }

/** The newest `requested_at` or gate `epoch` of the project's records (a capture must be newer). @param {string} dir */
function newestRecord(dir) {
  let t = 0;
  for (const d of [`${dir}/.agents/runs/LC/approvals`, `${dir}/.agents/local/approvals`, `${dir}/.agents/runs/LC/gates`, `${dir}/.agents/runs/LC/questions`]) {
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) { const m = /^(?:requested_at|epoch|asked_at): (\d+)/m.exec(readFileSync(`${d}/${n}`, 'utf8')); if (m) t = Math.max(t, Number(m[1])); }
  }
  return t;
}

/** The user's message as the prompt hook stores it (session s1), stamped after every record of the project; waits for the clock to reach it. @param {string} dir @param {string} text @param {{ time?: number, session?: string }} [o] */
export function say(dir, text, o = {}) {
  const t = o.time ?? Math.max(now(), newestRecord(dir) + 1);
  const r = storePrompt(`${dir}/.agents/local`, o.session ?? 's1', t, text);
  if (!r) throw new Error('capture not stored');
  if (o.time === undefined) waitUntil(t);
  return r;
}

/** The value of a `key=value` line of `pipeline LC` (gate.X, tier ...). @param {string} dir @param {string} key */
export function pipe(dir, key) {
  const m = new RegExp(`^${key.replace(/[.]/g, '\\.')}=(.*)$`, 'm').exec(A(dir, ['pipeline', 'LC']).out);
  return m ? m[1] : '';
}
export const gateStatus = (/** @type {string} */ dir, /** @type {string} */ g) => pipe(dir, `gate.${g}`);
export const read = (/** @type {string} */ dir, /** @type {string} */ f) => readFileSync(path.join(dir, f), 'utf8');
export { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync };

/** Recipes (shell text for the self-test library) shared by several files. */
export const IMPLEMENTED = "worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'; A handoff LC IMPLEMENTED >/dev/null";

/** The user's reply to a request, as the runtime records it: request, the message, approve. @param {string} dir @param {string} kind @param {string} text */
export function approveAsUser(dir, kind, text) {
  accepted(A(dir, ['request-approval', 'LC', kind]), `request ${kind}`);
  say(dir, text);
  accepted(A(dir, ['approve', 'LC', kind]), `approve ${kind}`);
}
/** `rec GATE RESULT CONFIDENCE ROW...` of the self-test library (a gate result through the protocol). @param {string} dir @param {string} gate @param {string} result @param {string[]} rows */
export function rec(dir, gate, result, ...rows) {
  return verbs(dir, `rec ${gate} ${result} high ${rows.map((r) => `'${r}'`).join(' ')}`);
}
