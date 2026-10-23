#!/usr/bin/env node
// Validates a visual-proof report (report.json) and recomputes its result. No dependencies.
//   node validate-visual.mjs <report.json> [--class STANDARD|COMPLEX|CRITICAL] [--plan PLAN.md] [--spec FILE]...
//                            [--ui ui.json] [--rows] [--json]
// Screenshot paths are relative to the report's directory; every one must exist with its recorded sha256.
// Prints `RESULT: <PASS|FAIL|INCONCLUSIVE|UNSUPPORTED>` and one `SUMMARY:` line; `--rows` adds the finding rows
// for `agent.sh submit --findings` (severity|path:line|finding|evidence).
// Exit codes: 0 valid, 1 invalid, 2 usage or read error.
// A pass or fail item needs a numeric value and the threshold MEASURE.md documents for its check (or a stricter
// one), and its status is recomputed from value and threshold. `not_applicable` is only what measure.mjs writes
// when a page has nothing of that kind (NOT_APPLICABLE below: the check, selector `body`, the fixed reason as
// value), never next to a pass or fail of the same check in the cell; it is counted apart from passes.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_CHECKS, DESIGN_STATIC_CHECKS, DESIGN_MODES, DESIGN_VIEWPORTS, DESIGN_STATUSES, DESIGN_NOT_APPLICABLE_NOTE, DESIGN_NA_NOTES, ENGLISH_PAGE_NOTE,
  CRITIQUE_IDS, CRITIQUE_STATUSES, LIVE_THING_MODES, UX_REVIEW_STATUSES, CHART_TYPE_ID, NOTHING_TO_MEASURE, designApplies, designHolds, designThresholdError, expectedChecks } from "./design-audit.mjs";
import { validateLint } from "./lint-source.mjs";

export const SCHEMA = "visual-proof/1";
// ux-rules.json (A170): one entry per UX rule { id, severity, measure: <check id> | "judged" }; carried by this skill, no library needed.
export function loadUxRules(path = join(dirname(fileURLToPath(import.meta.url)), "..", "ux-rules.json")) {
  try { const j = JSON.parse(readFileSync(path, "utf8")); return Array.isArray(j.rules) ? j.rules : []; } catch { return []; }
}
// Checks every measured cell (screen x state x viewport) must account for: a measured item or a cell-level
// `not_measured` entry.
export const CORE = ["viewport_overflow", "horizontal_scroll", "hidden_interactive", "overlapping_interactive",
  "contrast", "touch_target", "state_rendered", "focus_order", "focus_visible"];
export const INTERACTION_CHECKS = ["long_content", "form_validation", "modal_interaction", "dropdown_interaction"];
// Native apps (0.0.24, references/NATIVE.md): checks of a report whose tool.kind is native-tool. A cell accounts for
// NATIVE_CORE; the large-text and dark-theme checks are measured only when the tool output carries them, else listed in target.not_measured.
export const NATIVE_CORE = ["native_state_present", "native_labels", "native_touch_target"];
export const NATIVE_OPTIONAL = ["native_large_text", "native_dark_theme"];
export const NATIVE_CHECKS = [...NATIVE_CORE, ...NATIVE_OPTIONAL];
export const CHECKS = [...CORE, ...INTERACTION_CHECKS, "a11y_scanner", ...NATIVE_CHECKS];
export const BASE_ASPECTS = ["hierarchy", "density", "consistency", "typography"];
export const CHARACTER = "character"; // required only for COMPLEX/CRITICAL with creative_direction.basis new|redesign (--ui)
export const ASPECTS = [...BASE_ASPECTS, CHARACTER];
export const TOOL_KINDS = ["project-tool", "headless-browser", "runtime-adapter", "native-tool", "none"];
export const TARGET_TYPES = ["web", "native-mobile", "desktop"];
export const CLASSES = ["STANDARD", "COMPLEX", "CRITICAL"];
export const MIN_VIEWPORTS = { STANDARD: 2, COMPLEX: 3, CRITICAL: 3 };
const RESULTS = ["PASS", "FAIL", "INCONCLUSIVE", "UNSUPPORTED"];
const STATUSES = ["pass", "fail", "not_applicable"];
const JUDGED = ["ok", "concern", "violation"];

// Documented thresholds (references/MEASURE.md): [operator, value]. A report may be stricter, never weaker.
// horizontal_scroll's bound is the viewport's clientWidth (at most its width); contrast 3 is for large text only.
export const THRESHOLDS = { viewport_overflow: ["<=", 0], hidden_interactive: [">", 1], overlapping_interactive: ["==", 0],
  contrast: [">=", 4.5], touch_target: [">=", 24], state_rendered: ["==", 1], focus_order: ["==", 0], focus_visible: ["==", 1],
  long_content: ["==", 0], form_validation: ["==", 0], modal_interaction: ["==", 0], dropdown_interaction: ["==", 0], a11y_scanner: ["==", 0],
  native_state_present: ["==", 1], native_labels: ["==", 0], native_touch_target: [">=", 44], native_large_text: ["==", 0], native_dark_theme: ["==", 0] };
export const NATIVE_TOUCH_MIN = { ios: 44, android: 48 }; // pt / dp
// The only not_applicable items: the page has no element of that kind (measure.mjs, value = this reason).
export const NOT_APPLICABLE = { hidden_interactive: "no focusable element", focus_order: "no focusable element", focus_visible: "no focusable element",
  overlapping_interactive: "no visible interactive element", contrast: "no visible text", touch_target: "no non-exempt target" };
const NO_FOCUSABLE = ["hidden_interactive", "focus_order", "focus_visible"];

// Technical SEO group (A158): measured per public HTML page and once per site, in `report.seo`, outside the
// screen x state x viewport cells. Every pass or fail item has value = the number of problems found, `== 0`.
export const SEO_PAGE_CHECKS = ["seo_title", "seo_description", "seo_canonical", "seo_h1", "seo_open_graph", "seo_structured_data"];
export const SEO_OPTIONAL_PAGE_CHECKS = ["seo_hreflang", "seo_analytics_consent"]; // hreflang: multilingual pages only; analytics: pages that contain an analytics script only
export const SEO_SITE_CHECKS = ["seo_sitemap", "seo_robots"];
export const SEO_CHECKS = [...SEO_PAGE_CHECKS, ...SEO_OPTIONAL_PAGE_CHECKS, ...SEO_SITE_CHECKS];
export const SEO_NOT_APPLICABLE_NOTE = "seo not applicable: no public HTML pages"; // the only text of a project without HTML pages
export const SEO_SITE = "site";
const SEO_PAGE_STATUSES = ["measured", "not_applicable", "not_measured"];

