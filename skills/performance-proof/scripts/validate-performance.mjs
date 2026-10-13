#!/usr/bin/env node
// Validates a performance-proof report (shape in ../references/OUTPUT.md).
// Usage: node validate-performance.mjs <performance.json | REPORT.md> [--config .agents/config.yaml]
//        [--plan PLAN.md] [--rows]
// A .md input is read through its first ```json fenced block.
// --config/--plan recompute the thresholds (and their source) the report must carry; the budget is trusted only
// from the PLAN.md flag line (a plan whose flag line carries an unparseable budget_pct is refused). Without both
// the thresholds are self-declared: the result says "thresholds unverified", and --rows never submits PASS for
// such a report (it submits UNSUPPORTED `performance UNSUPPORTED: thresholds unverified ...`, blocking).
// --rows prints the gate submission (findings rows, or the UNSUPPORTED reason that starts
// `performance INCONCLUSIVE:` / `performance UNSUPPORTED:`) for a valid report.
// The bootstrap constants are pinned (seed, resamples, confidence from compare-bench.mjs) and every measurement
// is recomputed with them; a report carrying other values is invalid. The direction must match the unit (a time
// is lower-is-better, a rate higher-is-better; compare-bench.mjs unitDirection).
// Every measurement's statistics and status are recomputed from its samples with compare-bench.mjs, so a
// status that does not follow from the numbers, a PASS on too few runs or on noise, and a performance claim
// in the summary that cites no measured row are rejected. INCONCLUSIVE and UNSUPPORTED are never PASS.
// Exit: 0 valid, 1 invalid, 2 usage/read error. No dependencies.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, worst, thresholds, planBudget, planDirection, unitDirection, MIN_RUNS_FLOOR, SEED, RESAMPLES, CONFIDENCE } from "./compare-bench.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const KEYS = ["schema_version", "status", "unsupported_reason", "tool", "environment", "thresholds", "measurements", "judged", "summary", "next_step"];
const ENV_STR = ["os", "load_avg_before", "command", "order", "started_at", "finished_at", "base_rev", "change_rev"];
// A quantitative or comparative performance statement; it must cite a measured row (M<n>).
export const CLAIM = /\b(faster|slower|quicker|speed-?ups?|slow-?downs?|regress\w*|improv\w*|latency|throughput)\b|\d+(?:\.\d+)?\s*(?:%|ms\b|ns\b|µs|us\b|x\b|×)/i;
const IMPROVE = /\b(faster|quicker|speed-?ups?|improv\w*)\b/i;
const WORSEN = /\b(slower|slow-?downs?|regress\w*)\b/i;
const NEGATED = /\b(no|not|without|never)\b/i;
const QUANT = /\d+(?:\.\d+)?\s*(?:%|ms\b|ns\b|µs|us\b|s\b|x\b|×|ops\/s|req\/s)/i;

