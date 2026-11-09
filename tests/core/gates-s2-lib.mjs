// @ts-check
// Helpers of tests/core/gates-s2.test.mjs (slice S2 of the gates-test.sh port, issue #176 package D1): the Node core answers EVERY command (the core is laid
// out beside agent.sh as `proofline init` does), a scaffolded run is the harness' native one, and the user's own words reach `answer --captured` the way the
// prompt hook hands them over (in process), the only way they are recorded as the user's (#187, A210).
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run as runCore } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { A, cleanEnv, must, project, scripts, solo, worker } from '../lib/harness.mjs';
import { storePrompt } from '../../control-plane/agents/scripts/core/capture.mjs';

export { A, AS, accepted, capture, gfail, must, passAll, pipe, read, refused, rv, say, toCodeDone, tsha, wclose, wopen, worker, solo, writeReport } from '../lib/harness.mjs';
export const now = () => Math.floor(Date.now() / 1000);

/**
 * A scaffolded project with the Node core beside agent.sh (every command in Node, as an installed project). Options as the harness' `scaffold`.
 * @param {import('../lib/harness.mjs').ScaffoldOptions} [o] @returns {string}
 */
export function proj(o = {}) {
  const d = project(o);
  cpSync(path.join(scripts, 'proofline-core.mjs'), path.join(d, '.agents/scripts/proofline-core.mjs'));
  cpSync(path.join(scripts, 'core'), path.join(d, '.agents/scripts/core'), { recursive: true });
  appendFileSync(path.join(d, '.git/info/exclude'), '.agents/scripts/proofline-core.mjs\n.agents/scripts/core/\n.agents/local/\n');
  return d;
}
/** The shell scenarios' `unfrozen CLASS`: standalone, manual, not frozen. @param {string} cls @param {import('../lib/harness.mjs').ScaffoldOptions} [o] */
export const unfrozen = (cls, o = {}) => proj({ topology: 'standalone', cls, autonomy: 'manual', ...o });

/** `A` of the shell library: freeze and refreeze bind the QA plan to the PLAN first. @param {string} d @param {string[]} args @param {Parameters<typeof A>[2]} [o] */
export const a = (d, args, o = {}) => A(d, args, { bind: true, ...o, env: { CLAUDE_CODE_SESSION_ID: 's1', ...(o.env ?? {}) } });
/** `A ... | grep -q PATTERN` etc.: stdout and stderr text of a call. @param {string} d @param {string[]} args @param {Parameters<typeof A>[2]} [o] */
export const text = (d, args, o = {}) => a(d, args, o).text;

/** The implemented state of the shell `implemented ORCH|SOLO`. @param {string} d @param {'orchestrated' | 'standalone'} topo */
export function implemented(d, topo) {
  const step = topo === 'orchestrated' ? worker : solo;
  step(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  step(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
}
/** The file names of a run folder (sorted). @param {string} d @param {string} sub */
export const ls = (d, sub) => (existsSync(path.join(d, '.agents/runs/LC', sub)) ? readdirSync(path.join(d, '.agents/runs/LC', sub)).sort() : []);
/** A run file. @param {string} d @param {string} f */
export const rf = (d, f) => readFileSync(path.join(d, '.agents/runs/LC', f), 'utf8');
/** Write a run file. @param {string} d @param {string} f @param {string} t */
export const wf = (d, f, t) => writeFileSync(path.join(d, '.agents/runs/LC', f), t);
/** Narrow max_scope_paths of the STANDARD class in the project's config. @param {string} d @param {number} n */
export function narrow(d, n) {
  const f = path.join(d, '.agents/config.yaml');
  let s = false;
  const out = readFileSync(f, 'utf8').split('\n').map((l) => {
    if (/^ {2}STANDARD:/.test(l)) s = true;
    if (s && /max_scope_paths:/.test(l)) { s = false; return l.replace(/[0-9]+/, String(n)); }
    return l;
  });
  writeFileSync(f, out.join('\n'));
}

/**
 * `answer` the way the prompt hook runs it: in process with the user's message handed over (the user's words recorded as the user's).
 * @param {string} d @param {string[]} args @param {{ text: string, time?: number }} m
 */
export function hookAnswer(d, args, m) {
  const time = m.time ?? now() + 1;
  const stored = storePrompt(`${d}/.agents/local`, 's1', time, m.text);
  if (!stored) throw new Error('capture not stored');
  /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
  const io = { env: cleanEnv({}), cwd: d, scriptPath: `${d}/.agents/scripts/proofline-core.mjs`, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) }, promptCapture: { session: 's1', time, sha256: stored.sha256, text: m.text } };
  const status = runCore(args, /** @type {any} */ (io));
  return { status, text: Buffer.concat([...out, ...err]).toString() };
}
export const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