// null when the threshold is the documented one or stricter, else the reason it is not.
export function thresholdError(m, viewport) {
  const t = /^(<=|>=|==|<|>)\s*(-?\d+(?:\.\d+)?)$/.exec(String(m.threshold ?? "").trim());
  if (!t) return `threshold ${JSON.stringify(m.threshold)} is not numeric (<=, >=, ==, <, > and a number)`;
  const op = t[1], v = Number(t[2]);
  let want = THRESHOLDS[m.check];
  if (m.check === "horizontal_scroll") {
    // The bound is the measured clientWidth: at most the viewport width, or Chrome's 980px layout width for a
    // phone viewport (<= 480px, emulated as mobile) when the page has no viewport meta tag.
    if (!Number.isInteger(viewport?.width)) return "horizontal_scroll needs a listed viewport (its bound is the viewport width)";
    const cap = viewport.width <= 480 ? Math.max(viewport.width, 980) : viewport.width;
    const cw = m.client_width ?? viewport.width;
    if (!Number.isInteger(cw) || cw < 1 || cw > cap) return `horizontal_scroll client_width ${m.client_width} exceeds ${cap} (the viewport width, or 980 on a phone viewport without a viewport meta tag)`;
    want = ["<=", cw];
  }
  if (m.check === "native_touch_target") {
    const min = NATIVE_TOUCH_MIN[m.platform];
    if (!min) return "native_touch_target needs platform ios (>= 44pt) or android (>= 48dp)";
    want = [">=", min];
  }
  if (m.check === "contrast" && op === ">=" && v === 3) {
    // Large text (WCAG): >= 24px, or >= 18.66px bold, recomputed from the item's measured font facts.
    const size = m.font_size_px, weight = m.font_weight;
    if (typeof size !== "number" || typeof weight !== "number") return "contrast >= 3 is for large text only: the item needs font_size_px and font_weight (else the threshold is >= 4.5)";
    return size >= 24 || (size >= 18.66 && weight >= 700) ? null : `contrast >= 3 is for large text only: ${size}px weight ${weight} is not large (>= 24px, or >= 18.66px bold); the threshold is >= 4.5`;
  }
  if (!want) return null;
  const [wop, wv] = want;
  const ok = wop === "==" ? op === "==" && v === wv
    : wop === "<=" ? (op === "<=" && v <= wv) || (op === "<" && v <= wv)
    : wop === ">=" ? (op === ">=" && v >= wv) || (op === ">" && v >= wv)
    : (op === ">" && v >= wv) || (op === ">=" && v > wv);
  return ok ? null : `threshold ${m.threshold} is weaker than or unlike the documented ${wop} ${wv} for ${m.check} (references/MEASURE.md)`;
}

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

