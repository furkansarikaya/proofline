#!/usr/bin/env node
// Validates a visual-proof report (report.json) and recomputes its result. No dependencies.
//   node validate-visual.mjs <report.json> [--class STANDARD|COMPLEX|CRITICAL] [--plan PLAN.md] [--spec FILE]...
//                            [--rows] [--json]
// Screenshot paths are relative to the report's directory; every one must exist with its recorded sha256.
// Prints `RESULT: <PASS|FAIL|INCONCLUSIVE|UNSUPPORTED>` and one `SUMMARY:` line; `--rows` adds the finding rows
// for `agent.sh submit --findings` (severity|path:line|finding|evidence).
// Exit codes: 0 valid, 1 invalid, 2 usage or read error.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "visual-proof/1";
// Checks every measured cell (screen x state x viewport) must account for: a measured item or a cell-level
// `not_measured` entry.
export const CORE = ["viewport_overflow", "horizontal_scroll", "hidden_interactive", "overlapping_interactive",
  "contrast", "touch_target", "state_rendered", "focus_order", "focus_visible"];
export const INTERACTION_CHECKS = ["long_content", "form_validation", "modal_interaction", "dropdown_interaction"];
export const CHECKS = [...CORE, ...INTERACTION_CHECKS, "a11y_scanner"];
export const ASPECTS = ["hierarchy", "density", "consistency", "typography"];
export const TOOL_KINDS = ["project-tool", "headless-browser", "runtime-adapter", "none"];
export const CLASSES = ["STANDARD", "COMPLEX", "CRITICAL"];
export const MIN_VIEWPORTS = { STANDARD: 2, COMPLEX: 3, CRITICAL: 3 };
const RESULTS = ["PASS", "FAIL", "INCONCLUSIVE", "UNSUPPORTED"];
const STATUSES = ["pass", "fail", "not_applicable"];
const JUDGED = ["ok", "concern", "violation"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => typeof v === "string" && v.trim() !== "";
const norm = (s) => String(s).replace(/\s+/g, " ").trim();
const key = (o) => `${o.screen}|${o.state}|${o.viewport}`;

// `<= 360`, `>= 4.5`, `== 0`, `> 1`, `< 3`: returns true/false, or null when the threshold is not numeric.
export function thresholdHolds(value, threshold) {
  const m = /^(<=|>=|==|<|>)\s*(-?\d+(?:\.\d+)?)$/.exec(String(threshold).trim());
  if (!m || typeof value !== "number" || !Number.isFinite(value)) return null;
  const t = Number(m[2]);
  return { "<=": value <= t, ">=": value >= t, "==": value === t, "<": value < t, ">": value > t }[m[1]];
}

// The frozen PLAN `## UI` line `visual_proof: AC-1, AC-3` (or `none`), as ui-design (A81) writes it.
export function planVisualProof(text) {
  let inUi = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^## /.test(line)) { inUi = /^## UI\s*$/.test(line); continue; }
    const m = inUi && /^\s*(?:[-*]\s+)?`?visual_proof:\s*([^`]*)`?\s*$/.exec(line);
    if (m) return /^none$/i.test(m[1].trim()) ? [] : m[1].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return null;
}

// Cells the depth rule requires: STANDARD = each screen's first (default) state x viewports; COMPLEX and
// CRITICAL = every state x viewports.
export function requiredCells(report) {
  const out = [];
  const deep = report.class !== "STANDARD";
  for (const s of Array.isArray(report.screens) ? report.screens : []) {
    const states = Array.isArray(s?.states) ? (deep ? s.states : s.states.slice(0, 1)) : [];
    for (const state of states) for (const v of report.viewports || []) out.push({ screen: s.id, state, viewport: v?.name });
  }
  return out;
}

export function validateReport(report, opt = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!isObj(report)) return { valid: false, errors: ["report must be a JSON object"] };
  const root = opt.root ?? ".";
  const hashes = new Map();
  const checkFile = (where, ev) => {
    if (!isObj(ev) || !str(ev.path) || !/^[0-9a-f]{64}$/.test(ev.sha256 || "")) return err(`${where}: needs {path, sha256} (sha256 = 64 lowercase hex)`);
    if (isAbsolute(ev.path) || ev.path.split(/[\\/]/).includes("..")) return err(`${where}: path must be relative to the report folder without ..: ${ev.path}`);
    const p = resolve(root, ev.path);
    if (!(p + sep).startsWith(resolve(root) + sep)) return err(`${where}: path leaves the report folder: ${ev.path}`);
    if (!hashes.has(p)) hashes.set(p, existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null);
    const h = hashes.get(p);
    if (h === null) err(`${where}: screenshot not found: ${ev.path}`);
    else if (h !== ev.sha256) err(`${where}: sha256 of ${ev.path} does not match (file ${h.slice(0, 12)}...)`);
  };

  if (report.schema !== SCHEMA) err(`schema must be "${SCHEMA}"`);
  if (!RESULTS.includes(report.result)) err(`result must be one of ${RESULTS.join("|")}`);
  if (report.class === "TRIVIAL") err("class TRIVIAL has no visual focus (no QA gate)");
  else if (!CLASSES.includes(report.class)) err(`class must be one of ${CLASSES.join("|")}`);
  if (opt.cls && opt.cls !== report.class) err(`class ${report.class} does not match --class ${opt.cls}`);
  const tool = isObj(report.tool) ? report.tool : {};
  if (!TOOL_KINDS.includes(tool.kind)) err(`tool.kind must be one of ${TOOL_KINDS.join("|")}`);
  for (const k of ["measured", "not_measured", "judged", "cells", "screens", "viewports", "criteria"]) {
    if (report[k] !== undefined && !Array.isArray(report[k])) err(`${k} must be an array`);
  }
  const measured = Array.isArray(report.measured) ? report.measured : [];
  const notMeasured = Array.isArray(report.not_measured) ? report.not_measured : [];
  const judged = Array.isArray(report.judged) ? report.judged : [];
  const cells = Array.isArray(report.cells) ? report.cells : [];
  const viewports = Array.isArray(report.viewports) ? report.viewports : [];
  const criteria = Array.isArray(report.criteria) ? report.criteria : [];

  // --- UNSUPPORTED: no browser tooling at all; nothing may look measured --------------------------------
  const unsupported = tool.kind === "none";
  if (unsupported) {
    if (!str(report.unsupported_reason)) err("tool.kind none needs unsupported_reason (what is missing)");
    if (measured.length || judged.length || cells.length) err("tool.kind none: measured, judged and cells must be empty (nothing was rendered)");
  } else if (report.unsupported_reason !== undefined && report.unsupported_reason !== null) {
    err("unsupported_reason is only allowed with tool.kind none");
  }
  if (!unsupported && tool.kind && !str(tool.name)) err("tool.name is required (the detected browser or project tool)");

  // --- depth ---------------------------------------------------------------------------------------------
  const min = MIN_VIEWPORTS[report.class];
  const vpNames = new Set();
  for (const [i, v] of viewports.entries()) {
    if (!isObj(v) || !str(v.name) || !Number.isInteger(v.width) || !Number.isInteger(v.height) || v.width <= 0 || v.height <= 0) err(`viewports[${i}]: needs name, width, height (positive integers)`);
    else if (vpNames.has(v.name)) err(`viewports[${i}]: duplicate name ${v.name}`);
    else vpNames.add(v.name);
  }
  if (!unsupported && min && vpNames.size < min) err(`class ${report.class} needs at least ${min} viewports (got ${vpNames.size})`);
  if (!unsupported && !(Array.isArray(report.screens) && report.screens.length)) err("screens must list at least one changed screen");
  for (const [i, s] of (Array.isArray(report.screens) ? report.screens : []).entries()) {
    if (!isObj(s) || !str(s.id) || !str(s.path) || !Array.isArray(s.states) || !s.states.length || !s.states.every(str)) err(`screens[${i}]: needs id, path and a non-empty states list`);
  }
  const cellKeys = new Map();
  for (const [i, c] of cells.entries()) {
    if (!isObj(c) || !str(c.screen) || !str(c.state) || !vpNames.has(c.viewport)) { err(`cells[${i}]: needs screen, state and a listed viewport`); continue; }
    checkFile(`cells[${i}].screenshot`, c.screenshot);
    cellKeys.set(key(c), c);
  }
  const required = unsupported ? [] : requiredCells(report);
  for (const c of required) if (!cellKeys.has(key(c))) err(`cell ${key(c)} required by class ${report.class} has no screenshot entry in cells`);

  // --- measured items ------------------------------------------------------------------------------------
  const ids = new Set();
  const a11y = isObj(report.a11y_scanner) ? report.a11y_scanner : null;
  if (!unsupported && (!a11y || !["run", "not_available"].includes(a11y.status))) err("a11y_scanner.status must be run or not_available");
  for (const [i, m] of measured.entries()) {
    const w = `measured[${i}]`;
    if (!isObj(m)) { err(`${w}: must be an object`); continue; }
    if (!/^M-\d+$/.test(m.id || "") || ids.has(m.id)) err(`${w}: id must be a unique M-<n>`);
    ids.add(m.id);
    if (!CHECKS.includes(m.check)) err(`${w}: unknown check ${m.check}`);
    if (!cellKeys.has(key(m))) err(`${w}: ${key(m)} is not a listed cell`);
    if (!str(m.selector)) err(`${w}: selector is required`);
    if (m.value === undefined || m.value === null || m.value === "") err(`${w}: value is required`);
    if (!str(m.threshold)) err(`${w}: threshold is required`);
    if (!STATUSES.includes(m.status)) err(`${w}: status must be pass|fail|not_applicable`);
    if (m.aspect !== undefined) err(`${w}: a measured item has no aspect (judged items are separate)`);
    if (INTERACTION_CHECKS.includes(m.check) && !str(m.interaction)) err(`${w}: an interaction check names its interaction`);
    const holds = thresholdHolds(m.value, m.threshold);
    if (holds !== null && m.status !== "not_applicable" && holds !== (m.status === "pass")) err(`${w}: status ${m.status} contradicts value ${m.value} ${m.threshold}`);
    if (m.criteria !== undefined && (!Array.isArray(m.criteria) || !m.criteria.every((c) => /^AC-\d+$/.test(c)))) err(`${w}: criteria must be a list of AC-<n>`);
    checkFile(`${w}.evidence`, m.evidence);
  }
  for (const [i, n] of notMeasured.entries()) {
    if (!isObj(n) || !["cell", "element"].includes(n.scope) || !str(n.reason) || !CHECKS.includes(n.check)) err(`not_measured[${i}]: needs scope cell|element, a known check and a reason`);
    else if (!cellKeys.has(key(n)) && !required.some((c) => key(c) === key(n))) err(`not_measured[${i}]: ${key(n)} is not a cell`);
  }

  // --- coverage: every required cell accounts for every core check -----------------------------------------
  const accounted = (check, c, interaction) => measured.some((m) => m.check === check && key(m) === key(c) && (!interaction || m.interaction === interaction))
    || notMeasured.some((n) => n.scope === "cell" && n.check === check && key(n) === key(c) && (!interaction || n.interaction === interaction));
  const core = a11y?.status === "run" ? [...CORE, "a11y_scanner"] : CORE;
  for (const c of required) for (const check of core) if (!accounted(check, c)) err(`cell ${key(c)}: check ${check} is neither measured nor listed as not_measured`);
  for (const [i, it] of (Array.isArray(report.interactions) ? report.interactions : []).entries()) {
    if (!isObj(it) || !str(it.name) || !INTERACTION_CHECKS.includes(it.check) || !str(it.screen) || !str(it.state)) { err(`interactions[${i}]: needs name, check (${INTERACTION_CHECKS.join("|")}), screen, state`); continue; }
    for (const v of Array.isArray(it.viewports) && it.viewports.length ? it.viewports : [...vpNames]) {
      if (!accounted(it.check, { screen: it.screen, state: it.state, viewport: v }, it.name)) err(`interaction ${it.name} at ${v}: neither measured nor listed as not_measured`);
    }
  }

  // --- regression: only the project's own snapshot infrastructure; never new baselines -----------------
  const reg = isObj(report.regression) ? report.regression : null;
  if (!unsupported) {
    if (!reg || !["run", "not_available"].includes(reg.status)) err("regression.status must be run or not_available");
    else if (reg.status === "not_available" && !str(reg.reason)) err("regression not_available needs a reason");
    else if (reg.status === "run" && (!str(reg.command) || !Number.isInteger(reg.exit) || reg.baselines !== "existing")) err("regression run needs command, exit and baselines: existing");
  }
  if (reg && reg.baselines_created !== undefined && reg.baselines_created !== false) err("regression.baselines_created must be false: visual-proof never creates baselines");

  // --- judged: separate, cites a screenshot and the spec; never closes the gate alone --------------------
  const specTexts = [...(opt.specTexts || []), ...(opt.planText ? [opt.planText] : [])].map(norm);
  if (report.class === "STANDARD" && judged.length) err("class STANDARD is measured only: judged must be empty");
  const jids = new Set();
  for (const [i, j] of judged.entries()) {
    const w = `judged[${i}]`;
    if (!isObj(j)) { err(`${w}: must be an object`); continue; }
    if (!/^J-\d+$/.test(j.id || "") || jids.has(j.id)) err(`${w}: id must be a unique J-<n>`);
    jids.add(j.id);
    if (!ASPECTS.includes(j.aspect)) err(`${w}: aspect must be one of ${ASPECTS.join("|")}`);
    if (!cellKeys.has(key(j))) err(`${w}: ${key(j)} is not a listed cell`);
    if (!str(j.observation)) err(`${w}: observation is required`);
    if (!str(j.spec_ref)) err(`${w}: spec_ref (the spec or plan section it is judged against) is required`);
    if (!JUDGED.includes(j.status)) err(`${w}: status must be ok|concern|violation`);
    if (j.value !== undefined || j.threshold !== undefined) err(`${w}: a judged item has no value or threshold (that would be measured)`);
    checkFile(`${w}.screenshot`, j.screenshot);
    if (j.status === "violation") {
      const v = j.violates;
      if (!isObj(v) || !str(v.ref) || !str(v.quote)) err(`${w}: a violation needs violates {ref, quote}: the criterion written in the spec or plan`);
      else if (!specTexts.length) err(`${w}: a violation can only be checked against the spec or plan (pass --spec or --plan)`);
      else if (!specTexts.some((t) => t.includes(norm(v.quote)))) err(`${w}: the quoted criterion is not written in the spec or plan: "${v.quote.slice(0, 60)}"`);
    }
  }
  if (!unsupported && report.class !== "STANDARD") {
    for (const a of ASPECTS) if (!judged.some((j) => j.aspect === a)) err(`class ${report.class} needs a judged item for ${a}`);
  }

  // --- criteria ------------------------------------------------------------------------------------------
  const computedCriteria = {};
  const critIds = new Set();
  for (const [i, c] of criteria.entries()) {
    if (!isObj(c) || !/^AC-\d+$/.test(c.id || "") || typeof c.required !== "boolean") { err(`criteria[${i}]: needs id AC-<n> and required true|false`); continue; }
    critIds.add(c.id);
    const items = measured.filter((m) => Array.isArray(m.criteria) && m.criteria.includes(c.id));
    const violated = judged.some((j) => j.status === "violation" && j.violates?.ref === c.id);
    const st = items.some((m) => m.status === "fail") || violated ? "failed" : items.some((m) => m.status === "pass") ? "proven" : "unproven";
    computedCriteria[c.id] = st;
    if (c.status !== st) err(`criteria[${i}]: status ${c.status} contradicts the evidence (computed ${st})`);
  }
  if (opt.planText !== undefined) {
    const planIds = planVisualProof(opt.planText);
    if (planIds === null) err("PLAN.md has no `visual_proof:` line in ## UI");
    for (const id of planIds || []) {
      const c = criteria.find((x) => x?.id === id);
      if (!c) err(`${id} is marked visual_proof in PLAN.md but missing from criteria (unproven)`);
      else if (!c.required) err(`${id} is marked visual_proof in PLAN.md: criteria entry must be required: true`);
    }
  }

  // --- result --------------------------------------------------------------------------------------------
  const reasons = [];
  let computed;
  if (unsupported) computed = "UNSUPPORTED";
  else {
    for (const m of measured) if (m.status === "fail") reasons.push(`${m.id} ${m.check} failed`);
    for (const j of judged) if (j.status === "violation") reasons.push(`${j.id} violates ${j.violates?.ref}`);
    if (reg?.status === "run" && reg.exit !== 0) reasons.push("visual regression failed");
    if (reasons.length) computed = "FAIL";
    else {
      for (const n of notMeasured) if (n.scope === "cell") reasons.push(`not measured: ${n.check} at ${key(n)}`);
      for (const c of criteria) if (c?.required && computedCriteria[c.id] === "unproven") reasons.push(`${c.id} unproven`);
      computed = reasons.length ? "INCONCLUSIVE" : "PASS";
    }
  }
  if (RESULTS.includes(report.result) && report.result !== computed) err(`result ${report.result} contradicts the evidence (computed ${computed}${reasons.length ? ": " + reasons.slice(0, 4).join("; ") : ""})`);

  const shots = new Set([...cells.map((c) => c?.screenshot?.path), ...measured.map((m) => m?.evidence?.path), ...judged.map((j) => j?.screenshot?.path)].filter(Boolean));
  const fails = measured.filter((m) => m.status === "fail");
  const summary = `visual-proof: ${computed} class=${report.class} tool=${tool.kind}${tool.name ? ":" + tool.name : ""} cells=${cells.length} viewports=${[...vpNames].join(",") || "-"} measured=${measured.length - fails.length}/${measured.length} pass, ${fails.length} fail; judged=${judged.length} (violations ${judged.filter((j) => j.status === "violation").length}); screenshots=${shots.size}; criteria ${Object.entries(computedCriteria).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}${unsupported ? `; unsupported: ${report.unsupported_reason}` : ""}`;
  return { valid: errors.length === 0, errors, result: report.result, computed, reasons, criteria: computedCriteria, summary, rows: rowsOf(report, fails, judged) };
}

// Finding rows for `agent.sh submit --findings`: one blocking row per failed measurement or judged violation,
// one info row per judged concern. The location is `<screen path>:<selector>`; replace it with the source
// `path:line` once the rule is located.
function rowsOf(report, fails, judged) {
  const clean = (s) => String(s).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  const path = (id) => (report.screens || []).find((s) => s?.id === id)?.path || id;
  const rows = fails.map((m) => ["blocking", `${path(m.screen)}:${m.selector}`, `${m.id} ${m.check}: ${m.value} fails ${m.threshold} at ${m.screen}/${m.state}/${m.viewport}${m.criteria?.length ? " (" + m.criteria.join(",") + ")" : ""}`, `measured; ${m.evidence?.path} sha256:${String(m.evidence?.sha256).slice(0, 12)}`]);
  for (const j of judged) {
    if (j.status === "ok") continue;
    rows.push([j.status === "violation" ? "blocking" : "info", `${path(j.screen)}:${j.aspect}`, `${j.id} judged ${j.aspect}: ${j.observation}${j.status === "violation" ? ` (violates ${j.violates?.ref})` : ""}`, `judged; ${j.screenshot?.path} against ${j.spec_ref}`]);
  }
  return rows.map((r) => r.map(clean).join("|"));
}

function main(argv) {
  const usage = "usage: validate-visual.mjs <report.json> [--class STANDARD|COMPLEX|CRITICAL] [--plan PLAN.md] [--spec FILE]... [--rows] [--json]";
  const read = (p) => { try { return readFileSync(p, "utf8"); } catch (e) { console.error(`cannot read ${p}: ${e.message}`); process.exit(2); } };
  let file, cls, planText;
  const specTexts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--class") cls = argv[++i];
    else if (a === "--plan") planText = read(argv[++i]);
    else if (a === "--spec") specTexts.push(read(argv[++i]));
    else if (a === "--rows" || a === "--json") continue;
    else if (a.startsWith("--") || file) { console.error(usage); return 2; }
    else file = a;
  }
  if (!file || (argv.includes("--class") && !CLASSES.concat("TRIVIAL").includes(cls))) { console.error(usage); return 2; }
  let report;
  try { report = JSON.parse(read(file)); } catch (e) { console.error(`invalid JSON in ${file}: ${e.message}`); return 2; }
  const r = validateReport(report, { cls, planText, specTexts, root: dirname(resolve(file)) });
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    r.errors.forEach((e) => console.error(`error: ${e}`));
    console.log(`RESULT: ${r.valid ? r.computed : "INVALID"}`);
    console.log(`SUMMARY: ${r.summary}`);
    if (argv.includes("--rows") && r.valid) r.rows.forEach((x) => console.log(x));
  }
  return r.valid ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
