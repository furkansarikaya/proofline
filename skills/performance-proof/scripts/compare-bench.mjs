#!/usr/bin/env node
// Compares two benchmark sample files (base and change) and prints a performance-proof report (JSON) with one
// measurement: median, MAD, IQR, min/max per side, percentile bootstrap intervals (95 % and the 99 % upper end)
// of the relative median change (seeded, deterministic) and the status from the decision rule
// (references/DECISION.md).
//
//   node compare-bench.mjs --base FILE --change FILE [--env FILE] [--config .agents/config.yaml]
//        [--plan PLAN.md | --budget-pct N] [--direction lower|higher] [--metric NAME] [--id M1] [--seed N]
//        [--command CMD] [--tool-source TEXT]
//
// --plan reads the budget from PLAN.md `## Risk`: `performance_critical: yes budget_pct=<n>` (0 < n <= 100); an
// unparseable budget_pct there is a note in the report, never silently ignored. --budget-pct is a local what-if
// only: the report's source is `cli (unverified)`, which validate-performance.mjs refuses.
//
// Sample files: JSON {"unit": "ms", "samples": [..]} or CSV with a header that has `value` and `unit` columns
// (and optionally `exit`: a run with a non-zero exit is not a sample). Units must match exactly: nothing is
// converted. --env reads run-bench.sh's environment.txt (key=value lines).
// Exit: 0 report printed (any status), 2 usage or input error (unit mismatch, unreadable, non-numeric).
// No dependencies.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULTS = { regression_pct: 10, noise_pct: 5, min_runs: 10 };
export const MIN_RUNS_FLOOR = 5;
export const CONFIDENCE = 0.95;
export const PASS_CONFIDENCE = 0.99;
export const RESAMPLES = 2000;
export const SEED = 1;
const RANK = { PASS: 0, INCONCLUSIVE: 1, FAIL: 2 };

export const r4 = (x) => Math.round(x * 1e4) / 1e4;

