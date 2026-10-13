#!/usr/bin/env node
// Validates a config-check document (produced by check-config.mjs, see ../references/CONFIG.md) and computes
// the proof-review `config` focus mechanically.
// Usage: node validate-config.mjs <config-check.json> [--table]
//   valid   -> exit 0; prints "RESULT: PASS|FAIL" and "CONFIDENCE: high|medium|low"; --table prints result rows.
//   invalid -> exit 1; one line per problem on stderr.   usage/read error -> exit 2.
// No dependencies.
import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { scanLine } from "./check-config.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
// check -> allowed classes. env_undocumented, secret_plaintext and flag_removed_referenced are always blocking;
// flag_default_on is blocking only with a plan to compare against (otherwise note).
const CHECKS = {
  env_undocumented: ["blocking"], secret_plaintext: ["blocking"], flag_removed_referenced: ["blocking"],
  flag_default_on: ["blocking", "note"], flag_default_on_planned: ["note"], flag_default_off: ["note"],
  env_documented_unused: ["note"], secret_allowlisted: ["note"],
};

export function validate(doc) {
  const errors = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  if (!isObj(doc)) return ["$: expected object"];
  if (doc.schema_version !== 1) err("$.schema_version", "must be 1");
  if (!isStr(doc.base)) err("$.base", "expected the base revision");
  if (!isObj(doc.plan) || !["checked", "none"].includes(doc.plan.status)) err("$.plan.status", "must be checked or none");
  if (!Array.isArray(doc.not_reviewed)) err("$.not_reviewed", "expected array");
  const ids = new Set();
  (Array.isArray(doc.items) ? doc.items : (err("$.items", "expected array"), [])).forEach((it, i) => {
    const p = `$.items[${i}]`;
    if (!isObj(it)) return err(p, "expected object");
    if (!/^G\d{3,}$/.test(it.id ?? "")) err(`${p}.id`, "must match ^G\\d{3,}$"); else if (ids.has(it.id)) err(`${p}.id`, `duplicate id ${it.id}`); else ids.add(it.id);
    if (!CHECKS[it.check]) { err(`${p}.check`, `must be one of ${Object.keys(CHECKS).join(", ")}`); return; }
    if (!CHECKS[it.check].includes(it.class)) err(`${p}.class`, `${it.check} is ${CHECKS[it.check].join(" or ")}`);
    if (it.check === "flag_default_on" && isObj(doc.plan)) {
      const want = doc.plan.status === "checked" ? "blocking" : "note";
      if (it.class !== want) err(`${p}.class`, `flag_default_on is ${want} when the plan is ${doc.plan.status}`);
    }
    if (it.evidence !== "measured") err(`${p}.evidence`, "must be measured (a deterministic scan; judgement is not part of this focus)");
    if (!isObj(it.location) || !isStr(it.location.file) || isAbsolute(it.location.file) || it.location.file.split("/").includes("..") || !Number.isInteger(it.location.line) || it.location.line < 1) err(`${p}.location`, "expected {file (repository-relative), line >= 1}");
    if (!isStr(it.subject) || !isStr(it.detail)) err(p, "subject and detail are required");
    // A secret value never appears in the report.
    for (const k of ["subject", "detail"]) if (isStr(it[k]) && scanLine(it[k], "x").length > 0) err(`${p}.${k}`, "contains something that matches a secret pattern (any rule, including generic_secret); mask it");
  });
  return errors;
}

export function gate(doc) {
  const blocking = doc.items.filter((i) => i.class === "blocking");
  const confidence = doc.not_reviewed.length || doc.plan.status !== "checked" ? "medium" : "high";
  return { result: blocking.length ? "FAIL" : "PASS", confidence, blocking };
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\s+/g, " ");
export function tableRows(doc) {
  const rows = ["| id | severity | path:line | finding | evidence |", "|---|---|---|---|---|"];
  let n = 0;
  const row = (it, sev) => rows.push(`| REVIEW_RULES-${++n} | ${sev} | ${it.location.file}:${it.location.line} | ${cell(`${it.id} ${it.check}: ${it.detail}`)} | measured |`);
  for (const it of doc.items) if (it.class === "blocking") row(it, "blocking");
  for (const it of doc.items) if (it.class === "note") row(it, "info");
  return rows.join("\n");
}

const main = () => {
  const args = process.argv.slice(2);
  const table = args.includes("--table");
  const files = args.filter((a) => a !== "--table");
  if (files.length !== 1) { console.error("usage: validate-config.mjs <config-check.json> [--table]"); process.exit(2); }
  let doc;
  try { doc = JSON.parse(readFileSync(files[0], "utf8")); } catch (e) { console.error(`cannot read input: ${e.message}`); process.exit(2); }
  const errors = validate(doc);
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  const g = gate(doc);
  console.log(`RESULT: ${g.result}\nCONFIDENCE: ${g.confidence}`);
  if (table) console.log(tableRows(doc));
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
