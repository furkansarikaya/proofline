// @ts-check
// Helpers shared by tests/enforcement/enforcement-a*.test.mjs (176-C1): the hook events the legacy enforcement scenarios sent beyond lib.mjs, the
// fixture verbs of the self-test library (state building only) and small file/clock helpers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
/** @param {number} ms */
export function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
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