// Flat YAML: a top-level `performance:` block with indented `key: integer` lines. Invalid values fall back to
// the default and are listed in `notes`. A budget (the plan's, or a cli what-if) wins over config and default.
export function thresholds(yamlText = "", budgetPct = null, budgetSource = "plan") {
  const out = { ...DEFAULTS };
  const notes = [];
  let source = "default";
  let inBlock = false;
  for (const line of String(yamlText ?? "").split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^performance:\s*(#.*)?$/.test(line)) { inBlock = true; continue; }
    if (!/^\s/.test(line)) { inBlock = false; continue; }
    const m = inBlock && /^\s+([a-z_]+):\s*([^#\s]*)\s*(#.*)?$/.exec(line);
    if (!m || !(m[1] in DEFAULTS) || m[2] === "") continue;
    const v = Number(m[2]);
    const floor = m[1] === "min_runs" ? MIN_RUNS_FLOOR : 1;
    if (/^\d+$/.test(m[2]) && v >= floor) { out[m[1]] = v; if (m[1] === "regression_pct") source = "config"; }
    else notes.push(`performance.${m[1]}=${m[2]} is invalid; ${out[m[1]]} used`);
  }
  if (budgetPct !== null) { out.regression_pct = budgetPct; source = budgetSource; }
  return { ...out, confidence: CONFIDENCE, source, notes };
}

// The relative budget the plan states on its flag line in `## Risk` (`performance_critical: yes budget_pct=5`),
// as { budget, note }: budget null when none is stated; note names an unparseable or out-of-range value
// (0 < budget_pct <= 100). The flag line is frozen with PLAN.md, so the budget is too.
export const validBudget = (v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 && Number(v) <= 100;
export function planBudget(planText = "") {
  let inRisk = false;
  for (const line of String(planText).split(/\r?\n/)) {
    if (/^## /.test(line)) { inRisk = /^## Risk\s*$/.test(line); continue; }
    const m = inRisk && /^[-*]?\s*performance_critical:\s*yes\b.*\bbudget_pct=(\S*)/.exec(line);
    if (!m) continue;
    const v = m[1].replace(/[),.;]+$/, "");
    if (validBudget(v)) return { budget: Number(v), note: null };
    return { budget: null, note: `PLAN.md budget_pct=${m[1]} is not a number in (0, 100]; ignored, the plan states no usable budget` };
  }
  return { budget: null, note: null };
}

export function readSamples(file) {
  const text = readFileSync(file, "utf8");
  let unit, samples;
  if (/\.json$/i.test(file)) {
    const d = JSON.parse(text);
    unit = d.unit; samples = d.samples;
  } else {
    const rows = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    const head = rows.shift()?.split(",").map((s) => s.trim()) ?? [];
    const vi = head.indexOf("value"), ui = head.indexOf("unit"), ei = head.indexOf("exit");
    if (vi < 0 || ui < 0) throw new Error(`${file}: CSV needs a header with value and unit columns`);
    const units = new Set();
    samples = rows.map((l, i) => {
      const c = l.split(",").map((s) => s.trim());
      if (ei >= 0 && c[ei] !== "0") throw new Error(`${file}: row ${i + 1} exited ${c[ei]}; a failed run is not a sample`);
      units.add(c[ui]);
      return c[vi] === "" ? NaN : Number(c[vi]);
    });
    if (units.size > 1) throw new Error(`${file}: mixed units ${[...units].join(", ")}`);
    unit = [...units][0];
  }
  if (typeof unit !== "string" || !unit.trim()) throw new Error(`${file}: no unit`);
  if (!Array.isArray(samples) || samples.length === 0) throw new Error(`${file}: no samples`);
  if (!samples.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0)) throw new Error(`${file}: every sample must be a positive number`);
  return { unit, samples };
}

// Linear-interpolation quantile (type 7) of a sorted array.
const quantile = (s, p) => { const h = (s.length - 1) * p, lo = Math.floor(h); return s[lo] + (h - lo) * ((s[Math.ceil(h)] ?? s[lo]) - s[lo]); };
const median = (a) => quantile([...a].sort((x, y) => x - y), 0.5);

export function stats(a) {
  const s = [...a].sort((x, y) => x - y);
  const med = quantile(s, 0.5);
  const mad = median(s.map((x) => Math.abs(x - med)));
  const q1 = quantile(s, 0.25), q3 = quantile(s, 0.75);
  return { n: s.length, median: r4(med), mad: r4(mad), rel_mad_pct: r4((mad / med) * 100), q1: r4(q1), q3: r4(q3), iqr: r4(q3 - q1), min: s[0], max: s[s.length - 1] };
}

// mulberry32: a small seeded PRNG, so the same samples always give the same interval.
function prng(seed) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6d2b79f5) >>> 0; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}

// Regression in percent of the base median: positive is worse, whichever direction is better.
const regression = (mb, mc, direction) => (direction === "higher" ? (mb - mc) / mb : (mc - mb) / mb) * 100;

export function compare(base, change, { th = thresholds(), direction = "lower", seed = SEED, resamples = RESAMPLES } = {}) {
  const b = stats(base), c = stats(change);
  const rand = prng(seed);
  const pick = (a) => median(Array.from(a, () => a[Math.floor(rand() * a.length)]));
  const boot = [];
  for (let i = 0; i < resamples; i++) { const mb = pick(base); boot.push(regression(mb, pick(change), direction)); }
  boot.sort((x, y) => x - y);
  const alpha = 1 - th.confidence;
  const delta = {
    regression_pct: r4(regression(median(base), median(change), direction)),
    ci_low_pct: r4(quantile(boot, alpha / 2)), ci_high_pct: r4(quantile(boot, 1 - alpha / 2)),
    ci99_high_pct: r4(quantile(boot, PASS_CONFIDENCE + (1 - PASS_CONFIDENCE) / 2)),
    confidence: th.confidence, resamples, seed,
  };
  const noise = Math.max(b.rel_mad_pct, c.rel_mad_pct);
  const T = th.regression_pct;
  let status, reason;
  // Calibrated by scripts/calibrate.mjs (table in references/DECISION.md): FAIL needs the 95 % lower end above
  // half the threshold, PASS the 99 % upper end within it, so neither is called on a borderline interval.
  if (Math.min(b.n, c.n) < th.min_runs) { status = "INCONCLUSIVE"; reason = `too few runs: ${Math.min(b.n, c.n)} < min_runs ${th.min_runs}`; }
  else if (delta.regression_pct > T && delta.ci_low_pct > T / 2) { status = "FAIL"; reason = `median regression ${delta.regression_pct} % > threshold ${T} %, 95 % interval lower end ${delta.ci_low_pct} % > ${T / 2} %`; }
  else if (noise > th.noise_pct) { status = "INCONCLUSIVE"; reason = `noise ${r4(noise)} % relative MAD > noise threshold ${th.noise_pct} %`; }
  else if (delta.ci99_high_pct <= T) { status = "PASS"; reason = `99 % interval upper end ${delta.ci99_high_pct} % <= threshold ${T} %`; }
  else { status = "INCONCLUSIVE"; reason = `interval ${delta.ci_low_pct}..${delta.ci99_high_pct} % reaches past threshold ${T} % without exceeding it clearly`; }
  return { base: b, change: c, delta, noise_pct: r4(noise), status, reason };
}

export const worst = (statuses) => statuses.reduce((w, s) => (RANK[s] > RANK[w] ? s : w), "PASS");

export function readEnv(text) {
  const env = { tool_versions: {} };
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([a-z_][a-z0-9_.]*)=(.*)$/.exec(line);
    if (!m) continue;
    if (m[1].startsWith("tool_version.")) env.tool_versions[m[1].slice(13)] = m[2];
    else env[m[1]] = /^(cpu_count|runs|warmup_runs|timeout_s)$/.test(m[1]) && /^\d+$/.test(m[2]) ? Number(m[2]) : m[2];
  }
  return env;
}

