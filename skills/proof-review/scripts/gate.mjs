#!/usr/bin/env node
// Deterministic gate computation for proof-review inside a proofline run. No dependencies.
//   node gate.mjs <path-to-findings.json>    prints PASS, or FAIL and the failing ids
// Exit codes: 0 PASS, 1 FAIL, 2 usage or read error.

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Series a focus may not report (each belongs to another focus's gate).
export const FORBIDDEN_BY_FOCUS = {
  plan: ["rules", "bugs"],
  rules: ["claims", "unrequested", "plan_deviations", "bugs"],
  bugs: ["claims", "unrequested", "plan_deviations", "rules"],
  "rules+bugs": ["claims", "unrequested", "plan_deviations"],
  "rules+tests": ["claims", "unrequested", "plan_deviations"],
  all: [],
  // The risk focus `config` (A88) reports its own measured items (scripts/check-config.mjs); a findings.json
  // for it carries suspicions only.
  config: ["claims", "rules", "unrequested", "plan_deviations", "bugs"],
};
export const FOCUSES = Object.keys(FORBIDDEN_BY_FOCUS);
// Inside a run the output folder (run-relative) and the result header FOCUS per focus. The lead's
// REVIEW_RULES gate runs focus rules+bugs and its result header says FOCUS: rules.
export const RUN_DIR = { plan: "plan", rules: "rules", "rules+bugs": "rules", bugs: "rules", all: "rules", "rules+tests": "small", config: "config" };
export const HEADER_FOCUS = { "rules+bugs": "rules" };

// Gate rule: a missing or partial claim, a reproduced or traced bug that is still open, a
// project rule violation, or a plan deviation (new dependency, versioned contract change not
// named in the plan) fails, and so does an unrequested record marked blocking (A153: a hunk inside the
// scope that changes behaviour and ties to no criterion). Suspicions, other unrequested changes and done
// claims never do.
export function computeGate(doc) {
  const failing = [
    ...(doc.claims ?? []).filter((c) => c.status === "partial" || c.status === "missing").map((c) => c.id),
    ...(doc.rules ?? []).map((r) => r.id),
    ...(doc.plan_deviations ?? []).map((p) => p.id),
    ...(doc.unrequested ?? []).filter((u) => u.blocking === true).map((u) => u.id),
    ...(doc.bugs ?? []).filter((b) => b.status !== "fixed").map((b) => b.id),
  ].sort();
  return { result: failing.length ? "FAIL" : "PASS", failing };
}

function main(argv) {
  if (argv.length !== 1) {
    console.error("Usage: node gate.mjs <path-to-findings.json>");
    return 2;
  }
  let doc;
  try { doc = JSON.parse(readFileSync(resolve(argv[0]), "utf8")); } catch (e) {
    console.error(`Cannot read input: ${e.message}`);
    return 2;
  }
  const g = computeGate(doc);
  console.log(g.result === "PASS" ? "PASS" : `FAIL ${g.failing.join(" ")}`);
  return g.result === "PASS" ? 0 : 1;
}

// Compare real paths: the script is often reached through a symlinked skill folder.
const isCli = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isCli()) {
  process.exitCode = main(process.argv.slice(2));
}