// expected: thresholds() recomputed from the project's config and the plan's budget, or null (unverified).
// planDir: the direction PLAN.md declares (planDirection), null when it declares none, undefined without --plan.
export function validate(doc, { expected = null, planDir = undefined } = {}) {
  const errors = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  if (!isObj(doc)) return ["$: expected object"];
  for (const k of Object.keys(doc)) if (!KEYS.includes(k)) err("$", `unexpected "${k}"`);
  if (doc.schema_version !== 1) err("$.schema_version", "must be 1");
  if (!["PASS", "FAIL", "INCONCLUSIVE", "UNSUPPORTED"].includes(doc.status)) err("$.status", "must be PASS, FAIL, INCONCLUSIVE or UNSUPPORTED");
  const ms = Array.isArray(doc.measurements) ? doc.measurements : (err("$.measurements", "expected array"), []);
  const judged = Array.isArray(doc.judged) ? doc.judged : (err("$.judged", "expected array"), []);
  if (!isStr(doc.summary)) err("$.summary", "expected non-empty string");
  if (["INCONCLUSIVE", "UNSUPPORTED"].includes(doc.status) && !isStr(doc.next_step)) err("$.next_step", `${doc.status} needs the next step (more runs, a quieter machine, the missing tool, or the user's decision)`);

  // Judged findings: never a measured number; they fail only by a written criterion they violate.
  const jids = new Set();
  judged.forEach((j, i) => {
    const p = `$.judged[${i}]`;
    if (!isObj(j)) return err(p, "expected object");
    if (!/^J\d+$/.test(j.id ?? "") || jids.has(j.id)) err(`${p}.id`, "must be a unique J<n>");
    jids.add(j.id);
    if (!isStr(j.text)) err(`${p}.text`, "expected non-empty string");
    else if (QUANT.test(j.text)) err(`${p}.text`, "a judged finding carries no measured number; measure it (a measurement row) or drop the number");
    if (typeof j.violates_criterion !== "boolean") err(`${p}.violates_criterion`, "expected boolean");
    if (j.violates_criterion && !isStr(j.criterion)) err(`${p}.criterion`, "quote the written spec or plan criterion the judged finding violates");
  });
  const judgedFail = judged.some((j) => isObj(j) && j.violates_criterion === true);

  const ids = new Set();
  if (doc.status === "UNSUPPORTED") {
    if (!isStr(doc.unsupported_reason)) err("$.unsupported_reason", "name the missing benchmark tool or command");
    if (ms.length) err("$.measurements", "UNSUPPORTED has no measurements (a check that measured is PASS, FAIL or INCONCLUSIVE)");
  } else {
    if ("unsupported_reason" in doc) err("$.unsupported_reason", `only for UNSUPPORTED, not ${doc.status}`);
    const t = doc.tool;
    if (!isObj(t) || !isStr(t.command)) err("$.tool.command", "the project's own benchmark command is required");
    if (!isObj(t) || !isStr(t.source)) err("$.tool.source", "name the project file that defines the command (never an installed tool)");
    const e = doc.environment;
    if (!isObj(e)) err("$.environment", "missing: the environment block is mandatory");
    else {
      for (const k of ENV_STR) if (!isStr(e[k])) err(`$.environment.${k}`, "expected non-empty string");
      if (!Number.isInteger(e.cpu_count) || e.cpu_count < 1) err("$.environment.cpu_count", "expected integer >= 1");
      if (!Number.isInteger(e.warmup_runs) || e.warmup_runs < 0) err("$.environment.warmup_runs", "expected integer >= 0");
      if (!Number.isInteger(e.runs) || e.runs < 1) err("$.environment.runs", "expected integer >= 1");
      if (e.order !== undefined && e.order !== "interleaved") err("$.environment.order", "base and change runs must be interleaved");
      if (!isObj(e.tool_versions)) err("$.environment.tool_versions", "expected object");
    }
    const th = doc.thresholds;
    const pct = (v) => typeof v === "number" && v > 0 && v <= 100;
    const thOk = isObj(th) && pct(th.regression_pct) && pct(th.noise_pct) && Number.isInteger(th.min_runs) && th.min_runs >= MIN_RUNS_FLOOR
      && th.confidence === CONFIDENCE && ["default", "config", "plan"].includes(th.source);
    if (!thOk) err("$.thresholds", `needs regression_pct and noise_pct in (0, 100], integer min_runs >= ${MIN_RUNS_FLOOR}, confidence ${CONFIDENCE} (pinned) and source default|config|plan`);
    else if (expected) for (const k of ["regression_pct", "noise_pct", "min_runs", "source"])
      if (th[k] !== expected[k]) err(`$.thresholds.${k}`, `is ${th[k]}, the project's config and plan give ${expected[k]}`);
    if (!ms.length) err("$.measurements", `${doc.status} needs at least one measurement (no performance claim without a measurement)`);
    ms.forEach((m, i) => {
      const p = `$.measurements[${i}]`;
      if (!isObj(m)) return err(p, "expected object");
      if (!/^M\d+$/.test(m.id ?? "") || ids.has(m.id)) err(`${p}.id`, "must be a unique M<n>");
      ids.add(m.id);
      if (!isStr(m.unit)) err(`${p}.unit`, "expected non-empty string");
      if (!["lower", "higher"].includes(m.direction)) err(`${p}.direction`, "must be lower or higher");
      else if (unitDirection(m.unit, m.metric)) {
        if (m.direction !== unitDirection(m.unit, m.metric)) err(`${p}.direction`, `is ${m.direction}, but unit ${m.unit} (metric ${m.metric}) is ${unitDirection(m.unit, m.metric)}-is-better: a time is lower, a rate higher`);
      } else if (!planDir) err(`${p}.direction`, `unit ${m.unit} has no known direction: declare direction=lower|higher on the PLAN.md performance_critical line and validate with --plan`);
      else if (m.direction !== planDir) err(`${p}.direction`, `is ${m.direction}, but PLAN.md declares direction=${planDir}`);
      const ok = (s) => isObj(s) && Array.isArray(s.samples) && s.samples.length > 0 && s.samples.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0);
      if (!ok(m.base)) err(`${p}.base.samples`, "base samples are required (positive numbers)");
      if (!ok(m.change)) err(`${p}.change.samples`, "change samples are required (positive numbers)");
      for (const side of ["base", "change"]) if (isObj(m[side]) && "unit" in m[side] && m[side].unit !== m.unit) err(`${p}.${side}.unit`, "unit mismatch: units are never compared across");
      const d = m.delta;
      const pinned = isObj(d) && d.seed === SEED && d.resamples === RESAMPLES && d.confidence === CONFIDENCE;
      if (!pinned) err(`${p}.delta`, `needs seed ${SEED}, resamples ${RESAMPLES} and confidence ${CONFIDENCE} (pinned; another seed or resample count is interval shopping)`);
      if (!ok(m.base) || !ok(m.change) || !thOk || !pinned) return;
      const r = compare(m.base.samples, m.change.samples, { th, direction: m.direction, seed: SEED, resamples: RESAMPLES });
      for (const k of ["median", "mad", "n"]) for (const side of ["base", "change"]) if (m[side][k] !== r[side][k]) err(`${p}.${side}.${k}`, `is ${m[side][k]}, the samples give ${r[side][k]}`);
      for (const k of ["regression_pct", "ci_low_pct", "ci_high_pct", "ci99_high_pct"]) if (d[k] !== r.delta[k]) err(`${p}.delta.${k}`, `is ${d[k]}, the samples give ${r.delta[k]}`);
      if (m.status !== r.status) err(`${p}.status`, `is ${m.status}, the samples and thresholds give ${r.status} (${r.reason})`);
      for (const side of ["base", "change"]) if (isObj(doc.environment) && Number.isInteger(doc.environment.runs) && m[side].samples.length !== doc.environment.runs)
        err(`${p}.${side}.samples`, `${m[side].samples.length} samples, but environment.runs is ${doc.environment.runs}`);
      if (m.base.samples.length === m.change.samples.length && m.base.samples.every((x, k) => x === m.change.samples[k]))
        err(`${p}.change.samples`, "identical to the base samples: copied data, not two measurements");
    });
    const derived = worst([...ms.filter(isObj).map((m) => m.status).filter((s) => s in { PASS: 1, FAIL: 1, INCONCLUSIVE: 1 }), ...(judgedFail ? ["FAIL"] : [])]);
    if (["PASS", "FAIL", "INCONCLUSIVE"].includes(doc.status) && ms.length && doc.status !== derived) err("$.status", `is ${doc.status}, the measurements and judged findings give ${derived}`);
  }
  if (doc.status === "INCONCLUSIVE" && isStr(doc.summary) && !(/INCONCLUSIVE/.test(doc.summary) && /not a FAIL/i.test(doc.summary)))
    err("$.summary", "an INCONCLUSIVE result says so and states that it is not a FAIL");

  // No performance claim without a measurement: every claim sentence cites an existing measured row.
  if (isStr(doc.summary)) for (const s of doc.summary.split(/(?<=[.!?])\s+|\n+/)) {
    if (!CLAIM.test(s)) continue;
    const cited = s.match(/\bM\d+\b/g) ?? [];
    if (!cited.length) err("$.summary", `claim without a measurement: "${s.trim().slice(0, 80)}"`);
    for (const c of new Set(cited)) {
      if (!ids.has(c)) { err("$.summary", `cites ${c}, which is not a measurement of this report`); continue; }
      const r = ms.find((m) => isObj(m) && m.id === c)?.delta?.regression_pct;
      if (typeof r !== "number" || NEGATED.test(s)) continue;
      if (IMPROVE.test(s) && r > 0) err("$.summary", `claims an improvement, but ${c} is ${r} % worse: "${s.trim().slice(0, 80)}"`);
      if (WORSEN.test(s) && !IMPROVE.test(s) && r < 0) err("$.summary", `claims a regression, but ${c} is ${-r} % better: "${s.trim().slice(0, 80)}"`);
    }
  }
  return errors;
}

