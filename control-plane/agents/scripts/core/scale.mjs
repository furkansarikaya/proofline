// @ts-check
// Slow-machine setting for the time limits (A202 item 29, A230; the former bin/lib/timeouts.sh). One multiplier, timeouts.scale, stretches every duration together
// (docs/concepts/timeouts.md). `proofline doctor` measures how long this machine takes for two things it does all the time, proposes a value, and writes it only after the
// user's own reply "approve scale" (an approval kind like `commands`: bound to the sha256 of the proposal file, consumed on apply).
//   proofline doctor --scale          measure, record the proposal (.agents/local/scale/PROPOSAL.tsv) and ask
//   proofline doctor --apply-scale    write the proposal after the user's reply (`scale-check` decides, from the user's own message)
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { agentCall } from './batch.mjs';
import { Config } from './config.mjs';
import { cfgSet } from './configset.mjs';
import { ProoflineError } from './errors.mjs';
import { sha256File } from './hash.mjs';
import * as proc from './proc.mjs';
import { hookTimeouts } from './timeouts.mjs';

/** @typedef {import('./context.mjs').Context} Context */

// Reference times of the two measurements, in ms, on a development laptop under a load average of about 15 (a quiet machine is faster, so a proposal errs low rather than
// high): the approval path (content fingerprint + the approval step with nothing to approve) and an `agent.sh config-check` (a start of agent.sh). Measured time divided by
// their sum is how many times slower this machine is.
export const REF_APPROVAL_MS = 500;
export const REF_START_MS = 250;

/** @param {Context} ctx */
const dirOf = (ctx) => `${ctx.root}/.agents/local/scale`;
/** @param {string} msg */
const die = (msg) => new ProoflineError(`proofline: ${msg}`, 1);
/** @param {Context} ctx @param {string} line */
function say(ctx, line) { ctx.out(`${line}\n`); ctx.flush(); }

/**
 * `ts_suggest`: the proposed scale, or '' when this machine is not slow. The ratio of measured to reference time, rounded up to a half, at least 1.5 (below that the default
 * 1.0 fits) and at most 10 (the bound of timeouts.scale).
 * @param {number} approvalMs @param {number} startMs
 */
export function suggestScale(approvalMs, startMs) {
  const r = (approvalMs + startMs) / (REF_APPROVAL_MS + REF_START_MS);
  let x = Math.trunc(r * 2);
  if (x < r * 2) x++;
  x /= 2;
  if (x < 1.5) return '';
  if (x > 10) x = 10;
  return String(x);
}

/**
 * `ts_measure`: [approval ms, start ms] for this machine, best of two runs each (a single cold run measures the disk cache, not the machine). The runs are real starts of the
 * project's `agent.sh` (launcher and Node included): that is what the time limits have to cover.
 * @param {Context} ctx @returns {[number, number]}
 */
export function measureMachine(ctx) {
  const a = `${ctx.root}/.agents/scripts/agent.sh`;
  /** @param {string[][]} steps */
  const timed = (steps) => {
    const t0 = Date.now();
    for (const s of steps) proc.run('sh', [a, ...s], { cwd: ctx.root, env: ctx.env, stdio: 'ignore' });
    return Date.now() - t0;
  };
  let bestA = -1; let bestS = -1;
  for (let i = 0; i < 2; i++) {
    const ta = timed([['fingerprint'], ['approve-pending', '-']]);
    if (bestA < 0 || ta < bestA) bestA = ta;
    const ts = timed([['config-check']]);
    if (bestS < 0 || ts < bestS) bestS = ts;
  }
  return [bestA, bestS];
}

/** `ts_propose`: measure, write the proposal and ask the one question. @param {Context} ctx @returns {number} */
export function proposeScale(ctx) {
  const [a, s] = measureMachine(ctx);
  const cur = Config.load(`${ctx.root}/.agents/config.yaml`).get('timeouts.scale', '1.0');
  const v = suggestScale(a, s);
  const dir = dirOf(ctx);
  say(ctx, `timing: approval path ${a} ms (reference ${REF_APPROVAL_MS}), agent.sh start ${s} ms (reference ${REF_START_MS}); timeouts.scale is ${cur} now`);
  if (v === '') {
    rmSync(`${dir}/PROPOSAL.tsv`, { force: true });
    say(ctx, `scale: this machine is not slow (within 1.5 times the reference); timeouts.scale ${cur} fits, nothing to change`);
    return 0;
  }
  if (v === cur || v === cur.replace(/\.0$/, '')) { say(ctx, `scale: the measured value ${v} is the one set already`); return 0; }
  mkdirSync(dir, { recursive: true });
  const f = `${dir}/PROPOSAL.tsv`;
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `scale\t${v}\n`);   // no time and no measurement in the file: the user's reply is bound to the value alone
  renameSync(tmp, f);
  say(ctx, '');
  say(ctx, `scale proposal ${sha256File(f).slice(0, 12)}: timeouts.scale ${cur} -> ${v} (every step time, build and test limit, lock wait and hook limit grows by that factor; the approval budget does not)`);
  say(ctx, `QUESTION (one): write timeouts.scale: ${v} into .agents/config.yaml? Reply "approve scale". Nothing is written without your reply.`);
  const r = agentCall(ctx, ['request-approval', '-', 'scale']);
  ctx.out(r.out); ctx.err(r.err);
  if (r.status !== 0) say(ctx, '(the approval request could not be recorded: run agent.sh request-approval - scale)');
  say(ctx, '  after your reply: proofline doctor --apply-scale');
  return 0;
}

