#!/usr/bin/env node
// ASSUMPTIONS.md check. Line: `- AS-n <text> [assumption: <risk>] importance: high|medium|low; evidence: high|medium|low[; riskiest: yes]`.
// Four risk types, qualitative importance and evidence only (a number or a score is rejected), and `riskiest: yes`
// exactly on the assumptions with importance high and evidence low. Read-only.
// The agent contributes: at least MIN_AGENT (5) assumptions beyond what the user said, each `source agent accepted by user`
// in its marker (`[assumption: value source agent accepted by user]`) or listed as rejected under `## Rejected proposals`
// (rule min-proposals). A number in the statement is an estimate with a basis: `[assumption: value estimate "<basis>"]`
// (rule unsourced-number). A `[proposal: ...]` the user has not answered is pending-proposal.
//   node check-assumptions.mjs <ASSUMPTIONS.md|slug> [--json] [--root DIR]    exit 0 clean, 1 findings, 2 usage
import { MARKER, parseMarker, rejectedProposals } from "./validate-product-claims.mjs";
import { LEVELS, cli, field, isMain, items, read, report, resolveDoc } from "./lib.mjs";

const KEYS = ["importance", "evidence", "riskiest"];
export const MIN_AGENT = 5;
// Numbers of a statement, without ids (C-3, AS-1), dates and digits glued to letters (OAuth2, S3).
const numbersIn = (t) => t.replace(/\d{4}-\d{2}-\d{2}/g, " ").replace(/\b[A-Za-z]{1,4}-\d+\b/g, " ").match(/(?<![A-Za-z\d])\d+(?:[.,]\d+)*(?![A-Za-z])/g) || [];
export function checkAssumptions(text, { minAgent = MIN_AGENT } = {}) {
  const findings = [], seen = new Set(), list = items(text, "AS");
  let agent = 0;
  const add = (it, rule, message) => findings.push({ rule, line: it.line, id: it.id, message });
  if (!list.length) findings.push({ rule: "no-assumption", line: 0, message: "no `- AS-n` line" });
  for (const it of list) {
    if (seen.has(it.id)) add(it, "duplicate-id", `${it.id} is defined twice`);
    seen.add(it.id);
    const marks = [...it.head.matchAll(MARKER)];
    if (marks.some((m) => m[1].toLowerCase() === "proposal")) add(it, "pending-proposal", "a proposal the user has not answered stays out of the document: accepted becomes `source agent accepted by user`, rejected goes under `## Rejected proposals`");
    if (marks.length !== 1 || marks[0][1].toLowerCase() !== "assumption") add(it, "marker", "an assumption carries exactly one [assumption: <risk>] marker");
    else {
      const pm = parseMarker("assumption", marks[0][2]);
      for (const e of pm.errors) add(it, "risk-type", e);
      if (pm.origin === "agent" && !pm.errors.length) agent++;
      const statement = it.head.slice(0, marks[0].index);
      if (numbersIn(statement).length && !(pm.estimate && !pm.errors.length)) add(it, "unsourced-number", "the statement holds a number: mark the assumption as an estimate with a basis (`[assumption: value estimate \"<basis>\"]`) or take the number out");
    }
    const v = {};
    for (const k of ["importance", "evidence"]) {
      v[k] = field(it, k, KEYS)?.toLowerCase() ?? null;
      if (v[k] === null) add(it, "missing-field", `${k}: high|medium|low is missing`);
      else if (/\d/.test(v[k])) add(it, "numeric-score", `${k} "${v[k]}" is a number; use ${LEVELS.join("|")}, never a score`);
      else if (!LEVELS.includes(v[k])) add(it, "bad-level", `${k} "${v[k]}" is not one of ${LEVELS.join("|")}`);
    }
    if (/\b(score|rank|points?|priority)\s*[:=]\s*\d|\b\d+\s*\/\s*(5|10|100)\b/i.test(it.lines.join(" "))) add(it, "numeric-score", "a numeric score or rank is not allowed");
    const risky = field(it, "riskiest", KEYS)?.toLowerCase() ?? null;
    const should = v.importance === "high" && v.evidence === "low";
    if (risky !== null && !["yes", "no"].includes(risky)) add(it, "bad-riskiest", `riskiest "${risky}" is not yes|no`);
    else if (risky === "yes" && !should) add(it, "riskiest", "riskiest: yes needs importance high and evidence low");
    else if (risky !== "yes" && should) add(it, "riskiest", "importance high and evidence low: mark `riskiest: yes`");
  }
  const rp = rejectedProposals(text);
  for (const e of rp.errors) findings.push({ rule: "rejected-proposal", line: e.line, message: e.message });
  if (list.length && agent + rp.items.length < minAgent) findings.push({ rule: "min-proposals", line: 0, message: `the agent proposes at least ${minAgent} assumptions the user did not state (accepted: \`source agent accepted by user\`; rejected: under \`## Rejected proposals\`); found ${agent} accepted and ${rp.items.length} rejected` });
  return { findings, proposals: { accepted: agent, rejected: rp.items.length }, riskiest: list.filter((it) => field(it, "riskiest", KEYS)?.toLowerCase() === "yes").map((it) => it.id), count: list.length };
}

function main(argv) {
  const c = cli(argv, "check-assumptions.mjs <ASSUMPTIONS.md|slug> [--json] [--root DIR]", ["--root"]);
  if (!c) return 2;
  const file = resolveDoc(c.args[0], "ASSUMPTIONS.md", c.root), text = read(file);
  if (text === null) { console.error(`cannot read ${file}`); return 2; }
  const r = checkAssumptions(text);
  return report(file, r.findings, { riskiest: r.riskiest, count: r.count, proposals: r.proposals }, c.flags["--json"]);
}
if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
