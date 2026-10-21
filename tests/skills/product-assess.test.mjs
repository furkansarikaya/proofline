import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SKILL = fileURLToPath(new URL("../../skills/product-assess/", import.meta.url));
const { checkAssumptions } = await import(join(SKILL, "scripts/check-assumptions.mjs"));
const { checkProbes, lockProbe } = await import(join(SKILL, "scripts/check-probes.mjs"));
const { checkPremortem } = await import(join(SKILL, "scripts/check-premortem.mjs"));
const { checkDecision } = await import(join(SKILL, "scripts/check-decision.mjs"));
const { checkOutcome, meets } = await import(join(SKILL, "scripts/check-outcome.mjs"));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const rules = (r) => r.findings.map((f) => f.rule);
const tmp = () => mkdtempSync(join(tmpdir(), "product-assess-"));
const run = (script, ...args) => spawnSync("node", [join(SKILL, "scripts", script), ...args], { encoding: "utf8" });

test("assumptions: qualitative levels pass; a numeric score and a wrong riskiest mark are rejected", () => {
  const ok = [
    "- AS-1 Finance wants CSV. [assumption: value] importance: high; evidence: low; riskiest: yes",
    "- AS-2 We can build it in a week. [assumption: feasibility] importance: medium; evidence: medium",
  ].join("\n");
  const r = checkAssumptions(ok);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.riskiest, ["AS-1"]);
  assert.ok(rules(checkAssumptions("- AS-1 x [assumption: value] importance: 5; evidence: low")).includes("numeric-score"));
  assert.ok(rules(checkAssumptions("- AS-1 x [assumption: value] importance: high; evidence: low")).includes("riskiest"));
  assert.ok(rules(checkAssumptions("- AS-1 x [assumption: money] importance: low; evidence: low")).includes("risk-type"));
});

test("premortem: each risk is real, overstated or unspoken and has a response", () => {
  assert.deepEqual(checkPremortem("- RK-1 Nobody exports. kind: real; response: ask finance weekly\n").findings, []);
  assert.deepEqual(rules(checkPremortem("- RK-1 Nobody exports. kind: likely; response:\n")), ["kind", "response"]);
});

test("decision: ADR sections and exactly one effective decision in the enum", () => {
  const adr = (d) => `${d}\n\n## Context\n\nPB-1 confirmed AS-1.\n\n## Decision\n\nBuild it.\n\n## Consequences\n\nOne more export path.\n\n## Rejected\n\nA spreadsheet file.\n`;
  assert.deepEqual(checkDecision(adr("decision: build")).findings, []);
  assert.ok(rules(checkDecision(adr("decision: ship"))).includes("decision-enum"));
  assert.ok(rules(checkDecision(adr("decision: stop\ndecision: build"))).includes("one-decision"));
  assert.ok(rules(checkDecision("decision: build\n\n## Context\n\nAS-1\n")).includes("section"));
});