const EVENT_NAMES = { session: 'SessionStart', prompt: 'UserPromptSubmit', pretool: 'PreToolUse', posttool: 'PostToolUse', 'subagent-start': 'SubagentStart', 'subagent-stop': 'SubagentStop', stop: 'Stop' };

/**
 * `hook_timeouts_apply` (A202 item 29): sets the `timeout` of every proofline hook in REL (.claude/settings.json, .codex/hooks.json) to the value the project's config gives
 * (hook.<event>_timeout_seconds times timeouts.scale, bounded). Only the `timeout` of a hook whose command names proofline-hook.mjs is touched; every other key, hook and setting
 * stays as it was. Idempotent: a file that already holds the values is not rewritten. The config is the one place to change a hook limit.
 * @param {string} root the project @param {string} rel @returns {{ state: 'same' | 'merged' | 'warn' | 'absent', text: string }}
 */
export function applyHookTimeouts(root, rel) {
  const file = `${root}/${rel}`;
  if (!existsSync(file)) return { state: 'absent', text: '' };
  if (!existsSync(`${root}/.agents/scripts/agent.sh`)) return { state: 'absent', text: '' };
  /** @type {Record<string, number>} */ const t = {};
  for (const row of hookTimeouts(Config.load(`${root}/.agents/config.yaml`))) {
    const [name, value] = row.split('=');
    const ev = /** @type {Record<string, string>} */ (EVENT_NAMES)[name];
    if (ev !== undefined && /^[0-9]+$/.test(value ?? '')) t[ev] = Number(value);
  }
  if (Object.keys(t).length === 0) return { state: 'absent', text: '' };
  /** @type {any} */ let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { return { state: 'warn', text: `${rel}: hook timeouts not set (invalid JSON)` }; }
  const before = JSON.stringify(j);
  if (j && typeof j.hooks === 'object' && j.hooks) {
    for (const [ev, groups] of Object.entries(j.hooks)) {
      if (!Array.isArray(groups) || t[ev] === undefined) continue;
      for (const g of groups) if (g && Array.isArray(g.hooks)) for (const h of g.hooks) if (h && /proofline-hook[.]mjs/.test(String(h.command ?? ''))) h.timeout = t[ev];
    }
  }
  if (JSON.stringify(j) === before) return { state: 'same', text: `${rel} (hook timeouts)` };
  writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
  return { state: 'merged', text: `${rel} (hook timeouts from the config; other settings kept)` };
}

/** `ts_apply`: write the proposal when `scale-check` says the user agreed, then put the new hook limits into the settings files. @param {Context} ctx @returns {number} */
export function applyScale(ctx) {
  const f = `${dirOf(ctx)}/PROPOSAL.tsv`;
  let ok = false;
  try { ok = statSync(f).size > 0; } catch { ok = false; }
  if (!ok) throw die('doctor --apply-scale: no scale proposal (run: proofline doctor --scale)');
  const chk = agentCall(ctx, ['scale-check']);
  ctx.err(chk.err);
  if (chk.status !== 0) throw die('doctor --apply-scale: the user has not agreed to this proposal yet; ask the one question and wait for the reply "approve scale"');
  const row = readFileSync(f, 'latin1').split('\n').map((l) => l.split('\t')).find((r) => r[0] === 'scale');
  const v = row?.[1] ?? '';
  if (v === '' || /[^0-9.]/.test(v)) throw die('doctor --apply-scale: the proposal holds no valid scale');
  // the approval is used up before anything is written: the same proposal cannot be applied twice from one reply
  if (agentCall(ctx, ['approval-consume', '-', 'scale']).status !== 0) throw die('doctor --apply-scale: the scale approval could not be consumed, so nothing was written');
  if (!cfgSet(`${ctx.root}/.agents/config.yaml`, 'timeouts.scale', v)) throw die('config key not set: timeouts.scale');
  say(ctx, `wrote timeouts.scale: ${v}`);
  renameSync(f, `${dirOf(ctx)}/applied-${Math.floor(Date.now() / 1000)}.tsv`);
  const cc = agentCall(ctx, ['config-check']);
  ctx.out(cc.out); ctx.err(cc.err);
  if (cc.status !== 0) throw die('the written scale does not pass agent.sh config-check; fix .agents/config.yaml');
  for (const rel of ['.claude/settings.json', '.codex/hooks.json']) applyHookTimeouts(ctx.root, rel);
  return 0;
}
