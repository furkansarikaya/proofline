#!/usr/bin/env node
// Validates a proof-review findings.json (see ../schema/findings.schema.json) with
// hand-written checks, then checks that cited reproduction files exist inside the
// output folder. No dependencies.
// Usage: node <skill-dir>/scripts/validate-findings.mjs <path-to-findings.json>
// Exit codes: 0 valid, 1 invalid, 2 usage or read error.

import { readFileSync, statSync, realpathSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { computeGate, FOCUSES, FORBIDDEN_BY_FOCUS } from "./gate.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";

// Returns a list of error strings; empty means the structure is valid.
export function validate(doc) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);

  function object(v, path, required, optional = []) {
    if (!isObj(v)) { err(path, "expected object"); return false; }
    for (const k of required) if (!(k in v)) err(path, `missing required "${k}"`);
    for (const k of Object.keys(v)) {
      if (!required.includes(k) && !optional.includes(k)) err(path, `unexpected "${k}"`);
    }
    return true;
  }
  function str(v, path) {
    if (!isStr(v)) { err(path, "expected non-empty string"); return false; }
    return true;
  }
  function oneOf(v, path, values) {
    if (!values.includes(v)) { err(path, `must be one of ${values.join(", ")}`); return false; }
    return true;
  }
  function location(v, path) {
    if (!object(v, path, ["file", "line"])) return;
    str(v.file, `${path}.file`);
    if (!Number.isInteger(v.line) || v.line < 1) err(`${path}.line`, "expected integer >= 1");
  }
  function array(v, path) {
    if (!Array.isArray(v)) { err(path, "expected array"); return false; }
    return true;
  }
  // Checks id pattern and uniqueness across the whole document.
  const seen = new Set();
  function id(v, path, prefix) {
    if (typeof v !== "string" || !new RegExp(`^${prefix}\\d{3}$`).test(v)) {
      err(path, `id must match ^${prefix}\\d{3}$`);
      return;
    }
    if (seen.has(v)) err(path, `duplicate id ${v}`);
    seen.add(v);
  }

  if (!object(doc, "$", ["schema_version", "skill_version", "generated_at", "target", "scope", "claims", "rules", "unrequested", "bugs", "suspicions"],
    ["focus", "gate", "fingerprint", "evidence_pruned", "run", "plan_deviations"])) return errors;

  if (doc.schema_version !== 1) err("$.schema_version", "must be 1");
  str(doc.skill_version, "$.skill_version");
  if (!isStr(doc.generated_at) || Number.isNaN(Date.parse(doc.generated_at)) || !/^\d{4}-\d\d-\d\dT/.test(doc.generated_at)) {
    err("$.generated_at", "expected ISO 8601 date-time");
  }

  // proofline fields (all optional outside a run)
  const inRun = "run" in doc;
  if ("focus" in doc) oneOf(doc.focus, "$.focus", FOCUSES);
  if ("fingerprint" in doc && !(typeof doc.fingerprint === "string" && /^[0-9a-f]{40,64}$/.test(doc.fingerprint))) err("$.fingerprint", "must match ^[0-9a-f]{40,64}$");
  if ("evidence_pruned" in doc && typeof doc.evidence_pruned !== "boolean") err("$.evidence_pruned", "expected boolean");
  if ("run" in doc && object(doc.run, "$.run", ["task"])) str(doc.run.task, "$.run.task");
  if ("gate" in doc && object(doc.gate, "$.gate", ["result", "failing"])) {
    oneOf(doc.gate.result, "$.gate.result", ["PASS", "FAIL"]);
    if (array(doc.gate.failing, "$.gate.failing")) doc.gate.failing.forEach((v, i) => { if (!isStr(v)) err(`$.gate.failing[${i}]`, "expected non-empty string"); });
  }
  if ("gate" in doc && !("focus" in doc)) err("$.gate", 'requires "focus"');
  if (inRun) for (const k of ["focus", "gate", "fingerprint"]) if (!(k in doc)) err("$", `inside a run "${k}" is required`);
  if (inRun && ["plan", "all"].includes(doc.focus) && !("plan_deviations" in doc)) err("$", `focus ${doc.focus} inside a run requires "plan_deviations"`);

  const t = doc.target;
  if (object(t, "$.target", ["type", "name", "slug", "base", "head"])) {
    oneOf(t.type, "$.target.type", ["working_tree", "branch", "pr"]);
    str(t.name, "$.target.name");
    if (!isStr(t.slug) || !/^(?!\.)[A-Za-z0-9._-]+$/.test(t.slug)) err("$.target.slug", "must match ^(?!\\.)[A-Za-z0-9._-]+$");
    str(t.base, "$.target.base");
    if (t.type === "working_tree") {
      if (t.head !== null) err("$.target.head", "must be null for working_tree");
      if (t.slug !== "working-tree") err("$.target.slug", "must be working-tree for working_tree");
    } else if (!isStr(t.head)) err("$.target.head", "expected non-empty string unless working_tree");
    if (t.type === "pr" && !/^pr-\d+$/.test(String(t.slug))) err("$.target.slug", "must match ^pr-\\d+$ for pr");
  }

  const s = doc.scope;
  if (object(s, "$.scope", ["changed_files", "changed_lines", "excluded", "not_reviewed", "rule_files_read", "rule_files_not_read"])) {
    for (const k of ["changed_files", "changed_lines"]) {
      if (!Number.isInteger(s[k]) || s[k] < 0) err(`$.scope.${k}`, "expected integer >= 0");
    }
    if (array(s.excluded, "$.scope.excluded")) s.excluded.forEach((v, i) => str(v, `$.scope.excluded[${i}]`));
    for (const k of ["rule_files_read", "rule_files_not_read"]) {
      if (array(s[k], `$.scope.${k}`)) s[k].forEach((v, i) => str(v, `$.scope.${k}[${i}]`));
    }
    if (array(s.not_reviewed, "$.scope.not_reviewed")) {
      s.not_reviewed.forEach((v, i) => {
        if (object(v, `$.scope.not_reviewed[${i}]`, ["path", "reason"])) {
          str(v.path, `$.scope.not_reviewed[${i}].path`);
          str(v.reason, `$.scope.not_reviewed[${i}].reason`);
        }
      });
    }
  }

  if (array(doc.claims, "$.claims")) {
    doc.claims.forEach((c, i) => {
      const p = `$.claims[${i}]`;
      if (!object(c, p, ["id", "text", "source", "status", "locations"], ["missing_part", "criterion"])) return;
      id(c.id, `${p}.id`, "C");
      str(c.text, `${p}.text`);
      oneOf(c.source, `${p}.source`, ["user", "pr_description", "issue", "commit", "plan"]);
      if (c.source === "plan") {
        if (!inRun) err(`${p}.source`, "plan is only allowed inside a run");
        if (!isStr(c.criterion)) err(`${p}.criterion`, "required and non-empty when source is plan");
      } else if ("criterion" in c) err(`${p}.criterion`, "allowed only when source is plan");
      if (inRun && c.source !== "plan") err(`${p}.source`, "inside a run every claim comes from the plan");
      oneOf(c.status, `${p}.status`, ["done", "partial", "missing"]);
      if (array(c.locations, `${p}.locations`)) {
        c.locations.forEach((l, j) => location(l, `${p}.locations[${j}]`));
        if (c.status !== "missing" && c.locations.length < 1) err(`${p}.locations`, "needs at least 1 location unless status is missing");
      }
      if (c.status === "partial") {
        if (!isStr(c.missing_part)) err(`${p}.missing_part`, "required and non-empty when status is partial");
      } else if ("missing_part" in c) err(`${p}.missing_part`, "allowed only when status is partial");
    });
  }

  if (array(doc.rules, "$.rules")) {
    doc.rules.forEach((r, i) => {
      const p = `$.rules[${i}]`;
      if (!object(r, p, ["id", "rule", "source", "location", "violation"])) return;
      id(r.id, `${p}.id`, "R");
      str(r.rule, `${p}.rule`);
      location(r.source, `${p}.source`);
      location(r.location, `${p}.location`);
      str(r.violation, `${p}.violation`);
    });
  }

  if ("plan_deviations" in doc && array(doc.plan_deviations, "$.plan_deviations")) {
    doc.plan_deviations.forEach((d, i) => {
      const p = `$.plan_deviations[${i}]`;
      if (!object(d, p, ["id", "kind", "subject", "location", "description"])) return;
      id(d.id, `${p}.id`, "P");
      oneOf(d.kind, `${p}.kind`, ["new_dependency", "contract_change"]);
      str(d.subject, `${p}.subject`);
      location(d.location, `${p}.location`);
      str(d.description, `${p}.description`);
    });
  }

  if (array(doc.unrequested, "$.unrequested")) {
    doc.unrequested.forEach((u, i) => {
      const p = `$.unrequested[${i}]`;
      if (!object(u, p, ["id", "files", "description"])) return;
      id(u.id, `${p}.id`, "U");
      if (array(u.files, `${p}.files`)) {
        if (u.files.length < 1) err(`${p}.files`, "needs at least 1 file");
        u.files.forEach((f, j) => str(f, `${p}.files[${j}]`));
      }
      str(u.description, `${p}.description`);
    });
  }

  if (array(doc.bugs, "$.bugs")) {
    doc.bugs.forEach((b, i) => {
      const p = `$.bugs[${i}]`;
      if (!object(b, p, ["id", "evidence", "location", "input", "expected", "actual", "impact", "status"], ["reproduction", "trace"])) return;
      id(b.id, `${p}.id`, "F");
      oneOf(b.evidence, `${p}.evidence`, ["reproduced", "traced"]);
      location(b.location, `${p}.location`);
      for (const k of ["input", "expected", "actual", "impact"]) str(b[k], `${p}.${k}`);
      oneOf(b.status, `${p}.status`, ["open", "fixed"]);
      if (b.evidence === "reproduced") {
        if ("trace" in b) err(`${p}.trace`, "allowed only when evidence is traced");
        if (!("reproduction" in b)) err(p, 'evidence "reproduced" requires "reproduction"');
        else if (object(b.reproduction, `${p}.reproduction`, ["file", "command", "output"], ["source"])) {
          for (const k of ["file", "command", "output"]) str(b.reproduction[k], `${p}.reproduction.${k}`);
          if ("source" in b.reproduction) str(b.reproduction.source, `${p}.reproduction.source`);
          else if (doc.evidence_pruned === true) err(`${p}.reproduction.source`, "required when evidence_pruned (the reproduction file no longer exists)");
        }
      } else if (b.evidence === "traced") {
        if ("reproduction" in b) err(`${p}.reproduction`, "allowed only when evidence is reproduced");
        if (!("trace" in b)) err(p, 'evidence "traced" requires "trace"');
        else if (array(b.trace, `${p}.trace`)) {
          if (b.trace.length < 2) err(`${p}.trace`, "needs at least 2 steps");
          b.trace.forEach((step, j) => str(step, `${p}.trace[${j}]`));
        }
      }
    });
  }

  if (array(doc.suspicions, "$.suspicions")) {
    doc.suspicions.forEach((x, i) => {
      const p = `$.suspicions[${i}]`;
      if (!object(x, p, ["id", "location", "reason", "why_unproven"])) return;
      id(x.id, `${p}.id`, "S");
      location(x.location, `${p}.location`);
      str(x.reason, `${p}.reason`);
      str(x.why_unproven, `${p}.why_unproven`);
    });
  }
  return errors;
}