const measured0 = (r) => (Array.isArray(r?.measured) ? r.measured : []);

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
  const target = report.target;
  const native = tool.kind === "native-tool";
  const nativeTarget = isObj(target) && ["native-mobile", "desktop"].includes(target.type);
  if (target !== undefined && !(isObj(target) && target.type === undefined)) { // a web report's target {base_url} has no type (legacy shape)
    if (!isObj(target) || !TARGET_TYPES.includes(target.type)) err(`target.type must be one of ${TARGET_TYPES.join("|")}`);
    else if (target.evidence !== undefined && !(Array.isArray(target.evidence) && target.evidence.every((e) => str(e) || (isObj(e) && str(e.path))))) err("target.evidence must be a list of paths");
  }
  if (native && !nativeTarget) err("tool.kind native-tool needs a target block with type native-mobile or desktop");
  if (nativeTarget && !native && !unsupported) err(`a ${target.type} target is measured with tool.kind native-tool (or reported UNSUPPORTED with tool.kind none)`);
  if (nativeTarget && unsupported && !(str(report.suggestion) && !/[\r\n]/.test(report.suggestion))) err("a native UNSUPPORTED report needs suggestion: one line saying which tool addition would help (suggestion only)");
  if (!native && measured0(report).some((m) => NATIVE_CHECKS.includes(m?.check))) err("native checks are only allowed with tool.kind native-tool");
  if (unsupported) {
    if (!str(report.unsupported_reason)) err("tool.kind none needs unsupported_reason (what is missing)");
    if (measured.length || judged.length || cells.length) err("tool.kind none: measured, judged and cells must be empty (nothing was rendered)");
  } else if (report.unsupported_reason !== undefined && report.unsupported_reason !== null) {
    err("unsupported_reason is only allowed with tool.kind none");
  }
  if (!unsupported && tool.kind && !str(tool.name)) err("tool.name is required (the detected browser or project tool)");
  // M2: measure.mjs blocks every request outside the page's own origin (file: folder or localhost origin) and
  // lists them; a headless-browser report without that record did not run with the guard.
  const net = isObj(report.network) ? report.network : null;
  if (tool.kind === "headless-browser" && net?.interception !== "on") err("network.interception must be on for a headless-browser report (measure.mjs blocks requests outside the page's origin)");
  if (net && (!Array.isArray(net.blocked) || !net.blocked.every((b) => isObj(b) && str(b.url)))) err("network.blocked must be a list of {url, type}");
  const writes = Array.isArray(net?.same_origin_writes) ? net.same_origin_writes : [];
  if (net && net.same_origin_writes !== undefined && !(Array.isArray(net.same_origin_writes) && writes.every((w) => isObj(w) && str(w.method) && str(w.url)))) err("network.same_origin_writes must be a list of {method, url}");
  if (net && net.unguarded !== undefined && !(Array.isArray(net.unguarded) && net.unguarded.every(isObj))) err("network.unguarded must be a list");
  // A write the page sent to its own origin is allowed only when the plan or spec says the server's data is
  // throwaway: a `visual_writes: <how>` line (A50/A52).
  const writesAllowed = [...(opt.specTexts || []), opt.planText ?? ""].some((t) => /^\s*(?:[-*]\s*)?`?visual_writes:[ \t]*\S/m.test(String(t)));

  // --- depth ---------------------------------------------------------------------------------------------
  const min = native ? 1 : MIN_VIEWPORTS[report.class];
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
    if (!(native && c.screenshot === undefined)) checkFile(`cells[${i}].screenshot`, c.screenshot);
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
    else if (str(m.threshold) && CHECKS.includes(m.check)) {
      const te = thresholdError(m, viewports.find((v) => v?.name === m.viewport));
      if (te) err(`${w}: ${te}`);
      if (m.status === "not_applicable") {
        if (!(m.check in NOT_APPLICABLE) || m.interaction !== undefined) err(`${w}: not_applicable is not allowed for ${m.check} (only ${Object.keys(NOT_APPLICABLE).join(", ")}, when the page has nothing of that kind)`);
        else if (m.value !== NOT_APPLICABLE[m.check] || m.selector !== "body") err(`${w}: not_applicable ${m.check} needs selector body and the reason "${NOT_APPLICABLE[m.check]}" as value (got ${JSON.stringify(m.value)}); anything else is measured (pass/fail) or a not_measured entry`);
        else if (measured.some((o) => o !== m && o?.check === m.check && key(o) === key(m))) err(`${w}: not_applicable ${m.check} next to another ${m.check} item in ${key(m)}`);
        else if (NO_FOCUSABLE.includes(m.check) && !NO_FOCUSABLE.every((c) => measured.some((o) => o?.check === c && o.status === "not_applicable" && key(o) === key(m))))
          err(`${w}: "no focusable element" holds for hidden_interactive, focus_order and focus_visible together in ${key(m)}`);
      } else if (typeof m.value !== "number" || !Number.isFinite(m.value)) err(`${w}: a ${m.status} item needs a numeric value (got ${JSON.stringify(m.value)})`);
    }
    if (m.aspect !== undefined) err(`${w}: a measured item has no aspect (judged items are separate)`);
    if (INTERACTION_CHECKS.includes(m.check) && !str(m.interaction)) err(`${w}: an interaction check names its interaction`);
    const holds = thresholdHolds(m.value, m.threshold);
    if (holds !== null && m.status !== "not_applicable" && holds !== (m.status === "pass")) err(`${w}: status ${m.status} contradicts value ${m.value} ${m.threshold}`);
    if (m.criteria !== undefined && (!Array.isArray(m.criteria) || !m.criteria.every((c) => /^AC-\d+$/.test(c)))) err(`${w}: criteria must be a list of AC-<n>`);
    if (!(native && m.check === "native_state_present" && m.status === "fail" && m.evidence === undefined)) checkFile(`${w}.evidence`, m.evidence);
    if (native && m.check === "native_state_present" && m.status === "pass" && !cellKeys.get(key(m))?.screenshot) err(`${w}: native_state_present pass needs a screenshot on its cell`);
  }
  for (const [i, n] of notMeasured.entries()) {
    if (!isObj(n) || !["cell", "element"].includes(n.scope) || !str(n.reason) || !CHECKS.includes(n.check)) err(`not_measured[${i}]: needs scope cell|element, a known check and a reason`);
    else if (!cellKeys.has(key(n)) && !required.some((c) => key(c) === key(n))) err(`not_measured[${i}]: ${key(n)} is not a cell`);
  }

  // --- coverage: every required cell accounts for every core check -----------------------------------------
  const accounted = (check, c, interaction) => measured.some((m) => m.check === check && key(m) === key(c) && (!interaction || m.interaction === interaction))
    || notMeasured.some((n) => n.scope === "cell" && n.check === check && key(n) === key(c) && (!interaction || n.interaction === interaction));
  if (native && a11y?.status === "run") err("a11y_scanner must be not_available for a native report (the web scanner does not run)");
  const core = native ? NATIVE_CORE : a11y?.status === "run" ? [...CORE, "a11y_scanner"] : CORE;
  if (native) {
    const tnm = Array.isArray(target?.not_measured) ? target.not_measured : [];
    for (const check of NATIVE_OPTIONAL) if (!measured.some((m) => m.check === check) && !tnm.some((n) => n?.check === check && str(n.reason))) err(`${check} is neither measured nor listed in target.not_measured with a reason`);
  }
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
    const need = ["new", "redesign"].includes(opt.basis) ? ASPECTS : BASE_ASPECTS;
    for (const a of need) if (!judged.some((j) => j.aspect === a)) err(`class ${report.class} needs a judged item for ${a}`);
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

  // A160: analytics is "loaded" only when a third-party request before consent was measured (analytics_before_consent); a report
  // from before A160 has no such field and keeps its old rule (analytics_detected).
  const analyticsLoaded = (p) => (p.analytics_before_consent !== undefined ? p.analytics_before_consent : p.analytics_detected) || [];
  // --- seo (A158): optional; consistency of the technical SEO group ----------------------------------------
  const seo = report.seo;
  const seoItems = [];
  if (seo !== undefined) {
    if (unsupported) err("seo must be absent when tool.kind is none (nothing was rendered)");
    else if (!isObj(seo) || !["run", "not_applicable"].includes(seo.status)) err("seo.status must be run or not_applicable");
    else if (seo.status === "not_applicable") {
      if (seo.note !== SEO_NOT_APPLICABLE_NOTE) err(`seo not_applicable needs the fixed note "${SEO_NOT_APPLICABLE_NOTE}"`);
      if ((seo.pages !== undefined && !(Array.isArray(seo.pages) && !seo.pages.length)) || (seo.items !== undefined && !(Array.isArray(seo.items) && !seo.items.length))) err("seo not_applicable: the group does not run, so pages and items must be empty or absent");
    } else if (!Array.isArray(seo.pages) || !Array.isArray(seo.items)) err("seo run needs pages[] and items[]");
    else {
      const pg = new Map();
      for (const [i, p] of seo.pages.entries()) {
        const w = `seo.pages[${i}]`;
        if (!isObj(p) || !str(p.path) || !SEO_PAGE_STATUSES.includes(p.status) || pg.has(p.path)) { err(`${w}: needs a unique path and status ${SEO_PAGE_STATUSES.join("|")}`); continue; }
        pg.set(p.path, p);
        if (p.status === "not_applicable" && p.reason !== "robots") err(`${w}: not_applicable is only for a page blocked by robots (reason: robots)`);
        if (p.status === "not_applicable" && !str(p.detail)) err(`${w}: not_applicable needs a non-empty detail (why robots blocks the page)`);
        if (p.status === "not_measured" && !str(p.reason)) err(`${w}: not_measured needs a reason`);
        else if (p.status === "not_measured" && !/^not an HTML response/.test(p.reason)) designNm.push(`page ${p.screen}`);
        if (p.analytics_detected !== undefined && !(Array.isArray(p.analytics_detected) && p.analytics_detected.every(str))) err(`${w}: analytics_detected must be a list of names`);
        for (const k of ["analytics_before_consent", "third_party_requests"]) if (p[k] !== undefined && !(Array.isArray(p[k]) && p[k].every(str))) err(`${w}: ${k} must be a list of URLs`);
      }
      const sids = new Set(), seen = new Set();
      for (const [i, m] of seo.items.entries()) {
        const w = `seo.items[${i}]`;
        if (!isObj(m)) { err(`${w}: must be an object`); continue; }
        if (!/^S-\d+$/.test(m.id || "") || sids.has(m.id)) err(`${w}: id must be a unique S-<n>`);
        sids.add(m.id);
        if (!SEO_CHECKS.includes(m.check)) { err(`${w}: unknown check ${m.check}`); continue; }
        const site = SEO_SITE_CHECKS.includes(m.check);
        const p = pg.get(m.page);
        if (site ? m.page !== SEO_SITE : !p || p.status !== "measured") err(`${w}: ${m.check} belongs to ${site ? `page "${SEO_SITE}"` : "a measured page listed in seo.pages"} (got ${JSON.stringify(m.page)})`);
        if (seen.has(`${m.page}|${m.check}`)) err(`${w}: duplicate ${m.check} for ${m.page}`);
        seen.add(`${m.page}|${m.check}`);
        if (!str(m.selector)) err(`${w}: selector is required`);
        if (m.threshold !== "== 0") err(`${w}: threshold must be "== 0" (value = problems found)`);
        if (m.status === "not_measured") { if (!str(m.reason)) err(`${w}: not_measured needs a reason`); }
        else if (m.status === "pass" || m.status === "fail") {
          if (!Number.isInteger(m.value) || m.value < 0) err(`${w}: a ${m.status} item needs a non-negative integer value (problems found)`);
          else if ((m.value === 0) !== (m.status === "pass")) err(`${w}: status ${m.status} contradicts value ${m.value} == 0`);
          if (!str(m.evidence)) err(`${w}: evidence (the observed values) is required`);
          if (m.status === "fail" && !str(m.note)) err(`${w}: a failing item says what is wrong (note)`);
        } else err(`${w}: status must be pass|fail|not_measured`);
        if (m.check === "seo_analytics_consent" && p && !analyticsLoaded(p).length) err(`${w}: no third-party analytics request before consent was measured on ${m.page}: nothing is measured or recommended`);
        seoItems.push(m);
      }
      const measuredPages = [...pg.values()].filter((p) => p.status === "measured");
      for (const p of measuredPages) {
        for (const c of SEO_PAGE_CHECKS) if (!seen.has(`${p.path}|${c}`)) err(`seo page ${p.path}: ${c} is neither measured nor listed as not_measured`);
        if (analyticsLoaded(p).length && !seen.has(`${p.path}|seo_analytics_consent`)) err(`seo page ${p.path}: a third-party analytics request before consent was measured, seo_analytics_consent is required`);
      }
      if (measuredPages.length) for (const c of SEO_SITE_CHECKS) if (!seen.has(`${SEO_SITE}|${c}`)) err(`seo site: ${c} is neither measured nor listed as not_measured`);
      for (const p of pg.values()) if (p.status !== "measured" && seo.items.some((m) => m?.page === p.path)) err(`seo page ${p.path}: a page that is not measured has no items`);
    }
  }

  // --- design (0.0.27, A170): optional; consistency of the design group and the judged critique -------------
  const design = report.design;
  const designItems = [];
  const designNm = []; // requested design checks that could not be measured: they keep the result from PASS
  const dvp = new Set(DESIGN_VIEWPORTS.map((v) => v.name));
  if (design !== undefined) {
    if (unsupported) err("design must be absent when tool.kind is none (nothing was rendered)");
    else if (!isObj(design) || !["run", "not_applicable"].includes(design.status)) err("design.status must be run or not_applicable");
    else if (!DESIGN_MODES.includes(design.mode)) err(`design.mode must be one of ${DESIGN_MODES.join("|")}`);
    else if (design.status === "not_applicable") {
      if (design.note !== DESIGN_NOT_APPLICABLE_NOTE) err(`design not_applicable needs the fixed note "${DESIGN_NOT_APPLICABLE_NOTE}"`);
      for (const k of ["pages", "items", "scenes", "images", "screenshots", "not_measured"]) if (design[k] !== undefined && !(Array.isArray(design[k]) && !design[k].length)) err(`design not_applicable: ${k} must be empty or absent`);
    } else {
      const arr = (k) => (Array.isArray(design[k]) ? design[k] : design[k] === undefined ? [] : (err(`design.${k} must be an array`), []));
      const pages = arr("pages"), items = arr("items"), shots = arr("screenshots"), scenes = arr("scenes"), images = arr("images"), dnm = arr("not_measured");
      if (!Array.isArray(design.pages) || !Array.isArray(design.items)) err("design run needs pages[] and items[]");
      const same = Array.isArray(design.viewports) && design.viewports.length === DESIGN_VIEWPORTS.length && DESIGN_VIEWPORTS.every((v, i) => design.viewports[i]?.name === v.name && design.viewports[i]?.width === v.width);
      if (!same) err(`design.viewports must be ${DESIGN_VIEWPORTS.map((v) => `${v.name} ${v.width}`).join(", ")} (the design group's own viewports)`);
      const pg = new Map();
      for (const [i, p] of pages.entries()) {
        const w = `design.pages[${i}]`;
        if (!isObj(p) || !str(p.screen) || !str(p.path) || !["measured", "not_measured"].includes(p.status) || typeof p.static !== "boolean" || pg.has(p.screen)) { err(`${w}: needs a unique screen, a path, a static flag and status measured|not_measured`); continue; }
        if (p.status === "not_measured" && !str(p.reason)) err(`${w}: not_measured needs a reason`);
        else if (p.status === "not_measured" && !/^not an HTML response/.test(p.reason)) designNm.push(`page ${p.screen}`);
        if (p.language !== undefined && !str(p.language)) err(`${w}: language must be a non-empty string`);
        if (!p.static && p.language === undefined) err(`${w}: a page that is neither static nor a language entry measures nothing`);
        pg.set(p.screen, p);
      }
      const pageOf = (name) => pg.get(name) || [...pg.values()].find((p) => p.path === name);
      for (const [i, s] of shots.entries()) {
        const w = `design.screenshots[${i}]`;
        if (!isObj(s) || !str(s.screen) || !dvp.has(s.viewport) || !pageOf(s.screen)) { err(`${w}: needs a listed page and a design viewport`); continue; }
        checkFile(`${w}.screenshot`, s.screenshot);
      }
      const dids = new Set();
      for (const [i, m] of items.entries()) {
        const w = `design.items[${i}]`;
        if (!isObj(m)) { err(`${w}: must be an object`); continue; }
        if (!/^D-\d+$/.test(m.id || "") || dids.has(m.id)) err(`${w}: id must be a unique D-<n>`);
        dids.add(m.id);
        if (!DESIGN_CHECKS.includes(m.check)) { err(`${w}: unknown check ${m.check}`); continue; }
        const own = DESIGN_STATIC_CHECKS.includes(m.check);
        if (!str(m.screen) || (own && !pageOf(m.screen))) err(`${w}: screen must name a page listed in design.pages (got ${JSON.stringify(m.screen)})`);
        else if (own && pageOf(m.screen).status !== "measured") err(`${w}: a page that is not measured has no items`);
        if (!str(m.viewport) || (own && !dvp.has(m.viewport))) err(`${w}: viewport must be one of ${[...dvp].join(", ")}`);
        if (!str(m.selector)) err(`${w}: selector is required`);
        if (!str(m.threshold)) err(`${w}: threshold is required`);
        if (!DESIGN_STATUSES.includes(m.status)) { err(`${w}: status must be ${DESIGN_STATUSES.join("|")}`); continue; }
        if (str(m.threshold)) { const te = designThresholdError(m.check, design.mode, m.viewport, m.threshold); if (te) err(`${w}: ${te}`); }
        if (m.status === "pass" || m.status === "fail") {
          if (typeof m.value !== "number" || !Number.isFinite(m.value)) err(`${w}: a ${m.status} item needs a numeric value (got ${JSON.stringify(m.value)})`);
          const holds = designHolds(m.value, m.threshold);
          if (holds === null) err(`${w}: threshold ${JSON.stringify(m.threshold)} with value ${JSON.stringify(m.value)} cannot be evaluated (a numeric comparison like "== 0" or ">= 3" is required)`);
          else if (holds !== (m.status === "pass")) err(`${w}: status ${m.status} contradicts value ${m.value} ${m.threshold}`);
          if (m.check === "design_motion_count") {
            const mm = isObj(design.motion_min) ? design.motion_min : {};
            const t = /^>=\s*(\d+)$/.exec(String(m.threshold).trim());
            if (!["load", "scroll"].includes(m.phase)) err(`${w}: a measured design_motion_count item names its phase (load or scroll)`);
            else if (!Number.isInteger(mm[m.phase])) err(`${w}: design.motion_min.${m.phase} must be an integer`);
            else if (!t || Number(t[1]) < mm[m.phase]) err(`${w}: design_motion_count ${m.phase} threshold ${JSON.stringify(m.threshold)} is weaker than motion_min.${m.phase} (>= ${mm[m.phase]})`);
          }
          if (m.check === "design_scene") {
            const sg = Number(String(m.threshold).replace(/\D+/g, ""));
            if (m.motion === "normal" && !(/^>=/.test(String(m.threshold).trim()) && sg >= 1)) err(`${w}: a normal-motion scene item is ">= 1" (started)`);
            if (m.motion === "reduced" && String(m.threshold).trim() !== "== 0") err(`${w}: a reduced-motion scene item is "== 0" (hidden elements)`);
            const row = scenes.find((s) => isObj(s) && s.id === m.scene && s.viewport === m.viewport && s.motion === m.motion);
            if (row && m.motion === "normal" && row.started !== (m.status === "pass")) err(`${w}: status ${m.status} contradicts design.scenes started=${row.started}`);
            if (row && m.motion === "reduced" && row.content_visible !== undefined && row.content_visible !== (m.status === "pass")) err(`${w}: status ${m.status} contradicts design.scenes content_visible=${row.content_visible}`);
          }
          if (m.status === "fail" && !str(m.note)) err(`${w}: a failing item says what is wrong (note)`);
          if (own && m.screenshot === undefined) err(`${w}: a measured ${m.check} item needs the page screenshot`);
        } else if (m.status === "not_measured") {
          if (!str(m.reason ?? m.note)) err(`${w}: not_measured needs a reason`);
          else if (!NOTHING_TO_MEASURE.includes(m.reason ?? m.note)) designNm.push(`${m.id} ${m.check} at ${m.screen}/${m.viewport}`);
        }
        else {
          const byMode = !designApplies(m.check, design.mode) && DESIGN_NA_NOTES[m.check] !== undefined && m.note === DESIGN_NA_NOTES[m.check];
          const english = m.check === "design_untranslated" && m.note === ENGLISH_PAGE_NOTE;
          if (own || m.check === "design_motion_count") { if (!(byMode || english)) err(`${w}: not_applicable ${m.check} is only for ${m.check === "design_untranslated" ? "an English page" : "a mode that does not require it"}, with the fixed note`); }
          else if (!str(m.note)) err(`${w}: not_applicable needs a note`);
        }
        if (m.screenshot !== undefined) checkFile(`${w}.screenshot`, m.screenshot);
        if (!designApplies(m.check, design.mode) && m.status !== "not_applicable") err(`${w}: ${m.check} does not apply in ${design.mode} mode; the item must be not_applicable`);
        designItems.push(m);
      }
      const accounted = (check, page, viewport) => designItems.some((m) => m.check === check && (m.screen === page.screen || m.screen === page.path) && (!viewport || m.viewport === viewport))
        || dnm.some((n) => isObj(n) && n.check === check && (n.screen === page.screen || n.screen === page.path) && (!viewport || n.viewport === viewport) && str(n.reason));
      for (const p of pg.values()) {
        if (p.status !== "measured") { if (designItems.some((m) => m.screen === p.screen)) err(`design page ${p.screen}: a page that is not measured has no items`); continue; }
        for (const v of dvp) {
          const want = expectedChecks(p, design.mode, v);
          for (const check of want) if (!accounted(check, p, v)) err(`design page ${p.screen} at ${v}: ${check} is neither measured nor listed as not_measured`);
          const shotted = shots.some((s) => s.screen === p.screen && s.viewport === v);
          const allNm = designItems.filter((m) => m.screen === p.screen && m.viewport === v).every((m) => m.status === "not_measured");
          if (want.length && !shotted && !allNm) err(`design page ${p.screen} at ${v}: no screenshot (every measured page is photographed at the design viewports)`);
        }
        if (p.static) {
          for (const c of ["design_motion_count", "design_reduced_motion", "design_no_script_visible"]) if (!accounted(c, p)) err(`design page ${p.screen}: ${c} is neither measured nor listed as not_measured`);
          if (str(design.image_ledger) && !accounted("design_image_ledger", p)) err(`design page ${p.screen}: design_image_ledger is neither measured nor listed as not_measured (an image ledger is configured)`);
        }
      }
      for (const [i, n] of dnm.entries()) { if (!isObj(n) || !DESIGN_CHECKS.includes(n.check) || !str(n.reason)) err(`design.not_measured[${i}]: needs a known design check and a reason`); else designNm.push(`${n.check} at ${n.screen ?? n.scene ?? "?"}/${n.viewport ?? "-"}`); }
      const sids = new Set();
      for (const [i, s] of scenes.entries()) {
        const w = `design.scenes[${i}]`;
        if (!isObj(s) || !str(s.id) || !str(s.screen) || !str(s.viewport) || !["normal", "reduced"].includes(s.motion) || !Array.isArray(s.stops) || typeof s.started !== "boolean") { err(`${w}: needs id, screen, viewport, motion normal|reduced, stops[] and started true|false`); continue; }
        sids.add(s.id);
        if (s.started === false && !str(s.reason)) err(`${w}: started false needs a reason`);
        for (const [j, st] of s.stops.entries()) { if (!isObj(st) || typeof st.at !== "number") err(`${w}.stops[${j}]: needs at (percent of the scene's scroll range)`); else checkFile(`${w}.stops[${j}].screenshot`, st.screenshot); }
      }
      for (const id of Array.isArray(design.scene_ids) ? design.scene_ids : []) if (!sids.has(id) && !dnm.some((n) => n?.check === "design_scene" && (n.scene === id || n.scene === undefined) && str(n.reason))) err(`design scene ${id} is neither photographed nor listed as not_measured`);
      for (const [i, im] of images.entries()) if (!isObj(im) || !str(im.src) || typeof im.in_ledger !== "boolean") err(`design.images[${i}]: needs src and in_ledger true|false`);
    }
  }
  const critique = report.critique;
  if (critique !== undefined) {
    if (!Array.isArray(critique)) err("critique must be an array");
    else if (unsupported) err("critique must be absent when tool.kind is none");
    else if (report.class === "STANDARD" && critique.length) err("class STANDARD is measured only: critique must be empty");
    else {
      const seen = new Set(), mode = isObj(design) ? design.mode : undefined;
      for (const [i, c] of critique.entries()) {
        const w = `critique[${i}]`;
        if (!isObj(c)) { err(`${w}: must be an object`); continue; }
        if (Object.keys(c).some((k) => /score|rating|points/i.test(k))) err(`${w}: a critique item has no numeric score (ok or concern, with a reason)`);
        if (!CRITIQUE_IDS.includes(c.id) || seen.has(c.id)) err(`${w}: id must be a unique one of ${CRITIQUE_IDS.join(", ")}`);
        seen.add(c.id);
        if (!CRITIQUE_STATUSES.includes(c.status)) err(`${w}: status must be ${CRITIQUE_STATUSES.join("|")}`);
        if (!str(c.reason)) err(`${w}: reason is required`);
        if (c.status === "not_applicable") {
          if (c.id !== "one_live_thing" || LIVE_THING_MODES.includes(mode)) err(`${w}: only one_live_thing is not_applicable, and only outside persuade and experience`);
          if (c.screenshot !== undefined) checkFile(`${w}.screenshot`, c.screenshot);
        } else {
          if (c.id === "one_live_thing" && mode !== undefined && !LIVE_THING_MODES.includes(mode)) err(`${w}: one_live_thing is not_applicable outside persuade and experience`);
          checkFile(`${w}.screenshot`, c.screenshot);
        }
      }
      if (isObj(design) && design.status === "run" && report.class !== "STANDARD") for (const id of CRITIQUE_IDS) if (!seen.has(id)) err(`class ${report.class} with a design group needs a critique item for ${id}`);
    }
  }
  if (isObj(design) && design.status === "run" && report.class !== "STANDARD" && critique === undefined) err(`class ${report.class} with a design group needs critique[] (the 14 judged items)`);

  // --- ux_review (A170): judged UX rules; required for COMPLEX/CRITICAL with a design group, only for rules judged AND high ------
  const uxRules = opt.uxRules || loadUxRules();
  const uxById = new Map(uxRules.map((r) => [r.id, r]));
  const uxr = report.ux_review;
  const uxSeen = new Set();
  if (uxr !== undefined) {
    if (!Array.isArray(uxr)) err("ux_review must be an array");
    else if (unsupported) err("ux_review must be absent when tool.kind is none");
    else if (report.class === "STANDARD" && uxr.length) err("class STANDARD is measured only: ux_review must be empty");
    else {
      for (const [i, c] of uxr.entries()) {
        const w = `ux_review[${i}]`;
        if (!isObj(c)) { err(`${w}: must be an object`); continue; }
        if (Object.keys(c).some((k) => /score|rating|points/i.test(k))) err(`${w}: a ux_review item has no numeric score (ok or concern, with a reason)`);
        const rule = uxById.get(c.rule);
        if (!rule && c.rule !== CHART_TYPE_ID) err(`${w}: rule ${JSON.stringify(c.rule)} is not in ux-rules.json (or ${CHART_TYPE_ID})`);
        else if (rule && rule.measure !== "judged") err(`${w}: rule ${c.rule} is measured by ${rule.measure}, not judged; it has no ux_review item`);
        if (uxSeen.has(c.rule)) err(`${w}: rule ${c.rule} is listed twice`);
        uxSeen.add(c.rule);
        if (!UX_REVIEW_STATUSES.includes(c.status)) err(`${w}: status must be ${UX_REVIEW_STATUSES.join("|")}`);
        if (!str(c.reason)) err(`${w}: reason is required`);
        if (c.status === "not_applicable") { if (c.screenshot !== undefined) checkFile(`${w}.screenshot`, c.screenshot); }
        else checkFile(`${w}.screenshot`, c.screenshot);
      }
    }
  }
  if (isObj(design) && design.status === "run" && report.class !== "STANDARD" && !unsupported) {
    const missing = uxRules.filter((r) => r.measure === "judged" && r.severity === "high" && !uxSeen.has(r.id)).map((r) => r.id);
    if (missing.length) err(`class ${report.class} with a design group needs a ux_review item (ok, concern or not_applicable with a reason) for every judged high-severity rule; missing ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ` and ${missing.length - 6} more` : ""}`);
  }

  // --- lint.json beside report.json (0.0.27): shape by validateLint; blocking findings close the gate -------
  let lint = opt.lint;
  if (lint === undefined) {
    const lp = join(root, "lint.json");
    if (existsSync(lp)) { try { lint = JSON.parse(readFileSync(lp, "utf8")); } catch (e) { err(`lint.json: invalid JSON (${e.message.slice(0, 80)})`); } }
  }
  let lintBlocking = [];
  if (lint !== undefined && lint !== null) {
    const lr = validateLint(lint);
    for (const m of Array.isArray(lr) ? lr : lr?.errors || []) err(`lint.json: ${m}`);
    lintBlocking = (isObj(lint) && Array.isArray(lint.findings) ? lint.findings : []).filter((f) => isObj(f) && f.severity === "blocking");
  }

  // --- result --------------------------------------------------------------------------------------------
  const reasons = [];
  let computed;
  if (unsupported) computed = "UNSUPPORTED";
  else {
    for (const m of measured) if (m.status === "fail") reasons.push(`${m.id} ${m.check} failed`);
    for (const j of judged) if (j.status === "violation") reasons.push(`${j.id} violates ${j.violates?.ref}`);
    for (const m of seoItems) if (m.status === "fail") reasons.push(`${m.id} ${m.check} failed`);
    for (const m of designItems) if (m.status === "fail") reasons.push(`${m.id} ${m.check} failed`);
    for (const f of lintBlocking) reasons.push(`lint ${f.id} at ${f.file}:${f.line} (blocking)`);
    if (reg?.status === "run" && reg.exit !== 0) reasons.push("visual regression failed");
    if (reasons.length) computed = "FAIL";
    else {
      for (const n of notMeasured) if (n.scope === "cell") reasons.push(`not measured: ${n.check} at ${key(n)}`);
      for (const n of designNm) reasons.push(`design not measured: ${n}`);
      // A93 caps: no PASS without the network guard, with a write lacking an allowance, or with an unguarded worker.
      if (!native && net?.interception !== "on") reasons.push("network interception not applied (the adapter must block requests outside the page's origin)");
      if (writes.length && !writesAllowed) reasons.push(`${writes.length} same-origin write(s) without a visual_writes allowance in the plan or spec: ${writes.slice(0, 3).map((w) => `${w.method} ${w.url}`).join(", ")}`);
      if (Array.isArray(net?.unguarded) && net.unguarded.length) reasons.push(`${net.unguarded.length} child target(s) ran without the network guard`);
      for (const c of criteria) if (c?.required && computedCriteria[c.id] === "unproven") reasons.push(`${c.id} unproven`);
      if (native && !measured.some((m) => m.status === "pass" && m.check !== "native_state_present")) reasons.push("native report has no measured cell (no label, touch-target, large-text or dark-theme measurement passed)");
      computed = reasons.length ? "INCONCLUSIVE" : "PASS";
    }
  }
  if (RESULTS.includes(report.result) && report.result !== computed) err(`result ${report.result} contradicts the evidence (computed ${computed}${reasons.length ? ": " + reasons.slice(0, 4).join("; ") : ""})`);

  const shots = new Set([...cells.map((c) => c?.screenshot?.path), ...measured.map((m) => m?.evidence?.path), ...judged.map((j) => j?.screenshot?.path), ...(Array.isArray(design?.screenshots) ? design.screenshots.map((x) => x?.screenshot?.path) : [])].filter(Boolean));
  const fails = measured.filter((m) => m.status === "fail");
  const na = measured.filter((m) => m.status === "not_applicable").length;
  const blocked = Array.isArray(net?.blocked) ? net.blocked.length : 0;
  const writesNote = writes.length ? ` same_origin_writes=${writes.length}${writesAllowed ? " (allowed)" : ""};` : "";
  const seoNote = isObj(seo) ? (seo.status === "run" ? `; seo=${seoItems.filter((m) => m.status === "pass").length}/${seoItems.length} pass, ${seoItems.filter((m) => m.status === "fail").length} fail, ${seoItems.filter((m) => m.status === "not_measured").length} not_measured` : "; seo=not_applicable") : "";
  const dCount = (st) => designItems.filter((m) => m.status === st).length;
  const designNote = isObj(design) ? (design.status === "run" ? `; design=${dCount("pass")}/${designItems.length} pass, ${dCount("fail")} fail, ${dCount("not_measured")} not_measured, ${dCount("not_applicable")} not_applicable (${design.mode})` : "; design=not_applicable") : "";
  const critNote = (Array.isArray(critique) && critique.length ? `; critique=${critique.filter((c) => c?.status === "concern").length} concern of ${critique.length}` : "")
    + (Array.isArray(uxr) && uxr.length ? `; ux_review=${uxr.filter((c) => c?.status === "concern").length} concern of ${uxr.length}` : "");
  const lintNote = lint ? `; lint=${lintBlocking.length} blocking of ${Array.isArray(lint?.findings) ? lint.findings.length : 0}` : "";
  const summary = `visual-proof: ${computed} class=${report.class} tool=${tool.kind}${tool.name ? ":" + tool.name : ""} cells=${cells.length} viewports=${[...vpNames].join(",") || "-"} measured=${measured.length - fails.length - na}/${measured.length} pass, ${fails.length} fail, ${na} not_applicable; blocked_requests=${blocked};${writesNote} judged=${judged.length} (violations ${judged.filter((j) => j.status === "violation").length}); screenshots=${shots.size}; criteria ${Object.entries(computedCriteria).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}${unsupported ? `; unsupported: ${report.unsupported_reason}` : ""}${seoNote}${designNote}${critNote}${lintNote}${isObj(target) ? `; target=${target.type}${target.platform ? ":" + target.platform : ""}${target.via ? " via " + target.via : ""}` : ""}`;
  return { valid: errors.length === 0, errors, result: report.result, computed, reasons, criteria: computedCriteria, summary, rows: rowsOf(report, fails, judged, seoItems, designItems, lintBlocking) };
}

