#!/usr/bin/env node
// Validates a test-trust findings.json against ../schema/findings.schema.json,
// then checks that every evidence file it cites exists. No dependencies.
// Usage: node <skill-dir>/scripts/validate-findings.mjs <path-to-findings.json> [--plan PLAN.md]
// With --plan (diff mode), every acceptance criterion of the plan's "## Tests" section needs a claim
// that its named test, run alone, killed a silent-removal mutant by an assertion (A59).
// Exit codes: 0 valid, 1 invalid, 2 usage or read error.

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { computeGate, minMutants } from "./gate.mjs";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "schema", "findings.schema.json");

// ponytail: implements only the JSON Schema keywords findings.schema.json uses;
// add a keyword here before using it in the schema.
export function validate(schema, data, root = schema, path = "$") {
  if (schema === true) return [];
  if (schema === false) return [`${path}: not allowed`];
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o[k], root);
    return validate(target, data, root, path);
  }
  const errors = [];
  const add = (msg) => errors.push(`${path}: ${msg}`);

  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => typeOf(data, t))) return [`${path}: expected ${types.join(" or ")}`];
  }
  if (schema.enum && !schema.enum.includes(data)) add(`must be one of ${schema.enum.join(", ")}`);
  if ("const" in schema && data !== schema.const) add(`must be ${schema.const}`);
  if (typeof data === "string") {
    if (schema.minLength !== undefined && data.length < schema.minLength) add(`shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) add(`does not match ${schema.pattern}`);
  }
  if (typeof data === "number") {
    if (schema.minimum !== undefined && data < schema.minimum) add(`less than ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum) add(`greater than ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) add(`not greater than ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) add(`needs at least ${schema.minItems} item(s)`);
    if (schema.items) data.forEach((v, i) => errors.push(...validate(schema.items, v, root, `${path}[${i}]`)));
  }
  if (typeOf(data, "object")) {
    for (const k of schema.required ?? []) if (!(k in data)) add(`missing required "${k}"`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in data) errors.push(...validate(sub, data[k], root, `${path}.${k}`));
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(data)) if (!(k in (schema.properties ?? {}))) add(`unexpected "${k}"`);
    }
  }
  for (const sub of schema.allOf ?? []) errors.push(...validate(sub, data, root, path));
  if (schema.anyOf && !schema.anyOf.some((sub) => validate(sub, data, root, path).length === 0)) {
    add("matches none of the allowed alternatives");
  }
  if (schema.if) {
    const branch = validate(schema.if, data, root, path).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...validate(branch, data, root, path));
  }
  return errors;
}

function typeOf(v, t) {
  if (t === "object") return v !== null && typeof v === "object" && !Array.isArray(v);
  if (t === "array") return Array.isArray(v);
  if (t === "integer") return Number.isInteger(v);
  if (t === "null") return v === null;
  return typeof v === t;
}

// Evidence paths are relative to the folder holding findings.json. When the document says
// evidence_pruned, the files were deleted on purpose: paths are still checked for escaping
// the folder, but not for existence.
export function missingEvidence(doc, baseDir) {
  const errors = [];
  const pruned = doc.evidence_pruned === true;
  for (const f of doc.findings ?? []) {
    const paths = [
      ...(f.evidence ?? []).map((e) => e.path),
      ...(f.observed?.surviving_mutants ?? []).map((m) => m.diff_path),
    ];
    for (const p of paths) {
      if (typeof p !== "string") continue;
      const r = relative(baseDir, resolve(baseDir, p));
      if (isAbsolute(p) || r.startsWith("..") || isAbsolute(r)) {
        errors.push(`${f.id}: evidence path escapes the output folder: ${p}`);
        continue;
      }
      if (!pruned && !existsSync(join(baseDir, p))) errors.push(`${f.id}: evidence file not found: ${p}`);
    }
  }
  return errors;
}

