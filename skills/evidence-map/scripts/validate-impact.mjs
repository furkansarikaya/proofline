#!/usr/bin/env node
// Validates an evidence-map impact report (see ../references/IMPACT.md, ../schema/impact.schema.json):
// shape, enums, the mandatory limits and the cross-repo "unknown", consistency of the per-symbol and
// top-level lists and the summary counts. With --repo it also re-reads every cited path:line and requires
// the recorded text to match, so a consumer can trust a report it did not generate. No dependencies.
// Usage: node validate-impact.mjs <impact.json> [--repo <dir>]
// Exit codes: 0 valid, 1 invalid (one message per line), 2 usage or read error.

import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, KINDS, ROLES, TEXTUAL_ROLES, CHANGES, TEST_RELATIONS, FORMATS, FILE_REASONS, LIMIT_IDS } from "./impact.mjs";

const relPath = (p) => typeof p === "string" && p && !isAbsolute(p) && !p.split("/").includes("..");
const isLine = (n) => Number.isInteger(n) && n >= 1;

export function validate(r, { root } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!r || typeof r !== "object") return ["report is not an object"];
  if (r.version !== VERSION) err(`version must be ${VERSION}`);
  if (r.kind !== "impact-report") err('kind must be "impact-report"');
  if (r.tool !== "evidence-map/impact") err('tool must be "evidence-map/impact"');
  for (const k of ["repo", "inputs", "analysis", "summary"]) if (!r[k] || typeof r[k] !== "object") err(`${k} is missing`);
  for (const k of ["limits", "changed_files", "symbols", "files_affected", "modules", "contracts", "tests", "unknown"]) if (!Array.isArray(r[k])) err(`${k} must be an array`);
  if (errors.length) return errors;

  const limitIds = new Set(r.limits.map((l) => l && l.id));
  for (const id of LIMIT_IDS) if (!limitIds.has(id)) err(`limits: "${id}" is not stated`);
  for (const l of r.limits) if (!l || typeof l.text !== "string" || !l.text) err(`limits: ${l && l.id} has no text`);
  const cross = r.unknown.find((u) => u && u.id === "cross-repo-consumers");
  if (!cross || cross.status !== "unknown") err('unknown: "cross-repo-consumers" with status "unknown" is required');
  for (const u of r.unknown) {
    if (!u || u.status !== "unknown") err(`unknown: ${u && u.id} must have status "unknown"`);
    for (const s of u.sites || []) if (!relPath(s.path) || !isLine(s.line)) err(`unknown ${u.id}: bad site ${JSON.stringify(s)}`);
  }
  if (!r.analysis.tools || !Array.isArray(r.analysis.tools.used)) err("analysis.tools.used must be an array");

  const topFiles = new Set(r.files_affected.map((f) => f.path));
  const topTests = new Set(r.tests.map((t) => t.path));
  const topContracts = new Set(r.contracts.map((c) => c.path));
  const count = { exact: 0, textual: 0, heuristic: 0 };
  const seenSym = new Set();
  const cite = [];
  for (const s of r.symbols) {
    const w = `symbol ${s && s.name}`;
    if (!s || typeof s.name !== "string" || !s.name) { err("symbol without a name"); continue; }
    if (seenSym.has(s.name)) err(`${w}: duplicate`);
    seenSym.add(s.name);
    if (!CHANGES.includes(s.change)) err(`${w}: change must be ${CHANGES.join("|")}`);
    for (const d of s.defined_in || []) { if (!relPath(d.path) || !isLine(d.line)) err(`${w}: bad defined_in ${JSON.stringify(d)}`); else cite.push([d.path, d.line, null, w]); }
    const rows = new Set();
    for (const x of s.references || []) {
      if (!relPath(x.path) || !isLine(x.line)) { err(`${w}: bad reference ${JSON.stringify(x)}`); continue; }
      const id = `${x.path}:${x.line}`;
      if (rows.has(id)) err(`${w}: duplicate reference ${id}`);
      rows.add(id);
      if (!KINDS.includes(x.kind)) err(`${w}: ${id} kind must be ${KINDS.join("|")}`);
      else count[x.kind]++;
      if (!ROLES.includes(x.role)) err(`${w}: ${id} role must be ${ROLES.join("|")}`);
      if (TEXTUAL_ROLES.includes(x.role) && x.kind !== "textual") err(`${w}: ${id} a ${x.role} occurrence must be textual, not ${x.kind}`);
      if (x.kind === "textual" && !TEXTUAL_ROLES.includes(x.role)) err(`${w}: ${id} textual needs role comment|string|doc`);
      if (typeof x.text !== "string") err(`${w}: ${id} text is missing`);
      cite.push([x.path, x.line, x.text, w]);
    }
    for (const h of s.excluded_homonyms || []) { if (!relPath(h.path) || !isLine(h.line) || typeof h.reason !== "string") err(`${w}: bad excluded_homonyms row ${JSON.stringify(h)}`); else cite.push([h.path, h.line, h.text, w]); }
    for (const f of s.files || []) {
      if (!topFiles.has(f.path)) err(`${w}: file ${f.path} is not in files_affected`);
      if (!KINDS.includes(f.kind)) err(`${w}: file ${f.path} kind`);
      for (const q of f.reasons || []) if (!FILE_REASONS.includes(q)) err(`${w}: file ${f.path} reason ${q}`);
    }
    for (const t of s.tests || []) {
      if (!topTests.has(t.path)) err(`${w}: test ${t.path} is not in tests`);
      if (!TEST_RELATIONS.includes(t.relation)) err(`${w}: test ${t.path} relation must be ${TEST_RELATIONS.join("|")}`);
      if (!KINDS.includes(t.kind)) err(`${w}: test ${t.path} kind`);
    }
    for (const c of s.contracts || []) {
      if (!topContracts.has(c.path)) err(`${w}: contract ${c.path} is not in contracts`);
      if (!FORMATS.includes(c.format)) err(`${w}: contract ${c.path} format must be ${FORMATS.join("|")}`);
      if (c.kind !== "textual" && c.kind !== "heuristic") err(`${w}: contract ${c.path} kind must be textual|heuristic`);
    }
  }
  for (const c of r.contracts) if (!FORMATS.includes(c.format)) err(`contracts: ${c.path} format must be ${FORMATS.join("|")}`);
  for (const t of r.tests) if (!relPath(t.path) || !TEST_RELATIONS.includes(t.relation) || !KINDS.includes(t.kind)) err(`tests: bad row ${JSON.stringify(t)}`);
  const m = r.summary;
  for (const k of KINDS) if (!m.references || m.references[k] !== count[k]) err(`summary.references.${k} is ${m.references && m.references[k]}, the report holds ${count[k]}`);
  for (const [k, n] of [["symbols", r.symbols.length], ["files", r.files_affected.length], ["modules", r.modules.length], ["contracts", r.contracts.length], ["tests", r.tests.length]]) if (m[k] !== n) err(`summary.${k} is ${m[k]}, the report holds ${n}`);

  if (root && errors.length === 0) {
    let real;
    try { real = realpathSync(resolve(root)); } catch { return [`repo not readable: ${root}`]; }
    const lines = new Map();
    for (const [p, line, text, w] of cite) {
      if (!lines.has(p)) {
        try {
          const abs = realpathSync(resolve(real, p));
          if (abs !== real && !abs.startsWith(real + sep)) { lines.set(p, "outside"); } else lines.set(p, readFileSync(abs, "utf8").split("\n"));
        } catch { lines.set(p, null); }
      }
      const ls = lines.get(p);
      if (ls === "outside") err(`${w}: ${p} resolves outside the repository`);
      else if (!ls) err(`${w}: ${p} does not exist`);
      else if (line > ls.length) err(`${w}: ${p}:${line} is out of bounds (${ls.length} lines)`);
      else if (text !== null && text !== undefined && ls[line - 1].trim().slice(0, 160) !== text) err(`${w}: ${p}:${line} text does not match the file`);
    }
  }
  return errors;
}

function main(argv) {
  let file = null, repo = null;
  for (let i = 0; i < argv.length; i++) { if (argv[i] === "--repo") repo = argv[++i]; else if (!file) file = argv[i]; else return 2; }
  if (!file) { console.error("usage: validate-impact.mjs <impact.json> [--repo <dir>]"); return 2; }
  let report;
  try { report = JSON.parse(readFileSync(file, "utf8")); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); return 2; }
  const errors = validate(report, { root: repo });
  for (const e of errors) console.log(e);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
