#!/usr/bin/env node
// Checks OPPORTUNITIES.md of one slug.
//   node check-opportunities.mjs <slug|dir|file> [--root DIR] [--json]
// Every `- OP-n <text>` links evidence: a C-n or INT-n id that exists in the slug's documents (a line `- C-n ` in any
// *.md, an `INT-n` named in INTERVIEWS.md), or an AS-n id (it must exist in ASSUMPTIONS.md when that file exists), or
// carries an `[assumption: <risk>]` marker. Every `- S-n <text>` names the OP-n it answers. Ids are unique. A
// ```mermaid block exists and lists every OP-n.
// `## Ranking` holds a reasoned order with no scores: `- R-n OP-m evidence: strong|medium|weak; users: <C-n|INT-n id, or
// estimate "<basis>">; fit: <how it serves the goal>; effort: small|medium|large; reason: <why here>`, best first, at least
// min(3, number of opportunities) lines, each OP-m once and defined (rules ranking-missing, ranking-size, ranking-field,
// ranking-level, ranking-users, ranking-duplicate, dangling-evidence). The choice stays the user's.
// A `[proposal: ...]` marker the user has not answered is pending-proposal; a malformed `## Rejected proposals` line is
// rejected-proposal.
// Exit 0 clean, 1 findings, 2 usage.
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { read, idLines, resolveTarget, isDir, mdFiles, parseArgs, report, stripComments, section, sectionItems } from "./lib.mjs";
import { rejectedProposals } from "./validate-product-claims.mjs";

export function mermaidBlocks(text) {
  return [...stripComments(text).matchAll(/^\s*```mermaid\s*$([\s\S]*?)^\s*```\s*$/gm)].map((m) => m[1]);
}

// ctx: { claims:Set of C-n ids, interviews:Set of INT-n ids, assumptions:Set|null of AS-n ids }
export function checkOpportunities(text, ctx, name = "OPPORTUNITIES.md") {
  const findings = [], ops = [], seen = new Set();
  const add = (l, rule, message) => findings.push({ file: name, line: l.line, id: l.id, rule, message });
  for (const l of idLines(text, "(?:OP|S)-\\d+")) {
    if (seen.has(l.id)) add(l, "duplicate-id", `${l.id} is defined twice`);
    seen.add(l.id);
    const body = l.text.replace(/^- \S+\s+/, "");
    if (l.id.startsWith("S-")) {
      if (!/\bOP-\d+\b/.test(body)) add(l, "solution-without-opportunity", `${l.id} names no OP-n it answers`);
      continue;
    }
    ops.push(l);
    const cs = body.match(/\bC-\d+\b/g) || [], ints = body.match(/\bINT-\d+\b/g) || [], ass = body.match(/\bAS-\d+\b/g) || [];
    const assumption = l.markers.some((m) => m.kind === "assumption" && !m.errors.length);
    for (const m of l.markers) if (m.errors.length) add(l, "invalid-marker", m.errors[0]);
    if (l.markers.some((m) => m.kind === "proposal")) add(l, "pending-proposal", "a proposal the user has not answered stays out of the document: accepted becomes `[assumption: <risk> source agent accepted by user]`, rejected goes under `## Rejected proposals`");
    if (!cs.length && !ints.length && !ass.length && !assumption) add(l, "no-evidence", `${l.id} links no evidence: name a C-n or INT-n id, an AS-n id, or mark it [assumption: value|usability|viability|feasibility]`);
    for (const c of cs) if (!ctx.claims.has(c)) add(l, "dangling-evidence", `${l.id} cites ${c}, which no document of the slug defines`);
    for (const n of ints) if (!ctx.interviews.has(n)) add(l, "dangling-evidence", `${l.id} cites ${n}, which INTERVIEWS.md does not name`);
    for (const s of ass) if (ctx.assumptions && !ctx.assumptions.has(s)) add(l, "dangling-evidence", `${l.id} cites ${s}, which ASSUMPTIONS.md does not define`);
  }
  const blocks = mermaidBlocks(text);
  if (!ops.length) findings.push({ file: name, line: 0, id: null, rule: "no-opportunities", message: "no `- OP-n` line found" });
  else if (!blocks.length) findings.push({ file: name, line: 0, id: null, rule: "no-diagram", message: "no ```mermaid block (the opportunity tree)" });
  else for (const o of ops) if (!blocks.some((b) => new RegExp(`(?<![A-Za-z0-9-])${o.id}(?![0-9])`).test(b))) findings.push({ file: name, line: o.line, id: o.id, rule: "not-in-diagram", message: `${o.id} is not listed in the mermaid block` });
  for (const e of rejectedProposals(text).errors) findings.push({ file: name, line: e.line, id: null, rule: "rejected-proposal", message: e.message });
  if (ops.length) checkRanking(text, ops, ctx, name, findings);
  return findings;
}