// Rules the schema cannot express. diff mode: the gate must equal the one the rule computes,
// hollow findings only on changed units, mutants within budget, slow findings meeting the
// configured ratio, no duplicate ids. Applies to every mode for id uniqueness.
export function checkConsistency(doc) {
  const errors = [];
  const ids = new Set();
  for (const f of doc.findings ?? []) {
    if (ids.has(f.id)) errors.push(`${f.id}: duplicate finding id`);
    ids.add(f.id);
  }
  if (doc.mode !== "diff") return errors;
  const d = doc.scope?.diff;
  const g = computeGate(doc.findings);
  if (doc.gate?.result !== g.result) errors.push(`gate.result is ${doc.gate?.result} but the rule computes ${g.result}`);
  if (JSON.stringify([...(doc.gate?.failing ?? [])].sort()) !== JSON.stringify([...g.failing].sort())) {
    errors.push(`gate.failing must list exactly the confirmed flaky and hollow findings: ${g.failing.join(", ") || "none"}`);
  }
  if (!d) return errors;
  if (d.mutants_run > d.thresholds?.mutation_budget) errors.push(`scope.diff.mutants_run ${d.mutants_run} exceeds mutation_budget ${d.thresholds.mutation_budget}`);
  for (const f of doc.findings ?? []) {
    if (f.kind === "hollow" && f.observed?.unit && !d.changed_units?.includes(f.observed.unit)) {
      errors.push(`${f.id}: hollow finding on ${f.observed.unit}, which is not a changed unit (diff mode mutates changed units only)`);
    }
    if (f.kind === "slow" && f.verdict === "confirmed" && !(f.observed?.ratio_to_median > d.thresholds?.slow_ratio)) {
      errors.push(`${f.id}: confirmed slow finding does not exceed slow_ratio ${d.thresholds?.slow_ratio}`);
    }
    if (f.carried_forward === true) errors.push(`${f.id}: carried_forward is not allowed in diff mode (every run re-measures)`);
  }
  return errors;
}

// Claim mutants (A59). A claim that is not killed-by-assertion must leave the gate FAIL; with the plan, every
// AC of "## Tests" needs a claim.
export function checkClaims(doc, planText) {
  const errors = [];
  if (doc.mode !== "diff") return errors;
  const claims = doc.scope?.diff?.claims ?? [];
  for (const c of claims) {
    const proven = c.outcome === "killed" && c.failure === "assertion" && (c.killed_by ?? []).length > 0;
    if (c.outcome === "killed" && c.failure !== "assertion") errors.push(`${c.ac}: a kill by ${c.failure} is not a kill of the claim: the named test must fail on an assertion`);
    if (!proven && doc.gate?.result !== "FAIL") errors.push(`${c.ac}: the claim is not proven (${c.outcome}, ${c.failure}) but gate.result is ${doc.gate?.result}: a test that does not observe its criterion is hollow`);
  }
  if (planText !== undefined && (doc.scope?.diff?.tests ?? []).length > 0) {
    const m = /^## Tests[^\n]*\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m.exec(planText);
    const acs = [...(m ? m[1] : "").matchAll(/^\s*[-*]\s+(AC-\d+):/gm)].map((x) => x[1]);
    const budget = doc.scope.diff.thresholds?.mutation_budget;
    if (budget < minMutants(planText)) errors.push(`scope.diff.thresholds.mutation_budget ${budget} is below the ${minMutants(planText)} criteria of PLAN ## Tests (one claim mutant each): raise it (the user approves, 'agent.sh raise-budget')`);
    for (const ac of new Set(acs)) if (!claims.some((c) => c.ac === ac)) errors.push(`${ac}: PLAN ## Tests names a test for it but findings.json has no claim mutant for it (scope.diff.claims)`);
  }
  return errors;
}

function main(argv) {
  const pi = argv.indexOf("--plan");
  let planText;
  if (pi >= 0) {
    try { planText = readFileSync(resolve(argv[pi + 1]), "utf8"); } catch (e) { console.error(`Cannot read plan: ${e.message}`); return 2; }
    argv = argv.filter((_, i) => i !== pi && i !== pi + 1);
  }
  if (argv.length !== 1) {
    console.error("Usage: node validate-findings.mjs <path-to-findings.json> [--plan PLAN.md]");
    return 2;
  }
  const file = resolve(argv[0]);
  let doc, schema;
  try {
    schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`Cannot read input: ${e.message}`);
    return 2;
  }
  const errors = validate(schema, doc);
  if (errors.length === 0) errors.push(...checkConsistency(doc), ...checkClaims(doc, planText), ...missingEvidence(doc, dirname(file)));
  if (errors.length) {
    console.error(`INVALID: ${file}`);
    for (const e of errors) console.error(`  ${e}`);
    return 1;
  }
  console.log(`VALID: ${file} (${doc.findings.length} finding(s))`);
  return 0;
}

// Compare real paths: the script is often reached through a symlinked skill folder.
const isCli = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isCli()) {
  process.exitCode = main(process.argv.slice(2));
}
