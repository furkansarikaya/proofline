#!/usr/bin/env node
// Checks the "so what?" of the discovery documents of one slug.
//   node check-insights.mjs <slug|dir> [--root DIR] [--json]
// RESEARCH.md, INTERVIEWS.md, COMPETITORS.md and OPPORTUNITIES.md (each one that exists) end with `## So what` holding 3 to
// 7 insights:
//   - IN-n <observation> evidence: C-1, INT-2, OP-3; so what: <what it means for the decision named in FRAME.md>
// An insight rests on ids that exist in the slug's documents and says what it means for the decision. Rules: no-insights
// (a document of the set has no `## So what` or no `IN-n` line, so the set has none), too-few-insights, too-many-insights,
// insight-without-evidence, dangling-evidence, insight-without-implication, duplicate-id, pending-proposal.
// A `## So what` heading is also accepted as `## So what?`. Exit 0 clean, 1 findings, 2 usage.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { read, resolveTarget, isDir, parseArgs, report, section, sectionItems } from "./lib.mjs";
import { contextOf } from "./check-opportunities.mjs";

export const DOCS = ["RESEARCH.md", "INTERVIEWS.md", "COMPETITORS.md", "OPPORTUNITIES.md"];
const field = (body, k, next) => new RegExp(`(?:^|[\\s;])${k}:\\s*(.*?)\\s*(?=;\\s*(?:${next}):|$)`, "i").exec(body)?.[1];

// docs: [{ name, text }]; ctx from contextOf (ids that exist). Returns the findings.
export function checkInsights(docs, ctx) {
  const findings = [], seen = new Map();
  if (!docs.length) return [{ file: "", line: 0, id: null, rule: "no-insights", message: "the slug has no discovery document to end with insights" }];
  for (const { name, text } of docs) {
    const add = (line, id, rule, message) => findings.push({ file: name, line, id, rule, message });
    const sec = section(text, "So what") || section(text, "So what?");
    const rows = sectionItems(sec, "IN-\\d+");
    if (!rows.length) { add(sec?.[0]?.line ?? 1, null, "no-insights", `${name} ends with \`## So what\`: 3 to 7 insights (\`- IN-n <observation> evidence: C-1, INT-2; so what: <meaning for the decision of FRAME.md>\`)`); continue; }
    if (rows.length < 3) add(rows[0].line, null, "too-few-insights", `${name} has ${rows.length} insight(s); 3 to 7 are asked`);
    if (rows.length > 7) add(rows[7].line, null, "too-many-insights", `${name} has ${rows.length} insights; keep the 3 to 7 that matter`);
    for (const r of rows) {
      if (seen.has(r.id)) add(r.line, r.id, "duplicate-id", `${r.id} is already defined in ${seen.get(r.id)}`);
      seen.set(r.id, name);
      if (/\[proposal\b/i.test(r.body)) add(r.line, r.id, "pending-proposal", "a proposal the user has not answered stays out of the document");
      const ev = field(r.body, "evidence", "so what"), sw = field(r.body, "so what", "evidence");
      const ids = (ev || "").match(/\b(?:C|INT|OP|AS)-\d+\b/g) || [];
      if (!ids.length) add(r.line, r.id, "insight-without-evidence", `${r.id} names no evidence id (\`evidence: C-1, INT-2\`)`);
      for (const i of ids) {
        const known = i.startsWith("C-") ? ctx.claims.has(i) : i.startsWith("INT-") ? ctx.interviews.has(i) : i.startsWith("OP-") ? ctx.opportunities.has(i) : !ctx.assumptions || ctx.assumptions.has(i);
        if (!known) add(r.line, r.id, "dangling-evidence", `${r.id} cites ${i}, which no document of the slug defines`);
      }
      if (!sw || sw.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length < 4) add(r.line, r.id, "insight-without-implication", `${r.id} says no meaning for the decision (\`so what: <at least 4 words: what changes in the decision>\`)`);
      const obs = r.body.replace(/(?:^|[\s;])(evidence|so what):.*$/i, "").trim();
      if (obs.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length < 3) add(r.line, r.id, "insight-without-observation", `${r.id} states no observation before \`evidence:\``);
    }
  }
  return findings;
}

function main(argv) {
  const a = parseArgs(argv, ["--root"], ["--json"]);
  if (a.bad || a._.length !== 1) { console.error("usage: check-insights.mjs <slug|dir> [--root DIR] [--json]"); return 2; }
  const dir = resolveTarget(a._[0], resolve(a.root || "."));
  if (!existsSync(dir) || !isDir(dir)) { console.error(`not a folder: ${dir}`); return 2; }
  const docs = DOCS.filter((n) => existsSync(join(dir, n))).map((n) => ({ name: n, text: read(join(dir, n)) }));
  const ctx = contextOf(dir);
  return report(checkInsights(docs, ctx), {}, a.json, "check-insights");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
