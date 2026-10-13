#!/usr/bin/env node
// Validates a contract-proof report (contract.json, schema ../schema/contract.schema.json) and derives
// the gate result mechanically.
// Usage: node validate-contract.mjs <contract.json> [--table]
//   valid   -> exit 0; prints "RESULT: PASS|FAIL|UNSUPPORTED", "CONFIDENCE: high|medium|low" and, for
//              UNSUPPORTED, "REASON: ..."; --table also prints the `agent.sh submit --findings` rows.
//   invalid -> exit 1 with one error per line; unreadable input or usage error -> exit 2.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { RULES, BLOCKING_CLASSES, COVER_KEYWORD } from "./diff-contract.mjs";

export const FORMATS = ["openapi", "asyncapi", "jsonschema", "graphql", "proto", "json", "yaml", "avro", "thrift", "raml", "wsdl", "xsd", "unknown"];
export const SIDES = ["request", "response", "both"];
export const EVIDENCE = ["measured", "traced"];
export const CONSUMER_SOURCES = ["impact", "search", "not-searched"];
const isInt = (n) => Number.isInteger(n) && n >= 1;
const str = (s) => typeof s === "string" && s.trim() !== "";

export function validate(doc) {
  const e = [];
  if (!doc || typeof doc !== "object") return ["report is not an object"];
  if (doc.schema_version !== 1) e.push("schema_version must be 1");
  if (!doc.target || typeof doc.target !== "object") e.push("target missing");
  const used = new Set();
  if (!doc.tools || !Array.isArray(doc.tools.detected) || !Array.isArray(doc.tools.used)) e.push("tools.detected and tools.used must be arrays");
  else for (const [i, t] of doc.tools.used.entries()) {
    if (!str(t.name) || !str(t.command) || !Number.isInteger(t.exit_code) || typeof t.output_excerpt !== "string") e.push(`tools.used[${i}]: name, command, exit_code and output_excerpt required`);
    else used.add(t.name);
  }
  if (!Array.isArray(doc.files)) { e.push("files must be an array"); return e; }
  const ids = new Set();
  for (const [fi, f] of doc.files.entries()) {
    const at = `files[${fi}]`;
    if (!str(f.path)) e.push(`${at}: path missing`);
    if (!FORMATS.includes(f.format)) e.push(`${at}: format ${f.format} not in ${FORMATS.join("|")}`);
    if (!["compared", "unsupported"].includes(f.status)) e.push(`${at}: status must be compared|unsupported`);
    if (!Array.isArray(f.changes)) { e.push(`${at}: changes must be an array`); continue; }
    if (f.status === "unsupported") {
      if (!str(f.reason)) e.push(`${at}: an unsupported file needs a reason`);
      if (f.changes.length) e.push(`${at}: an unsupported file has no classified changes (nothing was proven)`);
    }
    for (const [ci, c] of f.changes.entries()) {
      const w = `${at} ${c.id || `changes[${ci}]`}`;
      if (!/^C-\d+$/.test(c.id || "")) e.push(`${w}: id must be C-<n>`);
      else if (ids.has(c.id)) e.push(`${w}: duplicate id`); else ids.add(c.id);
      if (!RULES[c.rule]) { e.push(`${w}: rule ${c.rule} is not a rule id of RULES.md`); continue; }
      if (c.classification !== RULES[c.rule][0]) e.push(`${w}: classification ${c.classification} does not match ${c.rule} (${RULES[c.rule][0]})`);
      if (!SIDES.includes(c.side)) e.push(`${w}: side must be ${SIDES.join("|")}`);
      if (!str(c.element) || !str(c.location)) e.push(`${w}: element and location required`);
      if (!isInt(c.line) || !["head", "base"].includes(c.line_in)) e.push(`${w}: line (>= 1) and line_in head|base required`);
      const ev = c.evidence || {};
      if (!EVIDENCE.includes(ev.class)) e.push(`${w}: evidence.class must be ${EVIDENCE.join("|")} (judged items go to judged[])`);
      if (!str(ev.source)) e.push(`${w}: evidence.source required`);
      else if (ev.source.startsWith("tool:") && !used.has(ev.source.slice(5))) e.push(`${w}: evidence from ${ev.source} but that tool is not in tools.used`);
      if (ev.class === "traced" && !str(ev.detail)) e.push(`${w}: traced evidence needs detail (what was read, where)`);
      const cv = c.coverage;
      if (!cv || typeof cv.covered !== "boolean") e.push(`${w}: coverage.covered required`);
      else if (cv.covered) {
        if (!BLOCKING_CLASSES.includes(c.classification)) e.push(`${w}: only a breaking or needs-review change is covered by the plan`);
        if (!isInt(cv.plan_line) || !str(cv.text)) e.push(`${w}: a covered change cites plan_line and the bullet text`);
        else if (!COVER_KEYWORD.test(cv.text)) e.push(`${w}: the cited bullet states no versioning, migration or deprecation`);
        else if (!cv.text.includes(c.element)) e.push(`${w}: the cited bullet does not name ${c.element}`);
      }
      const co = c.consumers;
      if (!co || !CONSUMER_SOURCES.includes(co.source) || !Array.isArray(co.in_repo)) e.push(`${w}: consumers.source (${CONSUMER_SOURCES.join("|")}) and consumers.in_repo required`);
      else {
        if (co.outside_repo !== "unknown") e.push(`${w}: consumers.outside_repo must be "unknown" (consumers outside the repository cannot be known)`);
        if (BLOCKING_CLASSES.includes(c.classification) && co.source === "not-searched") e.push(`${w}: a ${c.classification} change needs its in-repo consumers searched (impact report or search)`);
        for (const r of co.in_repo) if (!str(r.path) || !isInt(r.line)) e.push(`${w}: consumer rows need path and line`);
      }
    }
  }
  if (!Array.isArray(doc.judged)) e.push("judged must be an array");
  else for (const [i, j] of doc.judged.entries()) {
    if (!/^J-\d+$/.test(j.id || "") || !str(j.location) || !str(j.text)) e.push(`judged[${i}]: id J-<n>, location and text required`);
    if (j.criterion !== null && !str(j.criterion)) e.push(`judged[${i}]: criterion is null or the spec/plan criterion it violates`);
  }
  return e;
}

