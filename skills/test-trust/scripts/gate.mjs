#!/usr/bin/env node
// Deterministic helpers for test-trust diff mode. No dependencies.
//   node gate.mjs thresholds [path-to-.agents/config.yaml] [run-dir]   prints repeat=, mutation_budget=, slow_ratio=
//     with a run dir, mutation_budget is never below the run's approved override or one mutant per PLAN "## Tests" criterion
//   node gate.mjs gate <path-to-findings.json>               prints PASS, or FAIL and the failing ids
// Exit codes: 0 ok (gate: PASS), 1 gate FAIL, 2 usage or read error.

import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULTS = { repeat: 5, mutation_budget: 20, slow_ratio: 3 };

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
  return new Set([...(m ? m[1] : "").matchAll(/^\s*[-*]\s+(AC-\d+):/gm)].map((x) => x[1])).size;
}

// Gate rule of diff mode: a confirmed flaky finding (any flaky_* kind) or a confirmed
// hollow finding fails; everything else (slow, needs_validation, cleared) never does.
export const isBlocking = (f) => f?.verdict === "confirmed" && (String(f.kind).startsWith("flaky_") || f.kind === "hollow");

export function computeGate(findings) {
  const failing = (findings ?? []).filter(isBlocking).map((f) => f.id);
  return { result: failing.length ? "FAIL" : "PASS", failing };
}

function main(argv) {
  const [cmd, arg] = argv;
  try {
    if (cmd === "thresholds") {
      let text = "";
      if (arg) { try { text = readFileSync(resolve(arg), "utf8"); } catch { /* absent config: defaults */ } }
      const t = thresholds(text);
      const dir = argv[2];
      if (dir) {
        const read = (f) => { try { return readFileSync(join(resolve(dir), f), "utf8"); } catch { return ""; } };
        // the override counts only with the raise-budget ledger row that wrote it (as agent.sh mutation_budget)
        const ov = Number(read("mutation_budget").trim()) || 0;
        const ledgered = ov > 0 && new RegExp(`event=raise-budget .*test_trust\\.mutation_budget ${ov} for this run`).test(read("LEDGER.log"));
        const floor = Math.max(minMutants(read("PLAN.md")), ledgered ? ov : 0);
        if (floor > t.mutation_budget) { console.error(`note: mutation_budget raised from ${t.mutation_budget} to ${floor} (one mutant per criterion, or the user-approved override)`); t.mutation_budget = floor; }
      }
      console.log(`repeat=${t.repeat}\nmutation_budget=${t.mutation_budget}\nslow_ratio=${t.slow_ratio}`);
      for (const n of t.notes) console.error(`note: ${n}`);
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
  console.error("Usage: node gate.mjs thresholds [config.yaml] [run-dir] | node gate.mjs gate <findings.json>");
  return 2;
}

// Compare real paths: the script is often reached through a symlinked skill folder.
const isCli = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isCli()) {
  process.exitCode = main(process.argv.slice(2));
}
