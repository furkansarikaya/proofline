#!/usr/bin/env node
// Mechanically verifies an evidence-map document (an Explorer result or the lead's consolidated
// EVIDENCE.md, see ../references/) against a repository: required sections, claim table shape,
// category coverage, and every `path:symbol` / `path:line` claim (path exists inside the repo,
// symbol occurs as a whole word, line is in range). No dependencies.
// Usage: node <skill-dir>/scripts/verify-claims.mjs <evidence.md> [--repo <dir>]
// Exit codes: 0 valid, 1 invalid (one message per line), 2 usage or read error.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const CATEGORIES = ["code", "test", "pattern", "dependency", "constraint", "affected", "risk", "conflict"];
export const RISK_CATEGORIES = ["risk", "conflict"];
export const SEVERITIES = ["info", "blocking"];
const SYMBOL = /^[A-Za-z_$][\w$]*(?:(?:\.|#|::)[A-Za-z_$][\w$]*)*$/;
// Explorer rows use the result protocol id `explorer-<n>` (agent.sh record); the lead's consolidated rows are renumbered `E-<n>`.
const ROW_ID = { explorer: /^explorer-\d+$/, consolidated: /^E-\d+$/ };

// A79 assumption register: a consolidated EVIDENCE.md carries `## Assumptions` (`none` or the table below). The
// status written here is verified|unverified; `accepted-by-user` is recorded by the run. Same rules as
// plan-contract's validate-plan.mjs and agent.sh assumption_scan (skills are standalone, so the code is copied).
export const ASSUMPTION_COLUMNS = ["id", "assumption", "source", "risk", "verification", "status", "decisions"];
const NO_METHOD = /^(none|n\/a|-|tbd|todo|unknown)?$/i;
export function assumptionProblems(lines) {
  const out = [];
  const content = lines.filter((l) => l.trim() !== "");
  if (content.length === 0) return ['section "## Assumptions" is empty: write "none" or the assumption table'];
  if (content.length === 1 && /^none\s*$/i.test(content[0].trim())) return out;
  const ids = new Set();
  let header = false, rows = 0;
  for (const l of content) {
    if (!/^\s*\|.*\|\s*$/.test(l)) { out.push(`Assumptions: "${l.trim()}" is not a table row (write "none" or the table)`); continue; }
    const c = cells(l);
    if (!header) {
      header = true;
      if (c.join("|").toLowerCase() !== ASSUMPTION_COLUMNS.join("|")) out.push(`Assumptions: header must be | ${ASSUMPTION_COLUMNS.join(" | ")} |`);
      continue;
    }
    if (/^:?-+:?$/.test(c[0])) continue;
    rows++;
    const [id, text, source, risk, method, status, decisions] = c;
    const at = `Assumptions ${id || "(no id)"}`;
    if (c.length !== 7) { out.push(`${at}: expected 7 columns`); continue; }
    if (!/^AS-\d+$/.test(id)) out.push(`${at}: id must match AS-<n>`);
    if (ids.has(id.toUpperCase().replace(/-0+(?=\d)/g, "-"))) out.push(`${at}: duplicate id`);   // A172: by key
    ids.add(id.toUpperCase().replace(/-0+(?=\d)/g, "-"));
    if (!text) out.push(`${at}: assumption text is empty`);
    if (!source) out.push(`${at}: source is empty`);
    if (!["low", "medium", "high"].includes(risk)) out.push(`${at}: risk must be low|medium|high`);
    if (!["verified", "unverified"].includes(status)) out.push(`${at}: status must be verified|unverified (accepted-by-user is recorded by the run, not written here)`);
    if (status === "verified" && NO_METHOD.test(method)) out.push(`${at}: verified without a verification method (name what was checked, for example a claim id or a command)`);
    if (risk === "high" && NO_METHOD.test(method)) out.push(`${at}: a high-risk assumption needs a verification method`);
    if (!decisions) out.push(`${at}: decisions is empty (name what the assumption affects)`);
  }
  if (rows === 0) out.push('section "## Assumptions" has no assumption rows: write "none" or the table');
  return out;
}

// A claim is `<path>:<locator>`; the path never contains whitespace or a colon.
export function parseClaim(text) {
  const m = /^([^\s:`]+):([^\s`]+)$/.exec(text.trim());
  if (!m) return null;
  const [, path, loc] = m;
  if (/^\d+$/.test(loc)) return { path, line: Number(loc), end: Number(loc) };
  const r = /^(\d+)-(\d+)$/.exec(loc);
  if (r) return { path, line: Number(r[1]), end: Number(r[2]) };
  if (SYMBOL.test(loc)) return { path, symbol: loc };
  return { path, malformed: loc };
}

function sections(md) {
  const out = new Map();
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const h = /^## (.+?)\s*$/.exec(line);
    if (h) { cur = h[1]; out.set(cur, []); continue; }
    if (cur) out.get(cur).push(line);
  }
  return out;
}

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function parse(md) {
  const title = (/^# (.+)$/m.exec(md) || [])[1] || "";
  const kind = /^Evidence: /.test(title) ? "consolidated" : /^Explorer evidence: /.test(title) ? "explorer" : null;
  const secs = sections(md);
  const rows = [];
  for (const line of secs.get("Claims") || []) {
    if (!/^\s*\|/.test(line)) continue;
    const c = cells(line);
    if (c[0] === "id" || /^-+$/.test(c[0].replace(/:/g, ""))) continue;
    rows.push({ id: c[0], severity: c[1], claim: (c[2] || "").replace(/^`|`$/g, ""), finding: c[3] || "", evidence: c[4] || "", cellCount: c.length });
  }
  const notFound = (secs.get("Not found") || []).map((l) => /^\s*-\s*([a-z]+):\s*none\b\s*(?:—|-|:)\s*(.+)$/.exec(l)).filter(Boolean).map((m) => ({ category: m[1], reason: m[2].trim() }));
  return { kind, title, sections: secs, rows, notFound };
}

// Every backticked `path:locator` anywhere in the document is a claim and must verify.
export function backtickedClaims(md) {
  const found = [];
  for (const m of md.matchAll(/`([^`\n]+)`/g)) {
    const c = parseClaim(m[1]);
    // A path needs a "." or "/" so header-like spans (`RESULT:DONE`) and URL schemes are not claims.
    if (c && /[./]/.test(c.path)) found.push(m[1]);
  }
  return [...new Set(found)];
}

export function verifyClaim(text, root) {
  const c = parseClaim(text);
  if (!c) return `${text}: not a path:symbol or path:line claim`;
  if (c.malformed !== undefined) return `${text}: locator "${c.malformed}" is neither a line, a line range, nor a symbol`;
  if (isAbsolute(c.path) || c.path.split(/[\\/]/).includes("..")) return `${text}: path must be repo-relative without ".."`;
  let real;
  const rootReal = realpathSync(root);
  try { real = realpathSync(resolve(rootReal, c.path)); } catch { return `${text}: path does not exist`; }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) return `${text}: path resolves outside the repository`;
  if (!statSync(real).isFile()) return `${text}: path is not a file`;
  const body = readFileSync(real, "utf8");
  if (c.symbol !== undefined) {
    for (const seg of c.symbol.split(/\.|#|::/)) {
      const esc = seg.replace(/\$/g, "\\$");
      if (!new RegExp(`(^|[^\\w$])${esc}([^\\w$]|$)`, "m").test(body)) return `${text}: symbol "${seg}" does not occur in ${c.path}`;
    }
    return null;
  }
  const lines = body.split(/\r?\n/).length - (body.endsWith("\n") ? 1 : 0);
  if (c.line < 1 || c.end < c.line || c.end > lines) return `${text}: line range out of bounds (file has ${lines} lines)`;
  return null;
}

export function validate(md, { root }) {
  const errors = [];
  const doc = parse(md);
  if (!doc.kind) { errors.push('title: must be "# Explorer evidence: <target> — <assignment>" or "# Evidence: <TASK-ID>"'); return errors; }
  const required = doc.kind === "explorer"
    ? ["Assignment", "Claims", "Not found", "Open questions", "Stop"]
    : ["Repository", "Claims", "Not found", "Open questions", "Derived constraints", "Assumptions"];
  for (const s of required) if (!doc.sections.has(s)) errors.push(`section "## ${s}" is missing`);
  if (doc.kind === "consolidated" && doc.sections.has("Assumptions")) errors.push(...assumptionProblems(doc.sections.get("Assumptions")));
  if (doc.kind === "explorer") {
    const a = (doc.sections.get("Assignment") || []).join("\n");
    for (const k of ["Objective", "Allowed scope", "Expected output", "Stop condition"]) {
      if (!new RegExp(`^- ${k}: \\S`, "m").test(a)) errors.push(`Assignment: "- ${k}: ..." is missing`);
    }
    if (!/^- Reason: (objective met|stop condition reached|scope exhausted)\s*$/m.test((doc.sections.get("Stop") || []).join("\n"))) {
      errors.push('Stop: "- Reason: objective met|stop condition reached|scope exhausted" is missing');
    }
  } else if (!/^- Base SHA: [0-9a-f]{7,64}\s*$/m.test((doc.sections.get("Repository") || []).join("\n"))) {
    errors.push('Repository: "- Base SHA: <sha>" is missing');
  }
  if (doc.rows.length === 0) errors.push("Claims: no claim rows");
  const ids = new Set();
  const seen = new Set();
  const covered = new Set();
  for (const r of doc.rows) {
    const at = `Claims ${r.id || "(no id)"}`;
    if (r.cellCount !== 5) errors.push(`${at}: expected 5 columns | id | severity | path:line | finding | evidence |`);
    if (!ROW_ID[doc.kind].test(r.id)) errors.push(`${at}: id must match ${doc.kind === "explorer" ? "explorer-<n>" : "E-<n>"}`);
    if (ids.has(r.id)) errors.push(`${at}: duplicate id`);
    ids.add(r.id);
    const cat = (/^([a-z]+): \S/.exec(r.finding) || [])[1];
    if (!CATEGORIES.includes(cat)) { errors.push(`${at}: finding must start with "<category>: " (${CATEGORIES.join("|")})`); continue; }
    covered.add(cat);
    // blocking is for a regression risk or a conflicting implementation the lead must resolve.
    const okSev = RISK_CATEGORIES.includes(cat) ? SEVERITIES : ["info"];
    if (!okSev.includes(r.severity)) errors.push(`${at}: severity must be ${okSev.join("|")} for category ${cat}`);
    if (!r.evidence) errors.push(`${at}: evidence (how the claim was verified) is empty`);
    const key = `${cat} ${r.claim}`;
    if (seen.has(key)) errors.push(`${at}: duplicate claim ${r.claim} in category ${cat}`);
    seen.add(key);
    const err = verifyClaim(r.claim, root);
    if (err) errors.push(`${at}: ${err}`);
  }
  for (const nf of doc.notFound) {
    if (!CATEGORIES.includes(nf.category)) errors.push(`Not found: unknown category ${nf.category}`);
    else if (covered.has(nf.category)) errors.push(`Not found: ${nf.category} has claim rows and a "none" line`);
    covered.add(nf.category);
  }
  for (const c of CATEGORIES) if (!covered.has(c)) errors.push(`category ${c}: no claim row and no "- ${c}: none — <reason>" line under Not found`);
  const rowClaims = new Set(doc.rows.map((r) => r.claim));
  for (const t of backtickedClaims(md)) {
    if (rowClaims.has(t)) continue;
    const err = verifyClaim(t, root);
    if (err) errors.push(`text claim: ${err}`);
  }
  if (doc.kind === "consolidated") {
    for (const line of doc.sections.get("Derived constraints") || []) {
      if (!/^\s*-\s/.test(line) || /^\s*-\s*none\b/.test(line)) continue;
      const refs = [...line.matchAll(/\bE-\d+\b/g)].map((m) => m[0]);
      if (refs.length === 0) errors.push(`Derived constraints: "${line.trim()}" cites no claim id`);
      for (const id of refs) if (!ids.has(id)) errors.push(`Derived constraints: unknown claim id ${id}`);
    }
  }
  return errors;
}

function main(argv) {
  const args = argv.slice(2);
  let root = process.cwd();
  const i = args.indexOf("--repo");
  if (i !== -1) { root = args[i + 1]; args.splice(i, 2); }
  if (args.length !== 1 || !root) { console.error("usage: verify-claims.mjs <evidence.md> [--repo <dir>]"); return 2; }
  let md;
  try { md = readFileSync(args[0], "utf8"); realpathSync(root); } catch (e) { console.error(`error: ${e.message}`); return 2; }
  const errors = validate(md, { root });
  for (const e of errors) console.log(e);
  if (errors.length === 0) console.log("valid");
  return errors.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv);