const loc = (f, c) => `${f.path}:${c.line}`;
// one findings row; a | or newline inside a field would split it
const row = (...f) => f.map((x) => String(x).replace(/[|\n]/g, "/")).join("|");
export function gate(doc) {
  const rows = [];
  const unsupported = doc.files.filter((f) => f.status === "unsupported");
  for (const f of doc.files) for (const c of f.changes) {
    const cons = `in-repo consumers: ${c.consumers.in_repo.length ? c.consumers.in_repo.map((r) => `${r.path}:${r.line}`).join(", ") : "none found statically"}; outside the repo: unknown`;
    const what = `${c.rule} ${c.classification} (${c.side}) ${c.element}: ${RULES[c.rule][1]}`;
    const ev = `${c.evidence.class} by ${c.evidence.source}${c.line_in === "base" ? " (base line)" : ""}: ${c.before ?? "absent"} -> ${c.after ?? "absent"}`;
    if (BLOCKING_CLASSES.includes(c.classification)) {
      if (c.coverage.covered) rows.push(row("info", loc(f, c), `${what}; covered by PLAN.md:${c.coverage.plan_line}`, `${ev}; ${cons}`));
      else rows.push(row("blocking", loc(f, c), `${what}; not covered by versioning, migration or deprecation in PLAN.md ## Contracts`, `${ev}; ${cons}`));
    } else if (c.rule === "CP-N04" || c.rule === "CP-N07") rows.push(row("info", loc(f, c), what, `${ev}; ${cons}`));
  }
  for (const j of doc.judged) rows.push(row(j.criterion ? "blocking" : "info", j.location, `judged: ${j.text}${j.criterion ? `; violates: ${j.criterion}` : ""}`, "judged"));
  const blocking = rows.some((r) => r.startsWith("blocking|"));
  if (blocking) for (const f of unsupported) rows.push(row("blocking", `${f.path}:1`, `UNSUPPORTED ${f.format}: ${f.reason}`, "no compatibility proof for this file"));
  const result = blocking ? "FAIL" : unsupported.length ? "UNSUPPORTED" : "PASS";
  const reason = unsupported.length ? unsupported.map((f) => `${f.path} (${f.format}): ${f.reason}`).join("; ") : null;
  const searched = doc.files.flatMap((f) => f.changes).filter((c) => BLOCKING_CLASSES.includes(c.classification));
  const confidence = unsupported.length ? "low" : searched.some((c) => c.consumers.source !== "impact") ? "medium" : "high";
  return { result, confidence, reason, rows };
}

function main(args) {
  const table = args.includes("--table");
  const files = args.filter((a) => a !== "--table");
  if (files.length !== 1) { console.error("usage: validate-contract.mjs <contract.json> [--table]"); process.exit(2); }
  let doc;
  try { doc = JSON.parse(readFileSync(files[0], "utf8")); } catch (err) { console.error(`cannot read input: ${err.message}`); process.exit(2); }
  const errors = validate(doc);
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  const g = gate(doc);
  console.log(`RESULT: ${g.result}\nCONFIDENCE: ${g.confidence}`);
  if (g.result === "UNSUPPORTED") console.log(`REASON: ${g.reason}`);
  if (table && g.rows.length) console.log(g.rows.join("\n"));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
