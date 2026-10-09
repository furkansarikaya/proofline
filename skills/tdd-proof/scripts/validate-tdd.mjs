#!/usr/bin/env node
// Validates a tdd-proof tdd.json (see ../schema/tdd.schema.json).
// Usage: node validate-tdd.mjs <tdd.json | result.md> [--scope <path,path,...>]
// A .md input is read through its first ```json fenced block (team mode embeds the ledger in the result file).
// Exit: 0 valid, 1 invalid, 2 usage/read error. No dependencies.
import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./classify-red.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const safeRel = (p) => isStr(p) && !isAbsolute(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0");
const STOCK = /^(test (fails?|failed)|not implemented|fails as expected|assertion (failed|error)|the test fails|failing test|todo|n\/?a|none)\.?$/i;
export const specific = (s) => isStr(s) && s.trim().length >= 20 && !STOCK.test(s.trim());
const KEYS = ["schema_version", "mode", "task", "cycles", "exemptions"];

export function validate(doc, { scope = null } = {}) {
  const errors = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  if (!isObj(doc)) return ["$: expected object"];
  for (const k of KEYS) if (!(k in doc)) err("$", `missing required "${k}"`);
  for (const k of Object.keys(doc)) if (!KEYS.includes(k)) err("$", `unexpected "${k}"`);
  if (doc.schema_version !== 1) err("$.schema_version", "must be 1");
  if (!["team", "standalone"].includes(doc.mode)) err("$.mode", "must be team or standalone");
  if (!isStr(doc.task)) err("$.task", "expected non-empty string");
  const covered = new Set();
  const cycles = Array.isArray(doc.cycles) ? doc.cycles : (err("$.cycles", "expected array"), []);
  const num = (v) => Number.isInteger(v);

  cycles.forEach((c, i) => {
    const p = `$.cycles[${i}]`;
    if (!isObj(c)) return err(p, "expected object");
    if (!safeRel(c.path)) err(`${p}.path`, "expected repo-relative path without ..");
    else if (covered.has(c.path)) err(`${p}.path`, `duplicate cycle for ${c.path}`);
    else covered.add(c.path);
    if (!isStr(c.criterion)) err(`${p}.criterion`, "name the acceptance criterion this cycle proves");
    if (!isObj(c.test) || !isStr(c.test.file) || !isStr(c.test.name)) err(`${p}.test`, "expected {file, name}");

    const r = c.red;
    if (!isObj(r)) err(`${p}.red`, "missing");
    else {
      if (!isStr(r.command)) err(`${p}.red.command`, "expected non-empty string");
      if (!num(r.exit_code) || r.exit_code === 0) err(`${p}.red.exit_code`, "RED must exit non-zero");
      if (r.failure_class !== "assertion") err(`${p}.red.failure_class`, `RED must fail on an assertion, got ${r.failure_class}: a ${r.failure_class} error is not RED`);
      const k = classify(r.output_excerpt);
      if (k.class !== "assertion") err(`${p}.red.output_excerpt`, `output classifies as ${k.class} (${k.evidence}), not as a failing assertion`);
      if (!specific(r.expected_failure)) err(`${p}.red.expected_failure`, "needs a specific expected failure (>= 20 chars, not a stock phrase)");
      if (typeof r.stub_written !== "boolean") err(`${p}.red.stub_written`, "expected boolean");
    }
    const g = c.green;
    if (!isObj(g)) err(`${p}.green`, "missing");
    else {
      if (!isStr(g.command)) err(`${p}.green.command`, "expected non-empty string");
      else if (isObj(r) && g.command !== r.command) err(`${p}.green.command`, "GREEN must run the same command as RED");
      if (g.exit_code !== 0) err(`${p}.green.exit_code`, "GREEN must exit 0");
      if (!isStr(g.suite_command)) err(`${p}.green.suite_command`, "expected non-empty string");
      if (g.suite_exit_code !== 0) err(`${p}.green.suite_exit_code`, "nothing else may break: the suite must exit 0");
    }
    const h = c.hollow_check;
    if (!isObj(h)) err(`${p}.hollow_check`, "missing: the new test must be shown to fail without the production change");
    else {
      if (!["revert", "mutate"].includes(h.method)) err(`${p}.hollow_check.method`, "must be revert or mutate");
      if (!isStr(h.worktree) || !isAbsolute(h.worktree)) err(`${p}.hollow_check.worktree`, "expected absolute worktree path");
      if (!isStr(h.command)) err(`${p}.hollow_check.command`, "expected non-empty string");
      else if (isObj(r) && h.command !== r.command) err(`${p}.hollow_check.command`, "must run the same command as RED");
      if (!num(h.exit_code) || h.exit_code === 0) err(`${p}.hollow_check.exit_code`, "hollow test: the test still passed without the change");
      if (h.failed_for_expected_reason !== true) err(`${p}.hollow_check.failed_for_expected_reason`, "must be true");
      const k = classify(h.output_excerpt);
      if (k.class !== "assertion") err(`${p}.hollow_check.output_excerpt`, `output classifies as ${k.class}, not as a failing assertion`);
    }
    if (c.refactor !== undefined && c.refactor !== null) {
      if (!isObj(c.refactor) || !isStr(c.refactor.changes) || !isStr(c.refactor.command)) err(`${p}.refactor`, "expected {changes, command, exit_code} or null");
      else if (c.refactor.exit_code !== 0) err(`${p}.refactor.exit_code`, "refactor only with tests green");
    }
  });

  const ex = Array.isArray(doc.exemptions) ? doc.exemptions : (err("$.exemptions", "expected array"), []);
  ex.forEach((e, i) => {
    const p = `$.exemptions[${i}]`;
    if (!isObj(e) || !safeRel(e.path)) return err(p, "expected {path, reason}");
    if (!specific(e.reason)) err(`${p}.reason`, "needs a specific reason (>= 20 chars, not a stock phrase)");
    if (covered.has(e.path)) err(`${p}.path`, `${e.path} has both a cycle and an exemption`);
    covered.add(e.path);
  });

  if (scope) {
    for (const s of scope) if (!covered.has(s)) err("$.cycles", `scope path ${s} has neither a cycle nor an exemption`);
    for (const c of covered) if (!scope.includes(c)) err("$.cycles", `${c} is outside the scope`);
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
  if (args.length !== 1) { console.error("usage: validate-tdd.mjs <tdd.json|result.md> [--scope <path,path,...>]"); process.exit(2); }
  let doc;
  try { doc = loadDoc(args[0]); } catch (e) { console.error(`cannot read JSON: ${e.message}`); process.exit(2); }
  const errors = validate(doc, { scope });
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log("valid");
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
