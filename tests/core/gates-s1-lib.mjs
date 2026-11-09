// @ts-check
// Helpers of tests/core/gates-s1.test.mjs (gates-test.sh scenarios sc_record .. sc_question_language). Only what harness.mjs does not have.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { A, AS, cleanEnv, gateOwner, must, resultFor, solo, worker } from '../lib/harness.mjs';

/** @typedef {import('../lib/harness.mjs').Result} Result */

/** `A` without waiting: the child runs while the caller starts more (the parallel scenarios). @param {string} dir @param {string[]} args @param {{ role?: string, env?: Record<string, string> }} [o] @returns {Promise<Result>} */
export function Aasync(dir, args, o = {}) {
  const env = cleanEnv({ ...(o.role ? { AGENT_ROLE: o.role } : {}), ...(o.env ?? {}) });
  return new Promise((resolve) => {
    const c = spawn('sh', ['.agents/scripts/agent.sh', ...args], { cwd: dir, env: /** @type {NodeJS.ProcessEnv} */ (env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (status) => resolve({ status, out, err, text: out + err }));
  });
}

/** `rec` that does not throw: the result file for the gate recorded as its owner, the answer of `record` returned. @param {string} dir @param {string} gate @param {string} res @param {string[]} [rows] @param {Parameters<typeof resultFor>[4]} [opt] */
export function recTry(dir, gate, res, rows = [], opt = {}) {
  return AS(dir, gateOwner(gate), ['record', 'LC', '--file', resultFor(dir, gate, res, rows, opt)]);
}

/** Number of gate records of LC (`n_gates`). @param {string} dir */
export const nGates = (dir) => lsDir(dir, '.agents/runs/LC/gates').filter((n) => n.endsWith('.yaml')).length;

/** File names in a project folder (empty when it does not exist). @param {string} dir @param {string} rel */
export function lsDir(dir, rel) { const p = path.join(dir, rel); return existsSync(p) ? readdirSync(p).sort() : []; }

/** The text of every gate record of a gate (what `grep -q ... gates/*-GATE.yaml` looked at). @param {string} dir @param {string} gate */
export function gateText(dir, gate) {
  return lsDir(dir, '.agents/runs/LC/gates').filter((n) => n.endsWith(`-${gate}.yaml`)).map((n) => readFileSync(path.join(dir, '.agents/runs/LC/gates', n), 'utf8')).join('\n');
}

/** RED then GREEN, then handoff IMPLEMENTED (`implemented`). @param {string} dir @param {'orchestrated' | 'standalone'} topology */
export function implemented(dir, topology) {
  const step = topology === 'orchestrated' ? worker : solo;
  step(dir, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  step(dir, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(dir, ['handoff', 'LC', 'IMPLEMENTED']);
}

/** Lines of a text that start with a prefix. @param {string} text @param {string} prefix */
export const linesWith = (text, prefix) => text.split('\n').filter((l) => l.startsWith(prefix));

/** chmod -R on a tree. @param {string} p @param {boolean} writable */
export function chmodTree(p, writable) {
  const st = readdirSync(p, { withFileTypes: true });
  for (const e of st) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) { if (!writable) chmodTree(f, false); else { chmodSync(f, 0o755); chmodTree(f, true); } chmodSync(f, writable ? 0o755 : 0o555); } else chmodSync(f, writable ? 0o644 : 0o444);
  }
  chmodSync(p, writable ? 0o755 : 0o555);
}

export { A, AS };