// Finding rows for `agent.sh submit --findings`: one blocking row per failed measurement or judged violation,
// one info row per judged concern. The location is `<screen path>:<selector>`; replace it with the source
// `path:line` once the rule is located.
function rowsOf(report, fails, judged, seoItems = [], designItems = [], lintBlocking = []) {
  const clean = (s) => String(s).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  const path = (id) => (report.screens || []).find((s) => s?.id === id)?.path || id;
  const rows = fails.map((m) => ["blocking", `${path(m.screen)}:${m.selector}`, `${m.id} ${m.check}: ${m.value} fails ${m.threshold} at ${m.screen}/${m.state}/${m.viewport}${m.criteria?.length ? " (" + m.criteria.join(",") + ")" : ""}`, `measured; ${m.evidence?.path} sha256:${String(m.evidence?.sha256).slice(0, 12)}`]);
  for (const j of judged) {
    if (j.status === "ok") continue;
    rows.push([j.status === "violation" ? "blocking" : "info", `${path(j.screen)}:${j.aspect}`, `${j.id} judged ${j.aspect}: ${j.observation}${j.status === "violation" ? ` (violates ${j.violates?.ref})` : ""}`, `judged; ${j.screenshot?.path} against ${j.spec_ref}`]);
  }
  // seo (A158): a failed item blocks; an item that could not be measured is informational, never blocking.
  for (const m of seoItems) {
    if (m.status === "fail") rows.push(["blocking", `${m.page}:${m.selector}`, `${m.id} ${m.check}: ${m.value} problem(s): ${m.note}`, `measured; seo ${String(m.evidence).slice(0, 120)}`]);
    else if (m.status === "not_measured") rows.push(["info", `${m.page}:${m.selector}`, `${m.id} ${m.check} not measured: ${m.reason}`, "not_measured"]);
  }
  for (const p of Array.isArray(report.seo?.pages) ? report.seo.pages : []) {
    if (p?.status !== "measured") continue;
    if ((p.analytics_detected || []).length && p.analytics_before_consent !== undefined && !p.analytics_before_consent.length) rows.push(["info", `${p.path}:analytics`, `analytics candidate found by name only (${p.analytics_detected.join(", ")}); no third-party request before consent was measured`, "measured; seo network"]);
    if ((p.third_party_requests || []).length) rows.push(["info", `${p.path}:network`, `third-party request(s) before consent that match no analytics candidate: ${p.third_party_requests.slice(0, 3).join(", ")}`, "measured; seo network"]);
  }
  for (const p of Array.isArray(report.seo?.pages) ? report.seo.pages : []) if (p?.status === "not_measured") rows.push(["info", `${p.path}:seo`, `seo not measured for ${p.path}: ${p.reason}`, "not_measured"]);
  // design (A170): a failed item blocks; an item that could not be measured and a critique concern are informational.
  const spath = (id) => (report.design?.pages || []).find((p) => p?.screen === id)?.path || path(id);
  for (const m of designItems) {
    if (m.status === "fail") rows.push(["blocking", `${spath(m.screen)}:${m.selector}`, `${m.id} ${m.check}: ${m.value} fails ${m.threshold} at ${m.screen}/${m.viewport}: ${m.note}`, `measured; ${m.screenshot?.path || "design"} sha256:${String(m.screenshot?.sha256 || "").slice(0, 12)}`]);
    else if (m.status === "not_measured") rows.push(["info", `${spath(m.screen)}:${m.selector}`, `${m.id} ${m.check} not measured at ${m.screen}/${m.viewport}: ${m.reason ?? m.note}`, "not_measured"]);
  }
  for (const c of Array.isArray(report.critique) ? report.critique : []) if (c?.status === "concern") rows.push(["info", `critique:${c.id}`, `critique ${c.id}: ${c.reason}`, `judged; ${c.screenshot?.path}`]);
  for (const c of Array.isArray(report.ux_review) ? report.ux_review : []) if (c?.status === "concern") rows.push(["info", `ux_review:${c.rule}`, `ux rule ${c.rule}: ${c.reason}`, `judged; ${c.screenshot?.path}`]);
  for (const f of lintBlocking) rows.push(["blocking", `${f.file}:${f.line}`, `lint ${f.id}: ${f.excerpt ?? f.reason ?? "registry pattern without a written justification"}`, "measured; lint.json"]);
  return rows.map((r) => r.map(clean).join("|"));
}

