// @ts-check
// Timeouts (A202 item 29, agent.sh lines 182-254) and the hook knobs: one multiplier for every duration. All functions are pure
// functions of the config. Numbers are exact integers (BigInt where the shell multiplies); a value the shell would read in an
// implementation-specific way throws BridgeToShell before anything has been printed.
import { BridgeToShell } from './errors.mjs';
import { dec0, smallInt } from './config.mjs';

const DIGITS = /^[0-9]+$/;

/**
 * `tm_scale_milli`: timeouts.scale times 1000, between 500 and 10000, else 1000.
 * @param {import('./config.mjs').Config} cfg
 */
export function tmScaleMilli(cfg) {
  const v = cfg.get('timeouts.scale', '1');
  const dot = v.indexOf('.');
  let ip = dot < 0 ? v : v.slice(0, dot);
  let fp = dot < 0 ? '0' : v.slice(dot + 1);
  if (!DIGITS.test(ip + fp) ) return 1000;
  if (ip === '') ip = '0';
  if (fp === '') fp = '0';
  if (ip.length > 12) throw new BridgeToShell(`timeouts.scale too long: ${v}`);
  fp = `${fp}000`.slice(0, 3);
  const milli = Number(dec0(ip)) * 1000 + Number(dec0(fp));
  return milli >= 500 && milli <= 10000 ? milli : 1000;
}

/** `tm_scale`: the scale as awk prints m / 1000 (%.6g). @param {import('./config.mjs').Config} cfg */
export function tmScale(cfg) { return String(Number((tmScaleMilli(cfg) / 1000).toPrecision(6))); }

/**
 * `tm_scaled N [MIN [MAX]]`: N seconds times the scale, rounded up, kept between MIN and MAX.
 * @param {import('./config.mjs').Config} cfg @param {string|number} n digits @param {number} [lo] @param {number} [hi]
 */
export function tmScaled(cfg, n, lo = 1, hi = 28800) {
  const ds = dec0(String(n));
  if (!DIGITS.test(ds) || ds.length > 12) throw new BridgeToShell(`tm_scaled argument: ${ds}`);
  let x = (BigInt(ds) * BigInt(tmScaleMilli(cfg)) + 999n) / 1000n;
  if (x < BigInt(lo)) x = BigInt(lo);
  if (x > BigInt(hi)) x = BigInt(hi);
  return Number(x);
}

/** `tm_warn_percent`: 50 to 95, default 80. @param {import('./config.mjs').Config} cfg */
export function tmWarnPercent(cfg) {
  const s = dec0(cfg.get('timeouts.warn_percent', '80'));
  let v = DIGITS.test(s) ? smallInt(s) : 80;
  if (v < 50) v = 50;
  if (v > 95) v = 95;
  return v;
}

/**
 * `hook_knob KEY DEFAULT MIN MAX`: the configured number moved into its bounds (a non-number is the default).
 * @param {import('./config.mjs').Config} cfg @param {string} key @param {number} def @param {number} min @param {number} max
 */
export function hookKnob(cfg, key, def, min, max) {
  const s = dec0(cfg.get(`hook.${key}`, String(def)));
  let v = DIGITS.test(s) ? smallInt(s) : def;
  if (v < min) v = min;
  if (v > max) v = max;
  return v;
}

/** `verify_command_timeout`. @param {import('./config.mjs').Config} cfg */
export function verifyCommandTimeout(cfg) {
  const s = dec0(cfg.get('verification.command_timeout_seconds', '1800'));
  let v = DIGITS.test(s) ? smallInt(s) : 1800;
  if (v < 60) v = 60;
  if (v > 28800) v = 28800;
  return tmScaled(cfg, v, 60, 28800);
}

const HOOK_EVENTS = [
  ['session', 'session', 30], ['prompt', 'prompt', 30], ['pretool', 'pretool', 30], ['posttool', 'posttool', 30],
  ['subagent-start', 'subagent_start', 60], ['subagent-stop', 'subagent_stop', 120], ['stop', 'stop', 30],
];

/** `hook_timeouts`: `event=seconds` lines. @param {import('./config.mjs').Config} cfg @returns {string[]} */
export function hookTimeouts(cfg) {
  const ab = hookKnob(cfg, 'approve_budget_seconds', 20, 5, 25);
  /** @type {string[]} */ const out = [];
  for (const [name, key, def] of HOOK_EVENTS) {
    const s = dec0(cfg.get(`hook.${key}_timeout_seconds`, String(def)));
    let v = DIGITS.test(s) ? smallInt(s) : Number(def);
    if (v < 10) v = 10;
    if (v > 600) v = 600;
    v = tmScaled(cfg, v, 10, 600);
    if (name === 'prompt' && v < ab + 5) v = ab + 5;
    out.push(`${name}=${v}`);
  }
  return out;
}

/** `tm_dispatch_seconds [CLASS]`. @param {import('./config.mjs').Config} cfg @param {string} cls */
export function tmDispatchSeconds(cfg, cls) {
  let t = cfg.get('dispatch.timeout_seconds', '5400');
  if (!DIGITS.test(t)) t = '5400';
  if (cls === 'TRIVIAL' || cls === 'STANDARD' || cls === 'COMPLEX' || cls === 'CRITICAL') {
    const c = cfg.get(`pipelines.${cls}.dispatch_timeout_seconds`, '');
    if (DIGITS.test(c)) t = c;
  }
  return tmScaled(cfg, t, 30, 28800);
}

/** `batch_minutes KEY DEFAULT`. @param {import('./config.mjs').Config} cfg @param {string} key @param {number} def */
export function batchMinutes(cfg, key, def) {
  let v = cfg.get(key, String(def));
  if (!DIGITS.test(v)) v = String(def);
  return tmScaled(cfg, v, 1, 720);
}

/** `timeouts_info`: every duration this install uses, as `name=seconds` lines. @param {import('./config.mjs').Config} cfg @returns {string[]} */
export function timeoutsInfo(cfg) {
  /** @type {string[]} */ const o = [];
  o.push(`scale=${tmScale(cfg)}`, `warn_percent=${tmWarnPercent(cfg)}`);
  o.push(`dispatch.default=${tmDispatchSeconds(cfg, '')}`);
  for (const c of ['TRIVIAL', 'STANDARD', 'COMPLEX', 'CRITICAL']) o.push(`dispatch.${c}=${tmDispatchSeconds(cfg, c)}`);
  const sb = cfg.get('tasks.status_block_seconds', '20');
  if (!DIGITS.test(sb)) throw new BridgeToShell(`tasks.status_block_seconds: ${sb}`); // the shell's arithmetic error text
  o.push(`verification.command=${verifyCommandTimeout(cfg)}`, `lock=${tmScaled(cfg, 120, 1, 3600)}`, `status_block=${tmScaled(cfg, sb, 1, 900)}`);
  o.push(`batch.ci_wait_minutes=${batchMinutes(cfg, 'batch.ci_wait_minutes', 30)}`, `batch.ci_appear_minutes=${batchMinutes(cfg, 'batch.ci_appear_minutes', 10)}`);
  o.push(`hook.approve_budget=${hookKnob(cfg, 'approve_budget_seconds', 20, 5, 25)} (never scaled)`, `hook.next_budget=${hookKnob(cfg, 'next_budget_seconds', 10, 2, 20)}`, `hook.lock_wait=${hookKnob(cfg, 'lock_wait_seconds', 8, 1, 20)}`);
  for (const l of hookTimeouts(cfg)) o.push(`hook.timeout.${l}`);
  return o;
}
