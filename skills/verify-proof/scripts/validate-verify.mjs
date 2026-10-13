#!/usr/bin/env node
// Validates VERIFY.md and recomputes the mechanical verdict. No dependencies.
//   node validate-verify.mjs VERIFY.md [--task TASK.md] [--plan PLAN.md] [--json]
// Exit codes: 0 valid, 1 invalid, 2 usage or read error.
//
// Format:
//   # Verification: <ID>
//   ## Commands            - `cmd` | exit=N [| base_exit=M]     (indented `output:` line below)
//   ## AC coverage         | AC | test or command | status | evidence |     status PASS|FAIL|MISSING
//   ## Scope               verify-scope: exit=N
//   ## Design sync         design-sync: PASS|FAIL|SKIPPED (reason)
//   ## Pre-existing failures   None | one line per command that failed at head AND base
//   ## Failures            None | findings (each entry fails the gate: dependency, contract, design drift)
//   Verdict: PASS|FAIL|BLOCKED          (last non-empty line)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontMatter } from "../../plan-contract/scripts/validate-plan.mjs";

const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, "");
const PLACEHOLDER = /(<[A-Za-z][A-Za-z -]*>|\bTBD\b|\bTODO\b|\?\?\?)/;

function sections(text) {
  const out = new Map();
  let cur = null;
  for (const line of strip(text).split(/\r?\n/)) {
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) { cur = m[1]; out.set(cur, []); continue; }
    if (cur) out.get(cur).push(line);
  }
  return out;
}