export const submitReason = (r) => `visual INCONCLUSIVE: ${r.reasons.slice(0, 6).join("; ").replace(/["|\n]/g, "/")}${r.reasons.length > 6 ? `; +${r.reasons.length - 6} more` : ""}; not a FAIL; measure the missing cells or the user waives`;

function main(argv) {
  const usage = "usage: validate-visual.mjs <report.json> [--class STANDARD|COMPLEX|CRITICAL] [--plan PLAN.md] [--spec FILE]... [--ui ui.json] [--rows] [--json]";
  const read = (p) => { try { return readFileSync(p, "utf8"); } catch (e) { console.error(`cannot read ${p}: ${e.message}`); process.exit(2); } };
  let file, cls, planText, basis;
  const specTexts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--class") cls = argv[++i];
    else if (a === "--plan") planText = read(argv[++i]);
    else if (a === "--spec") specTexts.push(read(argv[++i]));
    else if (a === "--ui") { try { basis = JSON.parse(read(argv[++i]))?.creative_direction?.basis; } catch (e) { console.error(`invalid JSON in --ui: ${e.message}`); return 2; } }
    else if (a === "--rows" || a === "--json") continue;
    else if (a.startsWith("--") || file) { console.error(usage); return 2; }
    else file = a;
  }
  if (!file || (argv.includes("--class") && !CLASSES.concat("TRIVIAL").includes(cls))) { console.error(usage); return 2; }
  let report;
  try { report = JSON.parse(read(file)); } catch (e) { console.error(`invalid JSON in ${file}: ${e.message}`); return 2; }
  const r = validateReport(report, { cls, planText, specTexts, basis, root: dirname(resolve(file)) });
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    r.errors.forEach((e) => console.error(`error: ${e}`));
    console.log(`RESULT: ${r.valid ? r.computed : "INVALID"}`);
    console.log(`SUMMARY: ${r.summary}`);
    if (argv.includes("--rows") && r.valid) {
      // L1: INCONCLUSIVE is submitted like performance-proof's: UNSUPPORTED with a prefixed reason (blocking).
      if (r.computed === "INCONCLUSIVE") console.log(`SUBMIT: --result UNSUPPORTED --reason "${submitReason(r)}"`);
      r.rows.forEach((x) => console.log(x));
    }
  }
  return r.valid ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
