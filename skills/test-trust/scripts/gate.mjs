#!/usr/bin/env node
// Deterministic helpers for test-trust diff mode. No dependencies.
//   node gate.mjs thresholds [path-to-.agents/config.yaml] [run-dir]   prints repeat=, mutation_budget=, slow_ratio=
//     with a run dir, mutation_budget is never below the run's approved override or one mutant per PLAN "## Tests" criterion
//   node gate.mjs gate <path-to-findings.json>               prints PASS, or FAIL and the failing ids
//   node gate.mjs mutant <count-file> [config.yaml] [run-dir] the mutation budget as a cap: run it BEFORE every mutant. It counts the call in
//     <count-file> and prints `OK n/budget`, or `REFUSED n/budget` with exit 1 once the budget is spent (the count does not move): run no mutant then.
//     With a run dir the counter lives INSIDE it: a relative name that is not already below the run dir is taken relative to the run dir (never to the working directory, which
//     is the repository root: a counter there left an untracked `r7/` that made every gate stale, issue 338 B6), and a name outside the run dir or through a link is refused (exit 2).
//   node gate.mjs caps [config.yaml] [run-dir]   prints review_rounds= and review_minutes= (the plan's `## Test review budget`, else the config, else 4 and 120)
//   Cumulative results (A359, issue 338 C1). `mutant ... --file <source> --id <mutant-id>` first looks the pair (sha256 of the file's CURRENT bytes, mutant id) up in <count-file>.results:
//     a recorded pair prints `KNOWN <killed|survived> <unit>` (exit 0, the budget is NOT spent: a mutant of an unchanged file is never run again); a new pair spends the budget as above.
//     node gate.mjs mutant-record <count-file> <source> <id> <killed|survived> [--unit U] [--class base|new] [--round N] [--run-dir D]   records a result for the file's current hash
//     node gate.mjs mutant-summary <count-file> [--run-dir D]   prints per unit what was run, killed and survived, and the ADEQUACY line (what is closed; widening is labelled `new class`)
// Exit codes: 0 ok (gate: PASS), 1 gate FAIL or mutant REFUSED, 2 usage or read error.

