// @ts-check
// The forecast at plan approval (A364, issue 338 C4): what finished runs of the same class took in this project, from `.agents/local/metrics/records.jsonl`. Informational only: it
// gates nothing and asks for no approval. No clock; the one file read is `readTail`, bounded to the last 2 MB.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export const TAIL_BYTES = 2 * 1024 * 1024;

/** The last TAIL_BYTES of a records file as text, a partial first line dropped; '' when the file is absent or unreadable. @param {string} file */
export function readTail(file) {
  let fd = -1;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const n = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) { const r = readSync(fd, buf, got, n - got, size - n + got); if (r <= 0) break; got += r; }
    let text = buf.subarray(0, got).toString('latin1');
    if (size > n) { const nl = text.indexOf('\n'); text = nl < 0 ? '' : text.slice(nl + 1); }
    return text;
  } catch { return ''; } finally { if (fd >= 0) try { closeSync(fd); } catch { /* ignore */ } }
}

/** Nearest-rank quantile (q in 0..1) of a list of numbers; null for an empty list. @param {number[]} values @param {number} q */
export function quantile(values, q) {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.max(0, Math.min(v.length - 1, Math.ceil(q * v.length) - 1))];
}

const num = (/** @type {unknown} */ x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
/** @param {number | null} s */
const hours = (s) => (s === null ? 'n/a' : `${(s / 3600).toFixed(1)} h`);
/** @param {number | null} s */
const minutes = (s) => (s === null ? 'n/a' : `${Math.round(s / 60)} min`);
/** @param {number | null} n */
const tokens = (n) => (n === null ? 'n/a' : n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

/**
 * The forecast rows for a class: median and p90 of the wall time of the finished runs (`run` records with result `done` and that class), and of the agent time and tokens of the
 * `step` or `dispatch` records of the same tasks (the larger of the two kinds, so a step that has both is not counted twice).
 * @param {string} text the records file @param {string} cls
 */
export function forecastRows(text, cls) {
  /** @type {Array<Record<string, unknown>>} */ const recs = [];
  for (const l of text.split('\n')) {
    if (!l.startsWith('{')) continue;
    try { const o = JSON.parse(l); if (o !== null && typeof o === 'object') recs.push(o); } catch { /* a damaged line is no history */ }
  }
  const runs = recs.filter((r) => r.kind === 'run' && r.class === cls && r.result === 'done' && num(r.duration_s) !== null);
  if (runs.length === 0) return `   forecast: no history for ${cls} (no finished ${cls} run is recorded in this project yet)\n`;
  const tasks = new Set(runs.map((r) => String(r.task)));
  /** @type {Map<string, { step: [number, number], dispatch: [number, number] }>} */ const by = new Map();
  for (const r of recs) {
    if ((r.kind !== 'step' && r.kind !== 'dispatch') || !tasks.has(String(r.task))) continue;
    const e = by.get(String(r.task)) ?? { step: [0, 0], dispatch: [0, 0] };
    const k = r.kind === 'step' ? e.step : e.dispatch;
    k[0] += num(r.duration_s) ?? 0;
    k[1] += num(r.tokens_total) ?? ((num(r.tokens_in) ?? 0) + (num(r.tokens_out) ?? 0));
    by.set(String(r.task), e);
  }
  const wall = runs.map((r) => /** @type {number} */ (num(r.duration_s)));
  const agent = [...by.values()].map((e) => Math.max(e.step[0], e.dispatch[0])).filter((x) => x > 0);
  const tok = [...by.values()].map((e) => Math.max(e.step[1], e.dispatch[1])).filter((x) => x > 0);
  const both = (/** @type {number[]} */ v, /** @type {(n: number | null) => string} */ f) => `median ${f(quantile(v, 0.5))}, p90 ${f(quantile(v, 0.9))}`;
  return `   forecast (informational, from ${runs.length} finished ${cls} run${runs.length === 1 ? '' : 's'} recorded in this project): wall time ${both(wall, hours)}; agent time ${both(agent, minutes)}; tokens ${both(tok, tokens)}\n`;
}
