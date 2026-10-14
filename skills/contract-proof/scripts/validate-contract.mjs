#!/usr/bin/env node
// Validates a contract-proof report (contract.json, schema ../schema/contract.schema.json) and derives
// the gate result mechanically.
// Usage: node validate-contract.mjs <contract.json> [--table] [--plan PLAN.md] [--repo DIR --base REF [--path P]...]
//   --plan       re-derives every change's coverage from PLAN.md `## Contracts`; without it no change counts
//                as covered (the report's own `covered: true` is never trusted)
//   --repo/--base re-runs diff-contract.mjs (with the same --path list and the repository's contract.paths /
//                contract.ignore) and requires every change it finds, with the same rule (only a CP-U01 may
//                have been reclassified, with traced evidence)
//   valid   -> exit 0; prints "RESULT: PASS|FAIL|UNSUPPORTED", "CONFIDENCE: high|medium|low" and, for
//              UNSUPPORTED, "REASON: ..."; then "FILE: compared|unsupported <path>" per file and, with --base,
//              "BASE: <commit>" (A102: saved, this output is the evidence of an UNSUPPORTED submission);
//              --table also prints the `agent.sh submit --findings` rows.
//   invalid -> exit 1 with one error per line; unreadable input or usage error -> exit 2.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { RULES, BLOCKING_CLASSES, COVER_KEYWORD, NOT_A_CONTRACT, globMatch, coverage, planBullets, hasToken, run } from "./diff-contract.mjs";

export const FORMATS = ["openapi", "asyncapi", "jsonschema", "graphql", "proto", "json", "yaml", "avro", "thrift", "raml", "wsdl", "xsd", "unknown"];
export const SIDES = ["request", "response", "both"];
export const EVIDENCE = ["measured", "traced"];
export const CONSUMER_SOURCES = ["impact", "search", "not-searched"];
const isInt = (n) => Number.isInteger(n) && n >= 1;
const str = (s) => typeof s === "string" && s.trim() !== "";

