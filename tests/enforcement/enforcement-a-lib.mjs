// @ts-check
// Helpers shared by tests/enforcement/enforcement-a*.test.mjs (176-C1): the hook events the legacy enforcement scenarios sent beyond lib.mjs, the
// fixture verbs of the self-test library (state building only) and small file/clock helpers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { A, accepted, cleanEnv, tmp } from '../lib/harness.mjs';
import { verbs } from '../core/legacy-lib.mjs';
import { Hr } from './lib.mjs';

export { A, tmp };
export { AS, expectMsg, refused, capture } from '../lib/harness.mjs';
/** The shell's `case "${TMPDIR:-}" in ''|/tmp|/tmp/*|/private/tmp|/private/tmp/*) skip`: the scratch rules are only testable with a TMPDIR of its own. */
export const tmpdirOwn = !/^(?:|\/tmp(?:\/.*)?|\/private\/tmp(?:\/.*)?)$/.test(process.env.TMPDIR ?? '');
/** The TMPDIR the hook sees (cleanEnv). */
export const hookTmpdir = cleanEnv({}).TMPDIR ?? '';

/** Fixture verbs of the self-test library (worker, wev, to_code_done ...) run in the project; throws when they fail. @param {string} dir @param {string} snippet */
export function V(dir, snippet) { return accepted(verbs(dir, snippet), snippet.slice(0, 80)); }
/**
 * The records of the project happened `secs` seconds earlier. The control plane orders a request and the user's reply by whole seconds (a reply must be strictly newer than
 * the request it answers, a new request strictly newer than the reply it follows), and the shell suites slept a second to get there. The stored seconds are moved back
 * instead, consistently: `requested_at` of the requests, `time` of the captures, `capture_time` and the time inside `capture_id` of the approvals made from them, and the stamps of the duplicate guard of the hook. Nothing waits.
 * @param {string} dir @param {number} [secs]
 */
export function recordsAge(dir, secs = 5) {
  /** @param {string} f @param {(t: string) => string} fn */
  const edit = (f, fn) => { const t = readFileSync(f, 'utf8'); const u = fn(t); if (u !== t) writeFileSync(f, u); };
  /** @param {string} d @param {RegExp} re @param {(t: string) => string} fn */
  const each = (d, re, fn) => { if (existsSync(d)) for (const n of readdirSync(d)) if (re.test(n) && statSync(path.join(d, n)).isFile()) edit(path.join(d, n), fn); };
  const back = (/** @type {string} */ x) => String(Number(x) - secs);
  const runs = path.join(dir, '.agents/runs');
  const approvals = [path.join(dir, '.agents/local/approvals'), ...(existsSync(runs) ? readdirSync(runs).map((r) => path.join(runs, r, 'approvals')) : [])];
  for (const a of approvals) {
    each(a, /-request-.*\.yaml$/, (t) => t.replace(/^requested_at: (\d+)/m, (_, x) => `requested_at: ${back(x)}`));
    each(a, /\.yaml$/, (t) => t.replace(/^capture_time: (\d+)/m, (_, x) => `capture_time: ${back(x)}`).replace(/^capture_id: "([^":]*):(\d+):/m, (_, s, x) => `capture_id: "${s}:${back(x)}:`));
  }
  // the stamps with which the hook recognises the same event delivered twice (it runs a copy that starts within two seconds of the first once)
  each(path.join(dir, '.agents/local/hooklock'), /^[a-z-]+\.[0-9a-f]{16}$/, (t) => (/^\d+\s*$/.test(t) ? `${back(t.trim())}\n` : t));
  const prompts = path.join(dir, '.agents/local/prompts');
  each(prompts, /\.json$/, (t) => t.replace(/"time":(\d+)/, (_, x) => `"time":${back(x)}`));
  each(path.join(prompts, 'history'), /\.json$/, (t) => t.replace(/"time":(\d+)/, (_, x) => `"time":${back(x)}`));
}
/**
 * The capture of the session is stamped one second after the newest gate record of the run: newer than the finding a waiver answers, never more than a second ahead of the clock
 * (the control plane ignores a capture more than 5 s ahead). A gate record cannot be moved back (its content is checked), so the capture is moved forward instead of waiting.
 * @param {string} dir @param {string} session
 */
