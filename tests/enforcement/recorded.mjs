// @ts-check
// Replay of RECORDED hook corpora against the Node hook. A corpus (tests/enforcement/recorded/enforcement-<scenario>.json) is the sequence of hook
// calls of one scenario of the legacy enforcement suite, recorded once from the shell hook (the specification) together with the verdict it gave
// and the text its suite asserted. Nothing is compared with a shell at test time: the recorded verdict (deny / allow / block) and the recorded
// reason text are literals. <P> stands for the project folder, <B> for the scratch folder that holds everything outside it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runHook } from '../hook/harness.mjs';

/** @typedef {{ ev: string, rt: string, env: Record<string, string>, payload: string, verdict: 'deny' | 'allow' | 'block', assert?: string, label?: string, sub?: string, not?: string }} Step */

/** @param {string} scenario @returns {Step[]} */
export function corpus(scenario) {
  return JSON.parse(readFileSync(new URL(`./recorded/enforcement-${scenario}.json`, import.meta.url), 'utf8'));
}

/** @param {string} stdout @returns {'deny' | 'block' | 'allow'} */
function verdictOf(stdout) {
  if (stdout.includes('"permissionDecision":"deny"')) return 'deny';
  if (stdout.includes('"decision":"block"')) return 'block';
  return 'allow';
}

/** The text a deny or block shows: the JSON-decoded reason, or the raw output when it cannot be decoded. @param {string} stdout */
function reasonOf(stdout) {
  try {
    const j = JSON.parse(stdout);
    return `${j?.hookSpecificOutput?.permissionDecisionReason ?? ''}\n${j?.reason ?? ''}\n${stdout}`;
  } catch { return stdout; }
}

/**
 * Run a corpus against the Node hook in a project. Steps run one by one, or in parallel runs of independent pretool calls between the steps
 * that change state (the first step, a mutation point, any event that is not a PreToolUse call). Every difference is collected and reported at once.
 * @param {{ steps: Step[], dir: string, base: string, mutations?: Record<number, () => void>, after?: Record<number, () => void>, skip?: number[], only?: [number, number] }} o
 */
export async function replay(o) {
  const { steps, dir, base, mutations = {}, after = {}, skip = [] } = o;
  const [from, to] = o.only ?? [0, steps.length];
  const tmp = join(base, 'tmpdir');
  mkdirSync(tmp, { recursive: true });
  /** @param {string} s */
  const sub = (s) => s.split('<P>').join(dir).split('<B>').join(base);
  /** @type {string[]} */ const failures = [];
  /** @param {number} i */
  const one = async (i) => {
    const s = /** @type {Step} */ (steps[i]);
    /** @type {Record<string, string>} */ const env = { TMPDIR: tmp };
    for (const [k, v] of Object.entries(s.env)) {
      if (k === 'PATH_PREFIX') env.PATH = `${sub(v)}:${process.env.PATH}`;
      else env[k] = sub(v);
    }
    const r = await runHook('node', dir, s.ev, sub(s.payload), { env, runtime: s.rt });
    const got = verdictOf(r.stdout);
    const name = s.label ?? `step ${i}`;
    if (got !== s.verdict) { failures.push(`${name}: expected ${s.verdict}, got ${got}: ${r.stdout.slice(0, 300)}${r.stderr.slice(0, 200)}`); return; }
    if (s.not !== undefined && reasonOf(r.stdout).includes(sub(s.not))) failures.push(`${name}: the output carries "${s.not}": ${r.stdout.slice(0, 300)}`);
    if (s.sub !== undefined && !reasonOf(r.stdout).includes(sub(s.sub))) failures.push(`${name}: ${got} for another reason (wanted "${sub(s.sub)}"): ${r.stdout.slice(0, 400)}`);
  };
  /** @type {number[]} */ let batch = [];
  const flush = async () => {
    for (let k = 0; k < batch.length; k += 8) await Promise.all(batch.slice(k, k + 8).map(one));
    batch = [];
  };
  for (let i = from; i < to; i++) {
    const s = /** @type {Step} */ (steps[i]);
    if (skip.includes(i)) { if (mutations[i]) { await flush(); mutations[i](); } continue; }
    const barrier = i === from || mutations[i] !== undefined || after[i] !== undefined || s.ev !== 'pretool' || !s.assert;
    if (barrier) await flush();
    if (mutations[i]) mutations[i]();
    if (barrier) { await one(i); after[i]?.(); } else batch.push(i);
  }
  await flush();
  assert.equal(failures.length, 0, `${failures.length} of ${to - from} recorded calls differ:\n${failures.join('\n')}`);
}