export function validate(doc, { bullets = null, regenerated = null } = {}) {
  const e = [];
  if (!doc || typeof doc !== "object") return ["report is not an object"];
  if (doc.schema_version !== 1) e.push("schema_version must be 1");
  if (!doc.target || typeof doc.target !== "object") e.push("target missing");
  const used = new Set();
  if (!doc.tools || !Array.isArray(doc.tools.detected) || !Array.isArray(doc.tools.used)) e.push("tools.detected and tools.used must be arrays");
  else for (const [i, t] of doc.tools.used.entries()) {
    if (!str(t.name) || !str(t.command) || !Number.isInteger(t.exit_code) || typeof t.output_excerpt !== "string") e.push(`tools.used[${i}]: name, command, exit_code and output_excerpt required`);
    else if (!(Array.isArray(regenerated?.tools?.detected) ? regenerated.tools.detected : doc.tools.detected).some((d) => d && d.name === t.name)) e.push(`tools.used[${i}]: ${t.name} is not a detected tool (tools.detected); a tool that was not found was not used`);
    else if (!t.output_excerpt.trim() || !t.command.includes(t.name)) e.push(`tools.used[${i}]: a used tool needs its command (naming it) and the output it produced`);
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
      if (ev.source === "diff-contract.mjs" && !RULES[c.original_rule]) e.push(`${w}: a differ change keeps original_rule`);
      if (c.original_rule !== undefined && c.original_rule !== c.rule) {
        if (c.original_rule !== "CP-U01") e.push(`${w}: rule ${c.original_rule} was rewritten to ${c.rule}; only a CP-U01 may be reclassified`);
        else if (ev.class !== "traced") e.push(`${w}: a reclassified CP-U01 needs traced evidence`);
      }
      if (str(c.line_file) && c.line_file.startsWith("/")) e.push(`${w}: line_file is a repository-relative path`);
      const cv = c.coverage;
      if (!cv || typeof cv.covered !== "boolean") e.push(`${w}: coverage.covered required`);
      else if (cv.covered) {
        if (!BLOCKING_CLASSES.includes(c.classification)) e.push(`${w}: only a breaking or needs-review change is covered by the plan`);
        if (!isInt(cv.plan_line) || !str(cv.text)) e.push(`${w}: a covered change cites plan_line and the bullet text`);
        else if (!COVER_KEYWORD.test(cv.text)) e.push(`${w}: the cited bullet states no versioning, migration or deprecation`);
        else if (!hasToken(cv.text, c.element)) e.push(`${w}: the cited bullet does not name ${c.element} as a whole name`);
        else if (!hasToken(cv.text, f.path)) e.push(`${w}: the cited bullet does not name ${f.path}`);
      }
      if (bullets && cv && typeof cv.covered === "boolean") {
        const want = coverage(f.path, c, bullets);
        if (want.covered !== cv.covered || (want.covered && want.plan_line !== cv.plan_line)) e.push(`${w}: coverage disagrees with PLAN.md (covered there: ${want.covered}${want.covered ? ` at line ${want.plan_line}` : ""})`);
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
  if (regenerated) {
    if (JSON.stringify(regenerated.settings || {}) !== JSON.stringify(doc.settings || { paths: [], ignore: [] })) e.push(`settings ${JSON.stringify(doc.settings)} differ from the repository's contract.paths/contract.ignore ${JSON.stringify(regenerated.settings)}`);
    const want = new Set((regenerated.ignored || []).map((g) => g.path));
    for (const g of doc.ignored || []) if (!want.has(g.path)) e.push(`ignored ${g.path}: the differ does not ignore it`);
    const byPath = new Map(doc.files.map((f) => [f.path, f]));
    // only a tool that was detected and left its command and output counts; its formats must cover the file's
    const toolFormats = new Set((regenerated.tools?.detected || []).filter((d) => used.has(d.name)).flatMap((d) => d.formats || []));
    for (const g of regenerated.files) {
      const f = byPath.get(g.path);
      if (!f) { e.push(`${g.path}: the differ reports this file; the report dropped it`); continue; }
      if (g.status === "unsupported" && f.status !== "unsupported" && !toolFormats.has(g.format)) e.push(`${g.path}: the differ cannot parse it; only the result of a detected tool that handles ${g.format} may make it compared`);
      const left = [...(f.changes || [])];
      for (const c of g.changes) {
        const i = left.findIndex((x) => x.location === c.location && (x.rule === c.rule || (c.rule === "CP-U01" && x.evidence?.class === "traced")));
        if (i < 0) e.push(`${g.path} ${c.location}: the differ finds ${c.rule}; the report has no change with that rule (only a CP-U01 may be reclassified)`);
        else left.splice(i, 1);
      }
    }
  }
  if (doc.ignored !== undefined) {
    if (!Array.isArray(doc.ignored)) e.push("ignored must be an array");
    else for (const [i, g] of doc.ignored.entries()) {
      if (!str(g.path) || !str(g.reason)) e.push(`ignored[${i}]: path and reason required`);
      else if (!NOT_A_CONTRACT.test(g.path) && !globMatch(g.path, doc.settings?.ignore || [])) e.push(`ignored[${i}]: ${g.path} is neither on the not-a-contract list nor under contract.ignore; only those files may be ignored`);
    }
  }
  if (!Array.isArray(doc.judged)) e.push("judged must be an array");
  else for (const [i, j] of doc.judged.entries()) {
    if (!/^J-\d+$/.test(j.id || "") || !str(j.location) || !str(j.text)) e.push(`judged[${i}]: id J-<n>, location and text required`);
    if (j.criterion !== null && !str(j.criterion)) e.push(`judged[${i}]: criterion is null or the spec/plan criterion it violates`);
  }
  return e;
}

const loc = (f, c) => `${c.line_file || f.path}:${c.line}`;
// one findings row; a | or newline inside a field would split it
const row = (...f) => f.map((x) => String(x).replace(/[|\n]/g, "/")).join("|");
// `trustCoverage` is true only when validate() re-derived coverage from the plan (--plan)
export function gate(doc, { trustCoverage = false } = {}) {
  const rows = [];
  const unsupported = doc.files.filter((f) => f.status === "unsupported");
  for (const f of doc.files) for (const c of f.changes) {
    const cons = `in-repo consumers: ${c.consumers.in_repo.length ? c.consumers.in_repo.map((r) => `${r.path}:${r.line}`).join(", ") : "none found statically"}; outside the repo: unknown`;
    const what = `${c.rule} ${c.classification} (${c.side}) ${c.element}: ${RULES[c.rule][1]}`;
    const ev = `${c.evidence.class} by ${c.evidence.source}${c.line_in === "base" ? " (base line)" : ""}: ${c.before ?? "absent"} -> ${c.after ?? "absent"}`;
    if (BLOCKING_CLASSES.includes(c.classification)) {
      if (trustCoverage && c.coverage.covered) rows.push(row("info", loc(f, c), `${what}; covered by PLAN.md:${c.coverage.plan_line}`, `${ev}; ${cons}`));
      else rows.push(row("blocking", loc(f, c), `${what}; not covered by versioning, migration or deprecation in PLAN.md ## Contracts`, `${ev}; ${cons}`));
    } else if (c.rule === "CP-N04" || c.rule === "CP-N07") rows.push(row("info", loc(f, c), what, `${ev}; ${cons}`));
  }
  for (const g of doc.ignored || []) rows.push(row("info", `${g.path}:1`, `not compared: ${g.reason}`, "changed data file on the not-a-contract list"));
  for (const j of doc.judged) rows.push(row(j.criterion ? "blocking" : "info", j.location, `judged: ${j.text}${j.criterion ? `; violates: ${j.criterion}` : ""}`, "judged"));
  const blocking = rows.some((r) => r.startsWith("blocking|"));
  if (blocking) for (const f of unsupported) rows.push(row("blocking", `${f.path}:1`, `UNSUPPORTED ${f.format}: ${f.reason}`, "no compatibility proof for this file"));
  // nothing recognized while the focus runs (a contract signal or flag selected it) proves nothing
  const empty = doc.files.length === 0;
  const result = blocking ? "FAIL" : unsupported.length || empty ? "UNSUPPORTED" : "PASS";
  const reason = unsupported.length ? unsupported.map((f) => `${f.path} (${f.format}): ${f.reason}`).join("; ")
    : empty ? "no changed contract file was recognized; pass the signalled files with --path" : null;
  const searched = doc.files.flatMap((f) => f.changes).filter((c) => BLOCKING_CLASSES.includes(c.classification));
  const confidence = unsupported.length || empty ? "low" : searched.some((c) => c.consumers.source !== "impact") ? "medium" : "high";
  return { result, confidence, reason, rows };
}

function main(args) {
  const usage = () => { console.error("usage: validate-contract.mjs <contract.json> [--table] [--plan PLAN.md] [--repo DIR --base REF [--path P]...]"); process.exit(2); };
  const o = { files: [], paths: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--table") o.table = true;
    else if (a === "--plan" || a === "--repo" || a === "--base") { if (args[i + 1] === undefined) usage(); o[a.slice(2)] = args[++i]; }
    else if (a === "--path") { if (args[i + 1] === undefined) usage(); o.paths.push(args[++i]); }
    else if (a.startsWith("-")) usage();
    else o.files.push(a);
  }
  if (o.files.length !== 1 || !o.repo !== !o.base || (o.base && o.base.startsWith("-")) || (o.paths.length && !o.repo)) usage();
  let doc, bullets = null, regenerated = null;
  try {
    doc = JSON.parse(readFileSync(o.files[0], "utf8"));
    if (o.plan) bullets = planBullets(readFileSync(o.plan, "utf8"));
    if (o.repo) regenerated = run({ repo: o.repo, base: o.base, paths: o.paths, plan: null, impact: null });
  } catch (err) { console.error(`cannot read input: ${err.message}`); process.exit(2); }
  const errors = validate(doc, { bullets, regenerated });
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  const g = gate(doc, { trustCoverage: bullets !== null });
  console.log(`RESULT: ${g.result}\nCONFIDENCE: ${g.confidence}`);
  if (g.result === "UNSUPPORTED") console.log(`REASON: ${g.reason}`);
  // A102: the per-file status and the resolved base make this output the evidence of an UNSUPPORTED submission
  for (const f of doc.files) console.log(`FILE: ${f.status} ${f.path}`);
  if (o.base) { try { console.log(`BASE: ${execFileSync("git", ["-C", o.repo, "rev-parse", "--verify", `${o.base}^{commit}`], { encoding: "utf8" }).trim()}`); } catch { /* unresolvable: the differ already refused it */ } }
  if (o.table && g.rows.length) console.log(g.rows.join("\n"));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
