#!/usr/bin/env node
// Checks OPPORTUNITIES.md of one slug.
//   node check-opportunities.mjs <slug|dir|file> [--root DIR] [--json]
// Every `- OP-n <text>` links evidence: a C-n or INT-n id that exists in the slug's documents (a line `- C-n ` in any
// *.md, an `INT-n` named in INTERVIEWS.md), or an AS-n id (it must exist in ASSUMPTIONS.md when that file exists), or
// carries an `[assumption: <risk>]` marker. Every `- S-n <text>` names the OP-n it answers. Ids are unique. A
// ```mermaid block exists and lists every OP-n.
// Exit 0 clean, 1 findings, 2 usage.
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { read, idLines, resolveTarget, isDir, mdFiles, parseArgs, report, stripComments } from "./lib.mjs";

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
    if (!cs.length && !ints.length && !ass.length && !assumption) add(l, "no-evidence", `${l.id} links no evidence: name a C-n or INT-n id, an AS-n id, or mark it [assumption: value|usability|viability|feasibility]`);
    for (const c of cs) if (!ctx.claims.has(c)) add(l, "dangling-evidence", `${l.id} cites ${c}, which no document of the slug defines`);
    for (const n of ints) if (!ctx.interviews.has(n)) add(l, "dangling-evidence", `${l.id} cites ${n}, which INTERVIEWS.md does not name`);
    for (const s of ass) if (ctx.assumptions && !ctx.assumptions.has(s)) add(l, "dangling-evidence", `${l.id} cites ${s}, which ASSUMPTIONS.md does not define`);
  }
  const blocks = mermaidBlocks(text);
  if (!ops.length) findings.push({ file: name, line: 0, id: null, rule: "no-opportunities", message: "no `- OP-n` line found" });
  else if (!blocks.length) findings.push({ file: name, line: 0, id: null, rule: "no-diagram", message: "no ```mermaid block (the opportunity tree)" });
  else for (const o of ops) if (!blocks.some((b) => new RegExp(`(?<![A-Za-z0-9-])${o.id}(?![0-9])`).test(b))) findings.push({ file: name, line: o.line, id: o.id, rule: "not-in-diagram", message: `${o.id} is not listed in the mermaid block` });
  return findings;
}

export function contextOf(dir) {
  const ctx = { claims: new Set(), interviews: new Set(), assumptions: null };
  for (const n of mdFiles(dir)) {
    const t = read(join(dir, n));
    for (const l of idLines(t, "C-\\d+")) ctx.claims.add(l.id);
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