export function loadDoc(file) {
  const text = readFileSync(file, "utf8");
  if (!file.endsWith(".md")) return JSON.parse(text);
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!m) throw new Error("no ```json fenced block found");
  return JSON.parse(m[1]);
}

const one = (s) => String(s ?? "").replace(/[|\n]/g, "/").trim();
// The gate submission for a valid report (team mode): `blocking|...` / `info|...` rows, or the UNSUPPORTED reason.
// verified: the thresholds were recomputed from the project's config and plan; an unverified PASS is no PASS.
export function submission(doc, artifact = "reviews/performance-proof/REPORT.md", { verified = true } = {}) {
  if (doc.status === "UNSUPPORTED") return { result: "UNSUPPORTED", reason: `performance UNSUPPORTED: ${one(doc.unsupported_reason)}; never a PASS; ${one(doc.next_step)}` };
  if (doc.status === "INCONCLUSIVE") {
    const why = doc.measurements.filter((m) => m.status === "INCONCLUSIVE").map((m) => `${m.id} ${one(m.reason)}`).join("; ");
    return { result: "UNSUPPORTED", reason: `performance INCONCLUSIVE: ${why}; not a FAIL; ${one(doc.next_step)}` };
  }
  const rows = doc.measurements.filter((m) => m.status === "FAIL")
    .map((m) => `blocking|-|${m.id} ${one(m.metric)}: ${one(m.reason)}|${artifact}`);
  for (const j of doc.judged) rows.push(`${j.violates_criterion ? "blocking" : "info"}|${one(j.path) || "-"}|${j.id} judged: ${one(j.text)}${j.violates_criterion ? ` (violates: ${one(j.criterion)})` : ""}|${artifact}`);
  if (doc.status === "PASS" && !verified)
    return { result: "UNSUPPORTED", reason: "performance UNSUPPORTED: thresholds unverified (validated without --config and --plan); never a PASS; re-run validate-performance.mjs with --config .agents/config.yaml --plan <run>/PLAN.md --rows", rows };
  return { result: doc.status, rows };
}