const LEVELS = { evidence: ["strong", "medium", "weak"], effort: ["small", "medium", "large"] };
const fieldOf = (body, k) => new RegExp(`(?:^|[\\s;])${k}:\\s*([^;]*[^;\\s])`, "i").exec(body)?.[1];
function checkRanking(text, ops, ctx, name, findings) {
  const add = (line, id, rule, message) => findings.push({ file: name, line, id, rule, message });
  const sec = section(text, "Ranking");
  const rows = sectionItems(sec, "R-\\d+");
  if (!rows.length) return add(sec?.[0]?.line ?? 1, null, "ranking-missing", "add `## Ranking`: a reasoned order of the opportunities, best first, with no scores (`- R-1 OP-n evidence: strong|medium|weak; users: ...; fit: ...; effort: small|medium|large; reason: ...`)");
  const defined = new Set(ops.map((o) => o.id)), seen = new Set();
  for (const r of rows) {
    const op = /^(OP-\d+)\b/.exec(r.body)?.[1];
    if (!op || !defined.has(op)) { add(r.line, r.id, "dangling-evidence", `${r.id} ranks ${op || "no OP-n"}, which OPPORTUNITIES.md does not define`); continue; }
    if (seen.has(op)) add(r.line, r.id, "ranking-duplicate", `${op} is ranked twice`);
    seen.add(op);
    for (const k of ["evidence", "users", "fit", "effort", "reason"]) if (!fieldOf(r.body, k)) add(r.line, r.id, "ranking-field", `${r.id} lacks "${k}:"`);
    for (const k of ["evidence", "effort"]) {
      const v = fieldOf(r.body, k)?.toLowerCase();
      if (v && !LEVELS[k].includes(v)) add(r.line, r.id, "ranking-level", `${k} "${v}" is not one of ${LEVELS[k].join("|")} (a level, never a number or score)`);
    }
    const u = fieldOf(r.body, "users");
    if (u) {
      const cited = [...(u.match(/\b(?:C|INT)-\d+\b/g) || [])];
      const ok = cited.some((c) => (c.startsWith("C-") ? ctx.claims : ctx.interviews).has(c));
      if (!ok && !/^estimate\s+"[^"]*\S+\s+\S+\s+\S+[^"]*"$/i.test(u)) add(r.line, r.id, "ranking-users", `${r.id}: "users:" names a C-n or INT-n that exists, or \`estimate "<basis of at least 3 words>"\``);
    }
  }
  const need = Math.min(3, ops.length);
  if (seen.size < need) add(sec[0]?.line ?? 1, null, "ranking-size", `rank at least ${need} opportunities (the top three, or all when there are fewer)`);
}

export function contextOf(dir) {
  const ctx = { claims: new Set(), interviews: new Set(), opportunities: new Set(), assumptions: null };
  for (const n of mdFiles(dir)) {
    const t = read(join(dir, n));
    for (const l of idLines(t, "C-\\d+")) ctx.claims.add(l.id);
    if (n === "OPPORTUNITIES.md") for (const l of idLines(t, "OP-\\d+")) ctx.opportunities.add(l.id);
    if (n === "INTERVIEWS.md") for (const m of stripComments(t).matchAll(/\bINT-\d+\b/g)) ctx.interviews.add(m[0]);
    if (n === "ASSUMPTIONS.md") ctx.assumptions = new Set(idLines(t, "AS-\\d+").map((l) => l.id));
  }
  return ctx;
}

function main(argv) {
  const a = parseArgs(argv, ["--root"], ["--json"]);
  if (a.bad || a._.length !== 1) { console.error("usage: check-opportunities.mjs <slug|dir|file> [--root DIR] [--json]"); return 2; }
  const root = resolve(a.root || ".");
  let file = resolveTarget(a._[0], root);
  if (isDir(file)) file = join(file, "OPPORTUNITIES.md");
  if (!existsSync(file)) { console.error(`not found: ${file}`); return 2; }
  const dir = join(file, "..");
  return report(checkOpportunities(read(file), contextOf(dir), basename(file)), {}, a.json, "check-opportunities");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
