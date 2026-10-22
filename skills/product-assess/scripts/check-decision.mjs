#!/usr/bin/env node
// DECISION.md check: the four ADR sections (Context, Decision, Consequences, Rejected) are present and not empty,
// exactly one effective `decision: build|clarify|stop` line exists (the last such line wins, as in check-prd --ready;
// an earlier line with another value is a finding so the file never disagrees with itself), the value is in the enum,
// and the file names an AS-n or PB-n (the evidence trace needs it). Read-only.
//   node check-decision.mjs <DECISION.md|slug> [--json] [--root DIR]    exit 0 clean, 1 findings, 2 usage
import { cli, isMain, read, report, resolveDoc } from "./lib.mjs";

export const DECISIONS = ["build", "clarify", "stop"];
export const SECTIONS = ["Context", "Decision", "Consequences", "Rejected"];
export function checkDecision(text) {
  const findings = [], lines = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, "")).split(/\r?\n/);
  const decl = lines.map((l, i) => ({ m: /^decision:[ \t]*(.*?)[ \t]*$/i.exec(l), line: i + 1 })).filter((x) => x.m);
  if (!decl.length) findings.push({ rule: "no-decision", line: 0, message: "no `decision: build|clarify|stop` line" });
  const last = decl[decl.length - 1];
  for (const d of decl) if (!DECISIONS.includes(d.m[1].toLowerCase())) findings.push({ rule: "decision-enum", line: d.line, message: `decision "${d.m[1]}" is not one of ${DECISIONS.join("|")}` });
  for (const d of decl.slice(0, -1)) findings.push({ rule: "one-decision", line: d.line, message: `more than one \`decision:\` line; line ${last.line} is the effective one, remove this one` });
  const heads = [];
  lines.forEach((l, i) => { const h = /^##\s+(.+?)\s*$/.exec(l); if (h) heads.push({ name: h[1], at: i }); });
  for (const s of SECTIONS) {
    const k = heads.findIndex((h) => h.name.toLowerCase() === s.toLowerCase());
    if (k < 0) { findings.push({ rule: "section", line: 0, message: `section "## ${s}" is missing` }); continue; }
    const end = k + 1 < heads.length ? heads[k + 1].at : lines.length;
    if (!lines.slice(heads[k].at + 1, end).some((l) => /\p{L}/u.test(l) && !/^decision:/i.test(l))) findings.push({ rule: "section-empty", line: heads[k].at + 1, message: `section "## ${s}" is empty` });
  }
  if (!/(?<![A-Za-z0-9-])(AS|PB)-\d+/.test(lines.join("\n"))) findings.push({ rule: "no-evidence", line: 0, message: "the decision names no AS-n or PB-n (the evidence it rests on)" });
  return { findings, decision: last ? last.m[1].toLowerCase() : null };
}

function main(argv) {
  const c = cli(argv, "check-decision.mjs <DECISION.md|slug> [--json] [--root DIR]", ["--root"]);
  if (!c) return 2;
  const file = resolveDoc(c.args[0], "DECISION.md", c.root), text = read(file);
  if (text === null) { console.error(`cannot read ${file}`); return 2; }
  const r = checkDecision(text);
  return report(file, r.findings, { decision: r.decision }, c.flags["--json"]);
}
if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
