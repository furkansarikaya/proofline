#!/usr/bin/env node
// Checks the claims of the discovery documents (FRAME.md, RESEARCH.md, COMPETITORS.md, INTERVIEWS.md) of one slug.
//   node check-research.mjs <slug|dir|file> [--today YYYY-MM-DD] [--root DIR] [--json]
// A claim is a line `- C-n <text> <marker>`. Rules: invalid-marker, unmarked, duplicate-id, unsourced-number (the
// text holds a number, percent, amount of money or market size and the marker is not a valid sourced fact),
// number-not-in-quote (web and interview facts: every number of the text occurs in the quote),
// persona-without-source (a persona line needs a valid fact marker). A number in an assumption claim is allowed when the
// marker is an estimate with a basis: `[assumption: value estimate "<basis>"]` (a number with no source is never a fact).
// pending-proposal (a `[proposal: ...]` marker the user has not answered), rejected-proposal (a malformed
// `## Rejected proposals` line).
// RESEARCH.md also needs the method (references/DISCOVERY-FORMAT.md): `## Search plan` with `- SQ-n <question>;
// queries: a | b; sources: <types>` lines written before the search, every SQ-n answered by a claim that names it or
// listed under `## Searched, not found` (rules no-search-plan, plan-field, query-unanswered, dangling-query,
// no-not-found). A claim tagged `(critical; second source: C-m)` needs a second valid fact from an independent source
// (critical-needs-second-source, not-independent). Web facts older than product.stale_days are listed as stale.
// Exit 0 clean (stale facts are listed, not failed), 1 findings, 2 usage.
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { read, idLines, resolveTarget, isDir, parseArgs, report, stripComments, section, sectionItems, staleDays } from "./lib.mjs";
import { MARKER, rejectedProposals } from "./validate-product-claims.mjs";

const FILES = ["FRAME.md", "RESEARCH.md", "COMPETITORS.md", "INTERVIEWS.md"];
const UNIT = /\b(million|billion|trillion|thousand|percent|per ?cent|dollars?|euros?)\b/i;
const NUM = /\d[\d.,]*\d|\d/g;
const norm = (n) => n.replace(/,/g, "").replace(/\.$/, "");

// Numbers of a claim text, without the marker, ids (C-3, INT-2) and dates (2026-10-21).
export function numbersOf(text) {
  const t = text.replace(MARKER, " ").replace(/\d{4}-\d{2}-\d{2}/g, " ").replace(/\b[A-Za-z]{1,4}-\d+\b/g, " ").replace(/^-\s*/, "");
  return { nums: (t.match(NUM) || []).map(norm), unit: UNIT.test(t) || /[%$€£]/.test(t) };
}

export const SOURCE_TYPES = ["official-docs", "pricing", "changelog", "regulation", "reviews", "forums", "jobs", "interviews", "data"];
const CRITICAL = /\(\s*critical\s*(?:;\s*second source:\s*(C-\d+)\s*)?\)/i;
// The origin of a valid fact, for the independence test: web by host (www. removed), others by their own key.
export function sourceKey(m) {
  if (m.source === "web") { try { return `web:${new URL(m.url).hostname.replace(/^www\./i, "").toLowerCase()}`; } catch { return `web:${m.url}`; } }
  if (m.source === "interview") return `interview:${m.interview.toUpperCase()}`;
  if (m.source === "data") return `data:${m.query}`;
  return `ref:${m.slug}#${m.id}`;
}

function checkMethod(name, text, findings) {
  const add = (line, rule, message) => findings.push({ file: name, line, id: null, rule, message });
  const plan = section(text, "Search plan"), notFound = section(text, "Searched, not found");
  const sqs = sectionItems(plan, "SQ-\\d+");
  if (!sqs.length) add(plan ? plan[0]?.line ?? 1 : 1, "no-search-plan", "RESEARCH.md needs `## Search plan` with `- SQ-n <question>; queries: a | b; sources: <types>` lines, written before the search");
  const ids = new Set();
  for (const q of sqs) {
    if (ids.has(q.id)) add(q.line, "plan-field", `${q.id} is defined twice`);
    ids.add(q.id);
    const queries = /;\s*queries:\s*([^;]*[^;\s])/i.exec(q.body)?.[1], types = /;\s*sources:\s*([^;]*[^;\s])/i.exec(q.body)?.[1];
    if (!queries) add(q.line, "plan-field", `${q.id} names no queries (\`queries: a | b\`)`);
    if (!types) add(q.line, "plan-field", `${q.id} names no source types (\`sources: ${SOURCE_TYPES.join("|")}\`)`);
    else for (const t of types.split(/[,|]/).map((x) => x.trim().toLowerCase()).filter(Boolean)) if (!SOURCE_TYPES.includes(t)) add(q.line, "plan-field", `${q.id}: source type "${t}" is not one of ${SOURCE_TYPES.join("|")}`);
  }
  if (!notFound) add(1, "no-not-found", "RESEARCH.md ends with `## Searched, not found`: what was searched and what was NOT found (`- SQ-n <gap>`, or `- none`)");
  const nf = sectionItems(notFound, "SQ-\\d+");
  for (const n of nf) if (!ids.has(n.id)) add(n.line, "dangling-query", `${n.id} is not in the search plan`);
  const planLines = new Set((plan || []).map((l) => l.line)), nfLines = new Set((notFound || []).map((l) => l.line));
  const answered = new Set(nf.map((n) => n.id));
  stripComments(text).split(/\r?\n/).forEach((raw, i) => {
    if (planLines.has(i + 1) || nfLines.has(i + 1)) return;
    for (const m of raw.matchAll(/\bSQ-\d+\b/g)) answered.add(m[0]);
  });
  for (const id of ids) if (!answered.has(id)) add(sqs.find((q) => q.id === id).line, "query-unanswered", `${id} has no claim that names it and is not listed under "Searched, not found"`);
}