export function captureAfterGates(dir, session) {
  const gates = path.join(dir, '.agents/runs/LC/gates');
  const newest = Math.max(0, ...readdirSync(gates).map((n) => Number(/^epoch: (\d+)/m.exec(readFileSync(path.join(gates, n), 'utf8'))?.[1] ?? 0)));
  const f = path.join(dir, '.agents/local/prompts', `${session}.json`);
  writeFileSync(f, readFileSync(f, 'utf8').replace(/"time":\d+/, `"time":${newest + 1}`));
}
/** `$(...)` strips trailing newlines. @param {string} s */
export const chomp = (s) => s.replace(/\n+$/, '');
/** git in the project (hardened environment); the result with status and text. @param {string} dir @param {string[]} args @param {Record<string, string>} [env] */
export function gitR(dir, args, env = {}) {
  const r = spawnSync('git', args, { cwd: dir, env: cleanEnv(env), encoding: 'utf8' });
  return { status: r.status, text: (r.stdout ?? '') + (r.stderr ?? '') };
}
/** Names in a directory matching a pattern (sorted), or []. @param {string} dir @param {RegExp} re */
export function ls(dir, re) { return existsSync(dir) ? readdirSync(dir).filter((n) => re.test(n)).sort() : []; }
/** @param {string} dir @param {string} rel */
export const rd = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');

/** `post`/`stop`/`session` events with a free body. @param {string} dir @param {string} text @param {boolean} [active] */
export function stopPlain(dir, text, active = false) {
  return Hr(dir, 'stop', JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: dir, stop_hook_active: active, last_assistant_message: text })).stdout;
}
/** `prompt` with an environment (AGENT_ROLE), as the dispatched specialist's hook sees it. @param {string} dir @param {string} text @param {string} [session] @param {Record<string, string>} [env] */
export function promptEnv(dir, text, session = 's1', env = {}) {
  return Hr(dir, 'prompt', JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: dir, prompt: text }), { env }).stdout;
}
/** @param {string} out @param {RegExp | string} re @param {string} msg */
export const matches = (out, re, msg) => assert.ok(typeof re === 'string' ? out.includes(re) : re.test(out), `${msg}: ${out.slice(0, 500)}`);
/** @param {string} out @param {RegExp | string} re @param {string} msg */
export const lacks = (out, re, msg) => assert.ok(!(typeof re === 'string' ? out.includes(re) : re.test(out)), `${msg}: ${out.slice(0, 500)}`);
/** The task branch the way `agent.sh branch` leaves it. @param {string} dir */
export function taskBranch(dir) {
  const f = path.join(dir, '.agents/runs/LC/RUN.yaml');
  const out = [];
  for (const l of readFileSync(f, 'utf8').split('\n')) { out.push(l); if (l.startsWith('  base_sha:')) out.push('  task_branch: proofline/LC-lookup'); }
  writeFileSync(f, out.join('\n'));
  gitR(dir, ['checkout', '-q', '-b', 'proofline/LC-lookup']);
}

// lib.mjs documents several parameters on one JSDoc line, which the checker reads as required ones: typed views of the same functions
import * as lib from './lib.mjs';
/** @typedef {{ env?: Record<string, string> }} EnvOpt */
export const preEdit = /** @type {(dir: string, tool: string, file: string, type?: string, id?: string, o?: EnvOpt) => string} */ (lib.preEdit);
export const preBash = /** @type {(dir: string, command: string, type?: string, id?: string, o?: EnvOpt) => string} */ (lib.preBash);
export const subStart = /** @type {(dir: string, type: string, id?: string) => string} */ (lib.subStart);
export const subStop = /** @type {(dir: string, type: string, id: string, stopHookActive?: boolean) => string} */ (lib.subStop);
export const prompt = /** @type {(dir: string, text: string, session?: string) => string} */ (lib.prompt);
export const denied = /** @type {(label: string, out: string, sub?: string) => void} */ (lib.denied);
export const fixture = /** @type {(o?: { klass?: string, auto?: string, extra?: string, hook?: boolean }) => string} */ (lib.fixture);