export function summarize(m, th) {
  const d = m.delta;
  const sign = (x) => (x > 0 ? "+" : "") + x;
  let s = `${m.id} ${m.metric}: median ${m.base.median} -> ${m.change.median} ${m.unit}, change ${sign(d.regression_pct)} % (positive is worse) (${d.confidence * 100} % interval ${sign(d.ci_low_pct)}..${sign(d.ci_high_pct)} %), threshold ${th.regression_pct} % (${th.source}), noise ${m.noise_pct} % of ${th.noise_pct} %: ${m.status} (${m.reason}).`;
  if (m.status === "INCONCLUSIVE") s += ` ${m.id} is INCONCLUSIVE, which is not a FAIL and not a PASS.`;
  return s;
}

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!/^--(base|change|env|config|plan|budget-pct|direction|metric|id|seed|command|tool-source)$/.test(k) || i + 1 >= argv.length) {
      console.error("usage: compare-bench.mjs --base FILE --change FILE [--env FILE] [--config FILE] [--plan PLAN.md | --budget-pct N] [--direction lower|higher] [--metric NAME] [--id M1] [--seed N] [--command CMD] [--tool-source TEXT]");
      return 2;
    }
    opt[k.slice(2)] = argv[++i];
  }
  try {
    if (!opt.base || !opt.change) throw new Error("--base and --change are required");
    const direction = opt.direction ?? "lower";
    if (!["lower", "higher"].includes(direction)) throw new Error("--direction must be lower or higher");
    if ("budget-pct" in opt && !validBudget(opt["budget-pct"])) throw new Error("--budget-pct must be a number in (0, 100]");
    const seed = opt.seed === undefined ? SEED : Number(opt.seed);
    if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
    let yaml = "";
    if (opt.config) { try { yaml = readFileSync(resolve(opt.config), "utf8"); } catch { /* absent config: defaults */ } }
    if (opt.plan && "budget-pct" in opt) throw new Error("--plan and --budget-pct are exclusive (the plan's budget is the budget)");
    const pb = opt.plan ? planBudget(readFileSync(resolve(opt.plan), "utf8")) : { budget: null, note: null };
    const th = "budget-pct" in opt ? thresholds(yaml, Number(opt["budget-pct"]), "cli (unverified)") : thresholds(yaml, pb.budget);
    if (pb.note) th.notes.push(pb.note);
    for (const n of th.notes) console.error(`note: ${n}`);
    const b = readSamples(resolve(opt.base)), c = readSamples(resolve(opt.change));
    if (b.unit !== c.unit) throw new Error(`unit mismatch: base ${b.unit}, change ${c.unit}; units are never converted or compared across, re-measure or convert the samples first`);
    const env = opt.env ? readEnv(readFileSync(resolve(opt.env), "utf8")) : null;
    const r = compare(b.samples, c.samples, { th, direction, seed });
    const m = {
      id: opt.id ?? "M1", metric: opt.metric ?? (b.unit === "ms" ? "wall_time" : "value"), unit: b.unit, direction,
      base: { samples: b.samples, ...r.base }, change: { samples: c.samples, ...r.change },
      delta: r.delta, noise_pct: r.noise_pct, status: r.status, reason: r.reason,
    };
    const report = {
      schema_version: 1, status: m.status,
      tool: { command: opt.command ?? env?.command ?? null, source: opt["tool-source"] ?? null },
      environment: env, thresholds: { regression_pct: th.regression_pct, noise_pct: th.noise_pct, min_runs: th.min_runs, confidence: th.confidence, source: th.source, ...(th.notes.length ? { notes: th.notes } : {}) },
      measurements: [m], judged: [], summary: summarize(m, th),
    };
    if (m.status === "INCONCLUSIVE") report.next_step = "re-run with more runs on a quieter machine, or the user decides (waiver of the UNSUPPORTED performance result)";
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (e) {
    console.error(`compare-bench: ${e.message}`);
    return 2;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
