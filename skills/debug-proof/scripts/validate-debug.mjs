#!/usr/bin/env node
// Validates a debug-proof debug.json (see ../schema/debug.schema.json).
// Usage: node validate-debug.mjs <debug.json | result.md> [--scope <path,path,...>]
// A .md input is read through its first ```json fenced block.
// Exit: 0 valid, 1 invalid, 2 usage/read error. No dependencies.
import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const safeRel = (p) => isStr(p) && !isAbsolute(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0");
// A regression test that fails for one of these reasons did not fail on the bug's assertion.
const NOT_ASSERTION = /SyntaxError|IndentationError|error TS\d+|error CS\d+|error\[E\d+\]|could not compile|\[build failed\]|COMPILATION ERROR|cannot find symbol|ModuleNotFoundError|\bImportError\b|Cannot find module|ERR_MODULE_NOT_FOUND|Failed to resolve import|No module named|\bENOENT\b|no such file or directory|collected 0 items|no tests? (were )?(found|ran)|ERROR at setup of|Test suite failed to run|"before (each|all)" hook|\bundefined: \w+/i;
const KEYS = ["schema_version", "kind", "status", "symptom", "reproduction", "hypotheses", "experiments", "bisect", "root_cause", "fix", "regression_test", "blocked_reason", "next_experiment"];

export function validate(doc, { scope = null } = {}) {
  const errors = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  if (!isObj(doc)) return ["$: expected object"];
  for (const k of ["schema_version", "kind", "status", "symptom", "reproduction", "hypotheses", "experiments", "bisect"]) if (!(k in doc)) err("$", `missing required "${k}"`);
  for (const k of Object.keys(doc)) if (!KEYS.includes(k)) err("$", `unexpected "${k}"`);
  if (doc.schema_version !== 1) err("$.schema_version", "must be 1");
  if (!["bug", "build_error"].includes(doc.kind)) err("$.kind", "must be bug or build_error");
  if (!["fixed", "unresolved"].includes(doc.status)) err("$.status", "must be fixed or unresolved");
  if (!isStr(doc.symptom)) err("$.symptom", "expected non-empty string");

  const r = doc.reproduction;
  if (!isObj(r)) err("$.reproduction", "missing: no reproduction, no debugging");
  else {
    if (!isStr(r.command)) err("$.reproduction.command", "expected non-empty string");
    if (!Number.isInteger(r.exit_code) || r.exit_code === 0) err("$.reproduction.exit_code", "the reproduction must fail (non-zero exit)");
    if (!Number.isInteger(r.runs) || r.runs < 2) err("$.reproduction.runs", "run the reproduction at least twice");
    if (!Number.isInteger(r.failures) || r.failures < 1 || r.failures > r.runs) err("$.reproduction.failures", "must be between 1 and runs");
    if (!isStr(r.output_excerpt)) err("$.reproduction.output_excerpt", "expected non-empty string");
  }

  const hyp = new Map();
  const ranks = new Set();
  const hs = Array.isArray(doc.hypotheses) ? doc.hypotheses : (err("$.hypotheses", "expected array"), []);
  if (hs.length < 2) err("$.hypotheses", "at least 2 ranked hypotheses");
  hs.forEach((h, i) => {
    const p = `$.hypotheses[${i}]`;
    if (!isObj(h)) return err(p, "expected object");
    if (!/^H\d+$/.test(h.id ?? "")) err(`${p}.id`, "must match ^H\\d+$");
    else if (hyp.has(h.id)) err(`${p}.id`, `duplicate id ${h.id}`);
    else hyp.set(h.id, h);
    if (!Number.isInteger(h.rank) || h.rank < 1) err(`${p}.rank`, "expected integer >= 1");
    else if (ranks.has(h.rank)) err(`${p}.rank`, `duplicate rank ${h.rank}`);
    else ranks.add(h.rank);
    if (!isStr(h.statement)) err(`${p}.statement`, "expected non-empty string");
    if (!isStr(h.falsifier)) err(`${p}.falsifier`, "a hypothesis needs a falsifier");
    if (!["open", "confirmed", "refuted"].includes(h.status)) err(`${p}.status`, "must be open, confirmed or refuted");
  });

  const exp = new Map();
  (Array.isArray(doc.experiments) ? doc.experiments : (err("$.experiments", "expected array"), [])).forEach((e, i) => {
    const p = `$.experiments[${i}]`;
    if (!isObj(e)) return err(p, "expected object");
    if (!/^E\d+$/.test(e.id ?? "")) err(`${p}.id`, "must match ^E\\d+$");
    else if (exp.has(e.id)) err(`${p}.id`, `duplicate id ${e.id}`);
    else exp.set(e.id, e);
    if (!hyp.has(e.hypothesis)) err(`${p}.hypothesis`, `unknown hypothesis ${e.hypothesis}`);
    for (const k of ["change", "command", "outcome"]) if (!isStr(e[k])) err(`${p}.${k}`, "expected non-empty string");
    if (!Number.isInteger(e.exit_code)) err(`${p}.exit_code`, "expected integer");
    if (!["confirms", "refutes", "inconclusive"].includes(e.result)) err(`${p}.result`, "must be confirms, refutes or inconclusive");
    if (typeof e.flips_failure !== "boolean" || typeof e.isolates_cause !== "boolean") err(p, "flips_failure and isolates_cause must be booleans");
  });
  let confirmed = 0;
  for (const h of hyp.values()) {
    const mine = [...exp.values()].filter((e) => e.hypothesis === h.id);
    if (h.status === "confirmed") {
      confirmed++;
      if (!mine.some((e) => e.result === "confirms")) err(`$.hypotheses.${h.id}`, "confirmed without a confirming experiment");
    }
    if (h.status === "refuted" && !mine.some((e) => e.result === "refutes")) err(`$.hypotheses.${h.id}`, "refuted without a refuting experiment");
  }
  if (confirmed > 1) err("$.hypotheses", "at most one confirmed hypothesis");

  const b = doc.bisect;
  if (b !== null && b !== undefined) {
    if (!isObj(b)) err("$.bisect", "expected null or object");
    else {
      for (const k of ["good", "bad", "script"]) if (!isStr(b[k])) err(`$.bisect.${k}`, "expected non-empty string");
      if (!/^[0-9a-f]{7,40}$/.test(b.first_bad_commit ?? "")) err("$.bisect.first_bad_commit", "expected commit id (7-40 hex)");
      if (!isStr(b.worktree) || !isAbsolute(b.worktree)) err("$.bisect.worktree", "bisect runs in a worktree: expected absolute path");
    }
  }

  const fixedOnly = ["root_cause", "fix", "regression_test"];
  if (doc.status === "unresolved") {
    if (!isStr(doc.blocked_reason)) err("$.blocked_reason", "unresolved needs blocked_reason");
    if (!isStr(doc.next_experiment)) err("$.next_experiment", "unresolved needs next_experiment");
    for (const k of fixedOnly) if (k in doc) err(`$.${k}`, "not allowed when unresolved: never claim a cause or fix without proof");
  } else if (doc.status === "fixed") {
    const rc = doc.root_cause;
    if (!isObj(rc)) err("$.root_cause", "fixed requires a proven root cause");
    else {
      if (!isStr(rc.statement)) err("$.root_cause.statement", "expected non-empty string");
      if (!safeRel(rc.path)) err("$.root_cause.path", "expected repo-relative path without ..");
      const h = hyp.get(rc.hypothesis);
      if (!h || h.status !== "confirmed") err("$.root_cause.hypothesis", "must reference the confirmed hypothesis");
      const pe = exp.get(rc.proof_experiment);
      if (!pe) err("$.root_cause.proof_experiment", "unknown experiment");
      else {
        if (pe.hypothesis !== rc.hypothesis) err("$.root_cause.proof_experiment", "proof experiment must test the root-cause hypothesis");
        if (pe.result !== "confirms") err("$.root_cause.proof_experiment", "proof experiment must confirm");
        if (pe.isolates_cause !== true) err("$.root_cause.proof_experiment", "proof experiment must change only the cause (isolates_cause)");
        if (pe.flips_failure !== true) err("$.root_cause.proof_experiment", "proof experiment must flip the failure to passing");
      }
    }
    const fx = doc.fix;
    const fixPaths = isObj(fx) && Array.isArray(fx.paths) ? fx.paths : [];
    if (!isObj(fx) || fixPaths.length === 0 || !fixPaths.every(safeRel)) err("$.fix.paths", "expected non-empty array of repo-relative paths");
    if (!isObj(fx) || !isStr(fx.summary)) err("$.fix.summary", "expected non-empty string");
    const t = doc.regression_test;
    if (!isObj(t)) err("$.regression_test", "never fixed without a regression test");
    else {
      if (!["test", "build"].includes(t.type)) err("$.regression_test.type", "must be test or build");
      if (t.type === "build" && doc.kind !== "build_error") err("$.regression_test.type", "build regression checks are only for kind build_error");
      if (!safeRel(t.path)) err("$.regression_test.path", "expected repo-relative path without ..");
      if (!isStr(t.command)) err("$.regression_test.command", "expected non-empty string");
      if (!isObj(t.before) || !Number.isInteger(t.before.exit_code) || t.before.exit_code === 0) err("$.regression_test.before.exit_code", "the regression test must fail before the fix");
      else if (t.type === "test" && NOT_ASSERTION.test(t.before.output_excerpt ?? "")) err("$.regression_test.before.output_excerpt", "fails for the wrong reason (compile/import/setup error), not on the assertion");
      if (!isObj(t.after) || t.after.exit_code !== 0) err("$.regression_test.after.exit_code", "the regression test must pass after the fix");
      if (t.suite_exit_code !== 0) err("$.regression_test.suite_exit_code", "nothing else may break: suite must exit 0");
      if (scope && safeRel(t.path) && !scope.includes(t.path)) err("$.regression_test.path", `${t.path} is outside the scope`);
    }
    if (scope) for (const p of fixPaths) if (!scope.includes(p)) err("$.fix.paths", `${p} is outside the scope`);
    if ("blocked_reason" in doc || "next_experiment" in doc) err("$", "fixed must not carry blocked_reason or next_experiment");
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

const main = () => {
  const args = process.argv.slice(2);
  const i = args.indexOf("--scope");
  const scope = i >= 0 ? args.splice(i, 2)[1].split(",").map((s) => s.trim()).filter(Boolean) : null;
  if (args.length !== 1) { console.error("usage: validate-debug.mjs <debug.json|result.md> [--scope <path,path,...>]"); process.exit(2); }
  let doc;
  try { doc = loadDoc(args[0]); } catch (e) { console.error(`cannot read input: ${e.message}`); process.exit(2); }
  const errors = validate(doc, { scope });
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log("valid");
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
