#!/usr/bin/env node
// Validates a design-sync report (SYNC.md) and recomputes its verdict. No dependencies.
//   node validate-sync.mjs SYNC.md [--json]
// Exit codes: 0 valid, 1 invalid, 2 usage or read error.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, "");

export function validateSync(text) {
  const errors = [];
  const body = strip(text);
  if (!/^# Design sync: \S+/m.test(body)) errors.push("H1 must be `# Design sync: <id>`");
  const verdicts = [...body.matchAll(/^Verdict: (\S+)\s*$/gm)].map((m) => m[1]);
  if (verdicts.length !== 1 || !["PASS", "FAIL", "SKIPPED"].includes(verdicts[0])) errors.push("exactly one `Verdict: PASS|FAIL|SKIPPED` line is required");
  const sec = (name) => { const m = new RegExp(`^## ${name}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(body); return m ? m[1].split("\n").map((l) => l.trim()).filter(Boolean) : null; };
  const drift = sec("Drift"), unv = sec("Unverifiable");
  if (!drift) errors.push('missing section "## Drift"');
  if (!unv) errors.push('missing section "## Unverifiable"');
  const lines = (drift || []).filter((l) => l !== "None.");
  for (const l of lines) if (!/^- \S.*:\d+ -> \S.+/.test(l)) errors.push(`drift line must be "- <doc>:<line> -> <missing code fact>": "${l.slice(0, 70)}"`);
  const computed = verdicts[0] === "SKIPPED" ? "SKIPPED" : lines.length ? "FAIL" : "PASS";
  if (verdicts.length === 1 && verdicts[0] !== computed) errors.push(`verdict ${verdicts[0]} contradicts the drift section (computed ${computed})`);
  if (/<[A-Za-z][A-Za-z -]*>|\bTBD\b/.test(body.replace(/^# Design sync:.*$/m, ""))) errors.push("unfilled placeholder remains");
  return { valid: errors.length === 0, errors, verdict: verdicts[0], computed, drift: lines.length };
}

function main(argv) {
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) { console.error("usage: validate-sync.mjs SYNC.md [--json]"); return 2; }
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); return 2; }
  const r = validateSync(text);
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2)); else r.errors.forEach((e) => console.error(`error: ${e}`));
  return r.valid ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