// Rules the structure cannot express: the gate must equal the one the rule computes, and a
// focus may only report the series that belong to it. Applies only to documents with a focus.
export function checkConsistency(doc) {
  const errors = [];
  if (!isObj(doc) || !("focus" in doc) || !FOCUSES.includes(doc.focus)) return errors;
  for (const series of FORBIDDEN_BY_FOCUS[doc.focus]) {
    const n = Array.isArray(doc[series]) ? doc[series].length : 0;
    if (n > 0) errors.push(`$.${series}: focus ${doc.focus} must not report ${series} (${n} found)`);
  }
  if (isObj(doc.gate)) {
    const g = computeGate(doc);
    if (doc.gate.result !== g.result) errors.push(`gate.result is ${doc.gate.result} but the rule computes ${g.result}`);
    if (JSON.stringify([...(doc.gate.failing ?? [])].sort()) !== JSON.stringify(g.failing)) {
      errors.push(`gate.failing must list exactly the blocking ids: ${g.failing.join(", ") || "none"}`);
    }
  }
  return errors;
}

// Reproduction paths are relative to the folder holding findings.json: they must
// not be absolute, must not escape it (also not through symlinks), and must exist
// (unless evidence_pruned: the files were deleted on purpose, escaping is still checked).
export function checkReproductionPaths(doc, baseDir) {
  const errors = [];
  const pruned = doc?.evidence_pruned === true;
  const base = realpathSync(baseDir);
  for (const b of Array.isArray(doc?.bugs) ? doc.bugs : []) {
    if (!isObj(b) || !isObj(b.reproduction)) continue;
    for (const k of ["file", "output"]) {
      const p = b.reproduction[k];
      if (typeof p !== "string" || p === "") continue;
      const abs = resolve(base, p);
      const rel = relative(base, abs);
      if (isAbsolute(p) || /^[A-Za-z]:/.test(p) || rel === "" || rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel)) {
        errors.push(`${b.id}: reproduction ${k} escapes the output folder: ${p}`);
        continue;
      }
      if (pruned) continue;
      let real;
      try { real = realpathSync(abs); } catch { errors.push(`${b.id}: reproduction ${k} not found: ${p}`); continue; }
      if (!statSync(real).isFile()) { errors.push(`${b.id}: reproduction ${k} is not a file: ${p}`); continue; }
      if (!real.startsWith(base + sep)) errors.push(`${b.id}: reproduction ${k} resolves outside the output folder: ${p}`);
    }
  }
  return errors;
}

function main(argv) {
  if (argv.length !== 1) {
    console.error("Usage: node validate-findings.mjs <path-to-findings.json>");
    return 2;
  }
  const file = resolve(argv[0]);
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`Cannot read input: ${e.message}`);
    return 2;
  }
  const errors = validate(doc);
  if (errors.length === 0) errors.push(...checkConsistency(doc), ...checkReproductionPaths(doc, dirname(file)));
  if (errors.length) {
    console.error(`INVALID: ${file}`);
    for (const e of errors) console.error(`  ${e}`);
    return 1;
  }
  const gate = doc.gate ? `, gate ${doc.gate.result}` : "";
  console.log(`OK: ${file} (${doc.claims.length} claim(s), ${doc.rules.length} rule violation(s), ${(doc.plan_deviations ?? []).length} plan deviation(s), ${doc.bugs.length} bug(s), ${doc.unrequested.length} unrequested, ${doc.suspicions.length} suspicion(s)${gate})`);
  return 0;
}

// Compare real paths: the script is often reached through a symlinked skill folder.
const isCli = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isCli()) {
  process.exitCode = main(process.argv.slice(2));
}