test("probes: a result without a lock is rejected; a threshold change after the result is rejected", () => {
  const dir = tmp(), file = join(dir, "PROBES.md");
  const probe = (extra = "", success = "at least 3 of 5 users export") =>
    `- PB-1 Offer CSV to five users, tests AS-1.\n  success: ${success}\n  failure: fewer than 2 of 5 users export\n${extra}`;
  writeFileSync(file, probe("  result: confirmed\n"));
  assert.ok(rules(checkProbes(readFileSync(file, "utf8"))).includes("no-lock"));
  writeFileSync(file, probe());
  assert.equal(lockProbe(file, "PB-1").ok, true);
  assert.equal(lockProbe(file, "PB-1").ok, false);
  writeFileSync(file, readFileSync(file, "utf8") + "  result: confirmed\n");
  assert.deepEqual(checkProbes(readFileSync(file, "utf8")).findings, []);
  writeFileSync(file, readFileSync(file, "utf8").replace("at least 3 of 5", "at least 2 of 5"));
  assert.ok(rules(checkProbes(readFileSync(file, "utf8"))).includes("threshold-changed"));
  const cli = run("check-probes.mjs", file);
  assert.equal(cli.status, 1);
  assert.equal(run("check-probes.mjs").status, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("probes: in git, the thresholds must equal the committed lock", () => {
  const dir = tmp(), file = join(dir, "PROBES.md"), g = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("init", "-q");
  writeFileSync(file, "- PB-1 Try it, tests AS-1.\n  success: 3 of 5\n  failure: 1 of 5\n");
  lockProbe(file, "PB-1");
  g("add", "PROBES.md");
  g("-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-qm", "lock");
  assert.deepEqual(checkProbes(readFileSync(file, "utf8"), { file }).findings, []);
  // threshold moved and the lock re-written to match: only the committed lock exposes it
  const moved = readFileSync(file, "utf8").replace("3 of 5", "2 of 5").replace(/sha256:[0-9a-f]{64}/, `sha256:${sha("success: 2 of 5\nfailure: 1 of 5")}`);
  writeFileSync(file, moved);
  assert.ok(rules(checkProbes(moved, { file })).includes("threshold-changed-since-commit"));
  rmSync(dir, { recursive: true, force: true });
});

// a project root with docs/product/shop/{PRD.md,OUTCOME.md,outcome/OC-1.out} and scripts/adoption.mjs printing "value: 47"
function outcomeProject({ value = "47", result = "reached", out = "value: 47\n" } = {}) {
  const root = tmp(), dir = join(root, "docs/product/shop");
  mkdirSync(join(dir, "outcome"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  const script = 'console.log("value: 47");\n';
  writeFileSync(join(root, "scripts/adoption.mjs"), script);
  writeFileSync(join(dir, "PRD.md"), "# Shop\n\n## Success metrics\n\n- M-1: Share of orders exported. baseline: 12\n");
  writeFileSync(join(dir, "outcome/OC-1.out"), out);
  const doc = [
    "- OC-1 Export share after launch, follows DEC-1 and FR-1.",
    "  metric: M-1", "  baseline: 12", "  target: >= 40",
    `  script: scripts/adoption.mjs sha256:${sha(script)}`,
    `  output: outcome/OC-1.out sha256:${sha("value: 47\n")}`,
    `  value: ${value}`, `  result: ${result}`, "  follow-up: continue", "",
  ].join("\n");
  writeFileSync(join(dir, "OUTCOME.md"), doc);
  return { root, dir, doc };
}

test("outcome: a recorded value equal to the script output passes; a number that does not match is rejected", () => {
  const good = outcomeProject();
  assert.deepEqual(checkOutcome(good.doc, { root: good.root, dir: good.dir }).findings, []);
  assert.equal(run("check-outcome.mjs", "shop", "--root", good.root).status, 0);
  assert.equal(run("check-outcome.mjs", "shop", "--root", good.root, "--rerun").status, 0);
  rmSync(good.root, { recursive: true, force: true });
  const bad = outcomeProject({ value: "52" });
  assert.ok(rules(checkOutcome(bad.doc, { root: bad.root, dir: bad.dir })).includes("value-mismatch"));
  assert.equal(run("check-outcome.mjs", "shop", "--root", bad.root).status, 1);
  rmSync(bad.root, { recursive: true, force: true });
});

test("outcome: reached must follow from value and target; an edited output file is rejected", () => {
  const p = outcomeProject({ result: "not-reached" });
  assert.ok(rules(checkOutcome(p.doc, { root: p.root, dir: p.dir })).includes("result-follows"));
  writeFileSync(join(p.dir, "outcome/OC-1.out"), "value: 99\n");
  assert.ok(rules(checkOutcome(p.doc, { root: p.root, dir: p.dir })).includes("output-hash"));
  assert.equal(meets("47", ">= 40"), true);
  assert.equal(meets("3", ">= 40"), false);
  rmSync(p.root, { recursive: true, force: true });
});

test("outcome: --rerun does not execute a script whose hash changed", () => {
  const p = outcomeProject();
  const marker = join(p.root, "ran.txt");
  writeFileSync(join(p.root, "scripts/adoption.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x"); console.log("value: 47");\n`);
  const r = run("check-outcome.mjs", "shop", "--root", p.root, "--rerun", "--json");
  assert.equal(r.status, 1);
  assert.ok(JSON.parse(r.stdout).findings.some((f) => f.rule === "script-hash"));
  assert.equal(existsSync(marker), false);
  rmSync(p.root, { recursive: true, force: true });
});