// The frozen PLAN `## UI` line `visual_proof: AC-1, AC-3` (or `none`) written by ui-design (A81).
export function visualProofIds(planText) {
  let inUi = false;
  for (const line of strip(planText).split(/\r?\n/)) {
    if (/^## /.test(line)) { inUi = /^## UI\s*$/.test(line); continue; }
    const m = inUi && /^\s*(?:[-*]\s+)?`?visual_proof:\s*([^`]*)`?\s*$/.exec(line);
    if (m) return /^none$/i.test(m[1].trim()) ? [] : m[1].split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

export function validateVerify(text, taskText, planText) {
  const errors = [], reasons = [];
  const body = strip(text);
  const secs = sections(text);
  if (!/^# Verification: \S+/m.test(body)) errors.push("H1 must be `# Verification: <TASK-ID>`");
  for (const n of ["Commands", "AC coverage", "Scope", "Design sync", "Pre-existing failures", "Failures"]) if (!secs.has(n)) errors.push(`missing section "## ${n}"`);

  // commands
  const cmds = [];
  let lastCommand;
  for (const line of secs.get("Commands") || []) {
    const m = /^- `([^`]+)` \| exit=(\d+)(?: \| base_exit=(\d+))?\s*$/.exec(line);
    if (m) { lastCommand = { cmd: m[1], exit: Number(m[2]), base: m[3] === undefined ? undefined : Number(m[3]), outputs: [] }; cmds.push(lastCommand); }
    else if (/^  output: \S/.test(line) && lastCommand) lastCommand.outputs.push(line.slice("  output: ".length));
    else if (/^- /.test(line)) errors.push(`malformed command line "${line.slice(0, 70)}" (expected "- \`cmd\` | exit=N[ | base_exit=M]")`);
  }
  if (secs.has("Commands") && !cmds.length) errors.push("no command lines under ## Commands");
  const preExisting = (c) => c.exit !== 0 && c.base !== undefined && c.base !== 0;
  const pre = (secs.get("Pre-existing failures") || []).join("\n");
  for (const c of cmds) {
    if (c.exit !== 0 && !preExisting(c)) reasons.push(`command failed: ${c.cmd}`);
    if (preExisting(c) && !pre.includes(c.cmd)) errors.push(`pre-existing failure of \`${c.cmd}\` is not listed under ## Pre-existing failures`);
    if (c.exit === 0 && c.base !== undefined) errors.push(`\`${c.cmd}\` passes at head; base_exit is only recorded for failing commands`);
  }

  // AC coverage
  const rows = [];
  const plan = planText === undefined ? null : parseFrontMatter(planText);
  if (plan?.errors.length) errors.push(`invalid PLAN front matter: ${plan.errors.join("; ")}`);
  const visual = planText === undefined ? [] : visualProofIds(planText);
  for (const line of secs.get("AC coverage") || []) {
    if (!/^\|/.test(line) || /^\|\s*-/.test(line) || /^\|\s*AC\s*\|/i.test(line)) continue;
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    if (c.length < 4 || !/^AC-\d+$/.test(c[0]) || !["PASS", "FAIL", "MISSING"].includes(c[2])) { errors.push(`malformed AC coverage row "${line.slice(0, 70)}"`); continue; }
    if (c[2] === "PASS" && (!c[1] || !c[3])) errors.push(`${c[0]}: PASS needs a test reference or verification command and evidence`);
    if (c[2] === "PASS" && c[1].startsWith("command: ")) {
      const mapped = plan?.scope.filter((s) => s.criteria?.includes(c[0])) || [];
      if (!mapped.length || !mapped.every((s) => s.tdd_exemption)) errors.push(`${c[0]}: command proof requires tdd_exemption on every mapped PLAN scope path`);
      const match = /^command: `([^`]+)`$/.exec(c[1]);
      const command = match && cmds.find((x) => x.cmd === match[1] && x.exit === 0);
      if (!command || !c[3].includes(`\`${match?.[1]}\` exit=0`) || !command.outputs.length || !command.outputs.some((output) => output.trim() && c[3].includes(output))) errors.push(`${c[0]}: command proof needs a recorded passing exact command, exit=0, and its demonstrating output line`);
    }
    // A82: a criterion on the PLAN `## UI` line `visual_proof:` needs visual evidence besides its test.
    if (c[2] === "PASS" && visual.includes(c[0]) && !new RegExp(`visual-proof: ${c[0]} proven\\b`).test(c[3])) errors.push(`${c[0]}: marked visual_proof in PLAN.md; PASS needs the visual evidence \`visual-proof: ${c[0]} proven\` (otherwise MISSING)`);
    rows.push({ ac: c[0], status: c[2] });
    if (c[2] !== "PASS") reasons.push(`${c[0]} ${c[2]}`);
  }
  if (taskText) {
    const acs = [...strip(taskText).matchAll(/^(?:[-*]\s+)?(AC-\d+):/gm)].map((m) => m[1]);
    for (const a of acs) if (!rows.some((r) => r.ac === a)) errors.push(`${a} has no row in ## AC coverage`);
  } else if (secs.has("AC coverage") && !rows.length) errors.push("## AC coverage has no rows");

  // scope
  const scope = /^verify-scope: exit=(\d+)\s*$/m.exec((secs.get("Scope") || []).join("\n"));
  if (secs.has("Scope")) {
    if (!scope) errors.push("## Scope needs `verify-scope: exit=N`");
    else if (scope[1] !== "0") reasons.push("verify-scope failed");
  }
  // design sync
  const ds = /^design-sync: (PASS|FAIL|SKIPPED)(?: \((.+)\))?\s*$/m.exec((secs.get("Design sync") || []).join("\n"));
  if (secs.has("Design sync")) {
    if (!ds) errors.push("## Design sync needs `design-sync: PASS|FAIL|SKIPPED (reason)`");
    else if (ds[1] === "SKIPPED" && !ds[2]) errors.push("design-sync SKIPPED needs a reason in parentheses");
    else if (ds[1] === "FAIL") reasons.push("design-sync drift");
  }

  // failures: every entry under ## Failures (undeclared dependency, versioned-contract change,
  // design-sync drift, ...) fails the gate; only an empty section or `None` does not.
  for (const line of secs.get("Failures") || []) {
    const t = line.trim();
    if (!t || /^Verdict:/.test(t) || /^BLOCKED:/.test(t) || /^none\.?$/i.test(t) || /^\|[\s|:-]*$/.test(t) || /^\|\s*(id|check|finding)\s*\|/i.test(t)) continue;
    reasons.push(`failure listed: ${t.replace(/^[-*]\s+/, "").slice(0, 80)}`);
  }

  // verdict
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  const verdictLines = lines.filter((l) => /^Verdict:/.test(l));
  const last = lines[lines.length - 1] || "";
  const vm = /^Verdict: (PASS|FAIL|BLOCKED)$/.exec(last);
  if (verdictLines.length !== 1 || !vm) errors.push("the file must end with exactly one `Verdict: PASS|FAIL|BLOCKED` line");
  const computed = reasons.length ? "FAIL" : "PASS";
  if (vm && vm[1] !== "BLOCKED" && vm[1] !== computed) errors.push(`verdict ${vm[1]} contradicts the evidence (computed ${computed}: ${reasons.join("; ") || "no failures"})`);
  if (vm && vm[1] === "BLOCKED" && !/^BLOCKED: \S/m.test(body)) errors.push("Verdict: BLOCKED needs a `BLOCKED: <reason>` line");
  if (PLACEHOLDER.test(body.replace(/^# Verification:.*$/m, ""))) errors.push("unfilled placeholder remains");
  return { valid: errors.length === 0, errors, verdict: vm?.[1], computed, reasons };
}

function main(argv) {
  const file = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--task");
  const read = (p) => { try { return readFileSync(p, "utf8"); } catch (e) { console.error(`cannot read ${p}: ${e.message}`); process.exit(2); } };
  if (!file) { console.error("usage: validate-verify.mjs VERIFY.md [--task TASK.md] [--plan PLAN.md] [--json]"); return 2; }
  const ti = argv.indexOf("--task");
  const pi = argv.indexOf("--plan");
  const r = validateVerify(read(file), ti >= 0 ? read(argv[ti + 1]) : undefined, pi >= 0 ? read(argv[pi + 1]) : undefined);
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2)); else r.errors.forEach((e) => console.error(`error: ${e}`));
  return r.valid ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