const main = () => {
  const args = process.argv.slice(2);
  const opt = {};
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rows") opt.rows = true;
    else if (/^--(config|plan)$/.test(args[i]) && i + 1 < args.length) opt[args[i].slice(2)] = args[++i];
    else files.push(args[i]);
  }
  if (files.length !== 1 || files[0].startsWith("--")) { console.error("usage: validate-performance.mjs <performance.json|REPORT.md> [--config FILE] [--plan PLAN.md] [--rows]"); process.exit(2); }
  let doc, expected = null, planDir;
  try {
    doc = loadDoc(files[0]);
    if (opt.config || opt.plan) {
      let yaml = "";
      if (opt.config) { try { yaml = readFileSync(resolve(opt.config), "utf8"); } catch { /* absent config: defaults */ } }
      const pb = opt.plan ? planBudget(readFileSync(resolve(opt.plan), "utf8")) : { budget: null, note: null };
      if (opt.plan) planDir = planDirection(readFileSync(resolve(opt.plan), "utf8"));
      if (pb.note) { console.error(`$.thresholds: ${pb.note}; fix the plan's flag line (amendment and refreeze)`); process.exit(1); }
      expected = thresholds(yaml, pb.budget);
    }
  } catch (e) { console.error(`cannot read input: ${e.message}`); process.exit(2); }
  const errors = validate(doc, { expected, planDir });
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  const verified = Boolean(opt.config && opt.plan) || doc.status === "UNSUPPORTED";
  console.log(`valid: ${doc.status}${verified ? "" : " (thresholds unverified: pass --config and --plan; never a gate PASS)"}`);
  if (opt.rows) {
    const s = submission(doc, undefined, { verified });
    console.log(`result: ${s.result}`);
    if (s.reason) console.log(`reason: ${s.reason}`);
    for (const r of s.rows ?? []) console.log(r);
  }
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