import { appendFileSync, lstatSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const DEFAULTS = { repeat: 5, mutation_budget: 20, slow_ratio: 3 };
export const CAP_DEFAULTS = { review_rounds: 4, review_minutes: 120 };

// Flat YAML: a top-level `test_trust:` block with indented `key: scalar` lines.
// Invalid or missing values fall back to the default and are listed in `notes`.
export function thresholds(yamlText) {
  const out = { ...DEFAULTS };
  const notes = [];
  const raw = {};
  let inBlock = false;
  for (const line of String(yamlText ?? "").split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^test_trust:\s*(#.*)?$/.test(line)) { inBlock = true; continue; }
    if (!/^\s/.test(line)) { inBlock = false; continue; }
    if (!inBlock) continue;
    const m = /^\s+([a-z_]+):\s*([^#\s]*)\s*(#.*)?$/.exec(line);
    if (m) raw[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  const check = {
    repeat: (v) => /^\d+$/.test(v) && Number(v) >= 2,
    mutation_budget: (v) => /^\d+$/.test(v) && Number(v) >= 1,
    slow_ratio: (v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 1,
  };
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in raw) || raw[k] === "") continue;
    if (check[k](raw[k])) out[k] = Number(raw[k]);
    else notes.push(`test_trust.${k}=${raw[k]} is invalid; default ${DEFAULTS[k]} used`);
  }
  return { ...out, notes };
}

// The validator's floor for mutation_budget: one claim mutant per distinct AC of the PLAN "## Tests" section.
export function minMutants(planText) {
  const m = /^## Tests[^\n]*\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m.exec(String(planText ?? ""));
  // A172: criteria count by key (case-insensitive, leading zeros ignored), like validate-findings.mjs
  return new Set([...(m ? m[1] : "").matchAll(/^\s*[-*]\s+(AC-\d+):/gim)].map((x) => x[1].toUpperCase().replace(/-0+(?=\d)/g, "-"))).size;
}

// The plan's `## Test review budget` (A359; the same rules as control-plane/agents/scripts/core/testreviewbudget.mjs): lines `- rounds|minutes|mutants|units|lines: N`.
// The budget the plan needs is the largest of the criteria floor, `mutants`, units x 4 and lines / 25. The plan only REQUESTS it: a run raises the budget above the config value
// only through the user's `mutation_budget` approval, which the control plane applies (the run's `mutation_budget` file and its raise-budget ledger row).
export function reviewBudget(planText) {
  const v = { rounds: null, minutes: null, mutants: null, units: null, lines: null };
  let inside = false;
  for (const line of String(planText ?? "").split(/\r?\n/)) {
    if (line.startsWith("## ")) { inside = /^## Test review budget[ \t]*$/.test(line); continue; }
    if (!inside) continue;
    const m = /^[ \t]*[-*][ \t]*(rounds|minutes|mutants|units|lines):[ \t]*([0-9]+)[ \t]*$/.exec(line);
    if (m && v[m[1]] === null && Number(m[2]) >= 1 && Number(m[2]) <= 100000) v[m[1]] = Number(m[2]);
  }
  return v;
}
export const planMutantNeed = (planText) => {
  const b = reviewBudget(planText);
  return Math.max(minMutants(planText), b.mutants ?? 0, (b.units ?? 0) * 4, Math.ceil((b.lines ?? 0) / 25));
};

// Gate rule of diff mode: a confirmed flaky finding (any flaky_* kind), a confirmed hollow finding, and (issue 265, A276) a confirmed real wait, direct
// clock read, over-budget test or unmeasured test fail; everything else (slow, needs_validation, cleared) never does.
export const FAST_KINDS = ["real_wait", "clock_not_injected", "over_budget", "not_measured"];
export const isBlocking = (f) => f?.verdict === "confirmed" && (String(f.kind).startsWith("flaky_") || f.kind === "hollow" || FAST_KINDS.includes(f.kind));

export function computeGate(findings) {
  const failing = (findings ?? []).filter(isBlocking).map((f) => f.id);
  return { result: failing.length ? "FAIL" : "PASS", failing };
}

// The caps of the tests review loop (A359): the plan's `## Test review budget` `rounds` and `minutes`, else `test_trust.review_rounds` and `review_minutes` of the config, else 4 and 120.
export function reviewCaps(configPath, runDir) {
  const out = { ...CAP_DEFAULTS };
  let text = "";
  if (configPath) { try { text = readFileSync(resolve(configPath), "utf8"); } catch { /* absent config: defaults */ } }
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^test_trust:\s*(#.*)?$/.test(line)) { inBlock = true; continue; }
    if (!/^\s/.test(line)) { inBlock = false; continue; }
    const m = inBlock ? /^\s+(review_rounds|review_minutes):\s*"?'?(\d+)'?"?\s*(#.*)?$/.exec(line) : null;
    if (m && Number(m[2]) >= 1) out[m[1]] = Number(m[2]);
  }
  if (runDir) {
    let plan = "";
    try { plan = readFileSync(join(resolve(runDir), "PLAN.md"), "utf8"); } catch { /* no plan */ }
    const rb = reviewBudget(plan);
    if (rb.rounds !== null) out.review_rounds = rb.rounds;
    if (rb.minutes !== null) out.review_minutes = rb.minutes;
  }
  return out;
}

// The thresholds of a config file, with the run's floor for mutation_budget when a run directory is given.
export function effectiveThresholds(configPath, runDir) {
  let text = "";
  if (configPath) { try { text = readFileSync(resolve(configPath), "utf8"); } catch { /* absent config: defaults */ } }
  const t = thresholds(text);
  if (runDir) {
    const read = (f) => { try { return readFileSync(join(resolve(runDir), f), "utf8"); } catch { return ""; } };
    // the override counts only with the raise-budget ledger row that wrote it (as agent.sh mutation_budget)
    const ov = Number(read("mutation_budget").trim()) || 0;
    const ledgered = ov > 0 && new RegExp(`event=raise-budget .*test_trust\\.mutation_budget ${ov} for this run`).test(read("LEDGER.log"));
    const plan = read("PLAN.md");
    const floor = Math.max(minMutants(plan), ledgered ? ov : 0);
    const rb = reviewBudget(plan);
    if (floor > t.mutation_budget) { t.notes.push(`mutation_budget raised from ${t.mutation_budget} to ${floor} (one mutant per criterion, or the user-approved override)`); t.mutation_budget = floor; }
  }
  return t;
}

// The counter file. Outside a run (no run dir) it is the name given. With a run dir it must be inside it: a relative name is used as given when that is already below the run dir,
// else it is taken relative to the run dir; a name outside the run dir, or a link on the way below it, throws (exit 2, nothing written).
export function countFile(name, runDir) {
  if (!runDir) return resolve(name);
  const run = resolve(runDir);
  const inside = (f) => { const r = relative(run, f); return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
  let file = resolve(name);
  if (!isAbsolute(name) && !inside(file)) file = resolve(run, name);
  if (!inside(file)) throw new Error(`the count file ${name} must be inside the run folder ${runDir}`);
  for (let d = dirname(file); d !== run && inside(d); d = dirname(d)) {
    let st = null;
    try { st = lstatSync(d); } catch { /* not made yet */ }
    if (st?.isSymbolicLink()) throw new Error(`the count file ${name} is below a link (${d}): a counter is never written through a link`);
  }
  try { if (lstatSync(file).isSymbolicLink()) throw new Error(`the count file ${name} is a link`); } catch (e) { if (e instanceof Error && /is a link/.test(e.message)) throw e; }
  return file;
}

// ---- cumulative mutant results per file hash (A359) ----------------------------------------------------------------------------------
const fileHash = (p) => createHash("sha256").update(readFileSync(resolve(p))).digest("hex").slice(0, 16);
const resultsFile = (counter) => `${counter}.results`;
const readResults = (file) => {
  let t = "";
  try { t = readFileSync(file, "utf8"); } catch { /* none yet */ }
  return t.split("\n").filter(Boolean).map((l) => { const [hash, id, unit, result, cls, round] = l.split("\t"); return { hash, id, unit, result, cls, round }; });
};
const cleanField = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ").trim() || "-";

// The closing line of the loop: what is closed, what is not. A unit is closed when it ran at least one mutant and none survived; a mutant of class `new` widens the set between
// rounds and is never a new finding without that label. The closed tables (character classes, allowlists) and the audited equivalent-mutant arguments are the reviewer's statement.
export function summarize(rows) {
  const units = new Map();
  for (const r of rows) {
    const u = units.get(r.unit) ?? { killed: 0, survived: 0, newClass: 0, files: new Set() };
    u[r.result === "survived" ? "survived" : "killed"]++;
    if (r.cls === "new") u.newClass++;
    u.files.add(r.hash);
    units.set(r.unit, u);
  }
  const lines = [];
  for (const [unit, u] of [...units].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`unit ${unit}: ${u.killed + u.survived} run, ${u.killed} killed, ${u.survived} survived${u.newClass ? `, ${u.newClass} of class new` : ""}`);
  }
  const open = [...units].filter(([, u]) => u.survived > 0).map(([n]) => n).sort();
  const closed = [...units].filter(([, u]) => u.survived === 0).map(([n]) => n).sort();
  const nw = rows.filter((r) => r.cls === "new" && r.result === "survived").length;
  lines.push(`ADEQUACY: ${closed.length} unit(s) closed${closed.length ? ` (${closed.join(", ")})` : ""}; ${open.length} with survivors${open.length ? ` (${open.join(", ")})` : ""}; ${nw} survivor(s) found by widening the mutant set, labelled \`new class\`, not new findings`);
  return lines;
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return { value: null, rest: args };
  return { value: args[i + 1] ?? "", rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

function main(argv) {
  const [cmd, arg] = argv;
  try {
    if (cmd === "thresholds") {
      const t = effectiveThresholds(arg, argv[2]);
      console.log(`repeat=${t.repeat}\nmutation_budget=${t.mutation_budget}\nslow_ratio=${t.slow_ratio}`);
      for (const n of t.notes) console.error(`note: ${n}`);
      return 0;
    }
    if (cmd === "caps") {
      const c = reviewCaps(arg, argv[2]);
      console.log(`review_rounds=${c.review_rounds}\nreview_minutes=${c.review_minutes}`);
      return 0;
    }
    if (cmd === "mutant-record") {
      const f = flagValue(flagValue(flagValue(flagValue(argv.slice(1), "--unit").rest, "--class").rest, "--round").rest, "--run-dir");
      const unit = flagValue(argv.slice(1), "--unit").value, cls = flagValue(argv.slice(1), "--class").value, round = flagValue(argv.slice(1), "--round").value, run = f.value;
      const [counter, src, id, result] = f.rest;
      if (!counter || !src || !id || !["killed", "survived"].includes(result) || (cls !== null && !["base", "new"].includes(cls))) throw new Error("usage: mutant-record <count-file> <source> <id> <killed|survived> [--unit U] [--class base|new] [--round N] [--run-dir D]");
      const rf = resultsFile(countFile(counter, run));
      const hash = fileHash(src);
      const have = readResults(rf).find((r) => r.hash === hash && r.id === id);
      if (have) { console.log(`KNOWN ${have.result} ${have.unit}`); return 0; }
      mkdirSync(dirname(rf), { recursive: true });
      appendFileSync(rf, `${hash}\t${cleanField(id)}\t${cleanField(unit)}\t${result}\t${cls ?? "base"}\t${cleanField(round)}\n`);
      console.log(`RECORDED ${result} ${hash} ${id}`);
      return 0;
    }
    if (cmd === "mutant-summary") {
      const f = flagValue(argv.slice(1), "--run-dir");
      if (!f.rest[0]) throw new Error("usage: mutant-summary <count-file> [--run-dir D]");
      for (const l of summarize(readResults(resultsFile(countFile(f.rest[0], f.value))))) console.log(l);
      return 0;
    }
    if (cmd === "mutant" && argv.length >= 2) {
      const fFile = flagValue(argv.slice(1), "--file"), fId = flagValue(fFile.rest, "--id");
      const pos = fId.rest;
      if (pos.length < 1 || pos.length > 3 || (fFile.value === null) !== (fId.value === null)) throw new Error("usage: mutant <count-file> [config.yaml] [run-dir] [--file <source> --id <mutant-id>]");
      const [counter, cfg, run] = pos;
      if (fFile.value !== null) {
        const known = readResults(resultsFile(countFile(counter, run))).find((r) => r.hash === fileHash(fFile.value) && r.id === fId.value);
        if (known) { console.log(`KNOWN ${known.result} ${known.unit}: this file hash already ran this mutant, run no mutant and spend no budget`); return 0; }
      }
      const budget = effectiveThresholds(cfg, run).mutation_budget;
      const file = countFile(counter, run);
      let used = 0;
      try { used = Number(readFileSync(file, "utf8").trim()) || 0; } catch { /* first mutant */ }
      if (used >= budget) { console.log(`REFUSED ${used}/${budget}: the mutation budget is spent, run no more mutants (units left over go to not_examined with reason "mutation budget")`); return 1; }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${used + 1}\n`);
      console.log(`OK ${used + 1}/${budget}`);
      return 0;
    }
    if (cmd === "gate" && argv.length === 2) {
      const g = computeGate(JSON.parse(readFileSync(resolve(arg), "utf8")).findings);
      console.log(g.result === "PASS" ? "PASS" : `FAIL ${g.failing.join(" ")}`);
      return g.result === "PASS" ? 0 : 1;
    }
  } catch (e) {
    console.error(`Cannot read input: ${e.message}`);
    return 2;
  }
  console.error("Usage: node gate.mjs thresholds [config.yaml] [run-dir] | node gate.mjs caps [config.yaml] [run-dir] | node gate.mjs gate <findings.json> | node gate.mjs mutant <count-file> [config.yaml] [run-dir] [--file <source> --id <mutant-id>] | node gate.mjs mutant-record <count-file> <source> <id> <killed|survived> | node gate.mjs mutant-summary <count-file>");
  return 2;
}

// Compare real paths: the script is often reached through a symlinked skill folder.
const isCli = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isCli()) {
  process.exitCode = main(process.argv.slice(2));
}