// Web facts older than `stale` days at `today`: [{ file, line, competitor, attribute, observed, ageDays }] (reported, never failed).
export function staleFacts(files, today, stale = 90) {
  const out = [];
  for (const { name, text } of files) for (const l of idLines(text, "C-\\d+")) {
    const m = l.markers[0];
    if (l.markers.length !== 1 || m.kind !== "fact" || m.source !== "web" || m.errors.length) continue;
    const age = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${m.accessed}T00:00:00Z`)) / 86400000);
    if (age > stale) out.push({ file: name, line: l.line, competitor: l.id, attribute: "web fact", observed: m.accessed, ageDays: age });
  }
  return out;
}

// files: [{ name, text }]. Returns the findings.
export function checkResearch(files) {
  const findings = [], seen = new Map();
  const claimOf = new Map();
  for (const { text } of files) for (const l of idLines(text, "C-\\d+")) claimOf.set(l.id, l);
  for (const { name, text } of files) {
    const add = (l, rule, message) => findings.push({ file: name, line: l.line, id: l.id, rule, message });
    for (const e of rejectedProposals(text).errors) findings.push({ file: name, line: e.line, id: null, rule: "rejected-proposal", message: e.message });
    if (name.toUpperCase() === "RESEARCH.MD") checkMethod(name, text, findings);
    for (const l of idLines(text, "C-\\d+")) {
      if (seen.has(l.id)) add(l, "duplicate-id", `${l.id} is already defined in ${seen.get(l.id)}`);
      seen.set(l.id, name);
      const m = l.markers[0];
      if (l.markers.length !== 1) add(l, l.markers.length ? "invalid-marker" : "unmarked", l.markers.length ? `a claim carries exactly one marker (found ${l.markers.length})` : "claim carries no marker (fact, assumption or decision)");
      if (m?.errors.length) add(l, "invalid-marker", m.errors[0]);
      const { nums, unit } = numbersOf(l.text);
      const validFact = l.markers.length === 1 && m.kind === "fact" && !m.errors.length;
      const estimate = l.markers.length === 1 && m.kind === "assumption" && !m.errors.length && !!m.estimate;
      if (l.markers.some((x) => x.kind === "proposal")) add(l, "pending-proposal", "a proposal the user has not answered stays out of the document: accepted becomes `source agent accepted by user`, rejected goes under `## Rejected proposals`");
      if ((nums.length || unit) && !validFact && !estimate) add(l, "unsourced-number", "the claim holds a number and is not a valid sourced fact; make it a fact with its source, mark the assumption as an estimate with a basis (`[assumption: value estimate \"<basis>\"]`), or take the number out");
      const crit = CRITICAL.exec(l.text.replace(MARKER, " "));
      if (crit) {
        const other = crit[1] && claimOf.get(crit[1]), om = other?.markers.length === 1 ? other.markers[0] : null;
        if (!validFact) add(l, "critical-needs-second-source", "a critical claim is a valid sourced fact");
        else if (!crit[1]) add(l, "critical-needs-second-source", "a critical fact needs a second source: `(critical; second source: C-<n>)`");
        else if (!om || om.kind !== "fact" || om.errors.length || crit[1] === l.id) add(l, "critical-needs-second-source", `${crit[1]} is not another valid fact of the slug`);
        else if (sourceKey(om) === sourceKey(m)) add(l, "not-independent", `${crit[1]} comes from the same source (${sourceKey(m)}); a second source is another site, interview or data set`);
      }
      if (validFact && (m.source === "web" || m.source === "interview")) {
        const q = new Set((m.quote.replace(/\d{4}-\d{2}-\d{2}/g, " ").match(NUM) || []).map(norm));
        const missing = nums.filter((n) => !q.has(n));
        if (missing.length) add(l, "number-not-in-quote", `number ${missing.join(", ")} of the claim does not occur in its quote`);
      }
      if (/\bpersona\b/i.test(l.text.replace(MARKER, "")) && !validFact) add(l, "persona-without-source", "a persona needs a valid fact marker (web, interview, data or ref)");
    }
    // persona lines that are no claims (`- Persona: ...`)
    let fence = false;
    stripComments(text).split(/\r?\n/).forEach((raw, i) => {
      if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
      if (fence || !/^\s*[-*]\s+persona\b/i.test(raw) || /^- C-\d+\s/.test(raw)) return;
      const ms = [...raw.matchAll(MARKER)];
      if (ms.length !== 1 || ms[0][1].toLowerCase() !== "fact") findings.push({ file: name, line: i + 1, id: null, rule: "persona-without-source", message: "a persona needs a valid fact marker (web, interview, data or ref)" });
    });
  }
  return findings;
}

function main(argv) {
  const a = parseArgs(argv, ["--root", "--today"], ["--json"]);
  if (a.bad || a._.length !== 1 || (a.today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(a.today))) { console.error("usage: check-research.mjs <slug|dir|file> [--today YYYY-MM-DD] [--root DIR] [--json]"); return 2; }
  const root = resolve(a.root || ".");
  const target = resolveTarget(a._[0], root);
  if (!existsSync(target)) { console.error(`not found: ${target}`); return 2; }
  const names = isDir(target) ? FILES.filter((n) => existsSync(join(target, n))) : [basename(target)];
  const files = names.map((n) => ({ name: n, text: read(isDir(target) ? join(target, n) : target) }));
  if (!files.length) { console.error(`no discovery documents in ${target}`); return 2; }
  const today = a.today || new Date().toISOString().slice(0, 10);
  return report(checkResearch(files), { stale: staleFacts(files, today, staleDays(root)) }, a.json, "check-research");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
