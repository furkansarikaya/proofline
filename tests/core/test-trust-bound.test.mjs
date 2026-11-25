// A359 (issue 338 C1): the mutation results of the test review survive per FILE HASH across rounds, a unit is reported whole, and the loop closes with an adequacy line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tempDir } from "../lib/tempdir.mjs";

const GATE = new URL("../../skills/test-trust/scripts/gate.mjs", import.meta.url).pathname;
const gate = (...args) => { const r = spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8" }); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }; };

/** a run folder with a plan and a budget of 3 mutants (config), and a source file. */
function setup() {
  const d = tempDir("tt-bound");
  const run = join(d, "run"); mkdirSync(join(run, "reviews"), { recursive: true });
  writeFileSync(join(run, "PLAN.md"), "## Tests\n- AC-1: a\n");
  const cfg = join(d, "config.yaml"); writeFileSync(cfg, "test_trust:\n  mutation_budget: 3\n");
  const src = join(d, "price.js"); writeFileSync(src, "export const price = (n) => n * 2;\n");
  return { d, run, cfg, src, count: "reviews/mutants.count" };
}

test("a mutant of an unchanged file hash is known: it spends no budget, in any later round", () => {
  const { run, cfg, src, count } = setup();
  assert.equal(gate("mutant", count, cfg, run, "--file", src, "--id", "m1").out, "OK 1/3");
  assert.match(gate("mutant-record", count, src, "m1", "survived", "--unit", "price", "--run-dir", run).out, /^RECORDED survived /);
  // round 2, same file bytes: known, nothing spent
  const again = gate("mutant", count, cfg, run, "--file", src, "--id", "m1");
  assert.equal(again.code, 0); assert.match(again.out, /^KNOWN survived price/);
  assert.equal(readFileSync(join(run, count), "utf8").trim(), "1", "the counter did not move");
  // a new mutant of the same file spends
  assert.equal(gate("mutant", count, cfg, run, "--file", src, "--id", "m2").out, "OK 2/3");
});

test("a changed file has a new hash: its results are not carried over", () => {
  const { run, cfg, src, count } = setup();
  gate("mutant", count, cfg, run, "--file", src, "--id", "m1"); gate("mutant-record", count, src, "m1", "killed", "--unit", "price", "--run-dir", run);
  writeFileSync(src, "export const price = (n) => n * 3;\n");
  assert.match(gate("mutant", count, cfg, run, "--file", src, "--id", "m1").out, /^OK 2\/3/);
});

test("the cap still refuses once the budget is spent, and a known mutant is answered even then (no new run, no false FAIL or PASS)", () => {
  const { run, cfg, src, count } = setup();
  for (const id of ["a", "b", "c"]) { assert.match(gate("mutant", count, cfg, run, "--file", src, "--id", id).out, /^OK/); gate("mutant-record", count, src, id, "killed", "--unit", "u", "--run-dir", run); }
  const r = gate("mutant", count, cfg, run, "--file", src, "--id", "d");
  assert.equal(r.code, 1); assert.match(r.out, /^REFUSED 3\/3/);
  assert.match(gate("mutant", count, cfg, run, "--file", src, "--id", "a").out, /^KNOWN killed/);
});

test("the old form is unchanged, and --file needs --id", () => {
  const { run, cfg, count } = setup();
  assert.equal(gate("mutant", count, cfg, run).out, "OK 1/3");
  assert.equal(gate("mutant", count, cfg, run, "--file", "x").code, 2);
});

test("the summary lists a unit whole and ends with the adequacy line; widening is labelled new class", () => {
  const { run, src, count } = setup();
  const rec = (id, res, unit, cls) => gate("mutant-record", count, src, id, res, "--unit", unit, "--class", cls, "--run-dir", run);
  rec("m1", "killed", "price", "base"); rec("m2", "killed", "price", "base"); rec("m3", "survived", "tax", "base"); rec("m4", "survived", "tax", "new"); rec("m5", "killed", "cls", "new");
  assert.match(rec("m5", "killed", "cls", "new").out, /^KNOWN/, "a pair is recorded once");
  const s = gate("mutant-summary", count, "--run-dir", run).out.split("\n");
  assert.ok(s.includes("unit price: 2 run, 2 killed, 0 survived"));
  assert.ok(s.includes("unit tax: 2 run, 0 killed, 2 survived, 1 of class new"));
  assert.match(s.at(-1), /^ADEQUACY: 2 unit\(s\) closed \(cls, price\); 1 with survivors \(tax\); 1 survivor\(s\) found by widening the mutant set, labelled `new class`/);
});

test("a counter or result file outside the run folder is refused, and thresholds report the plan's rounds without raising the budget", () => {
  const { run, cfg, src } = setup();
  assert.equal(gate("mutant", join(run, "..", "..", "evil.count"), cfg, run, "--file", src, "--id", "x").code, 2);
  writeFileSync(join(run, "PLAN.md"), "## Tests\n- AC-1: a\n\n## Test review budget\n- rounds: 7\n- minutes: 45\n- units: 50\n");
  const t = Object.fromEntries(gate("thresholds", cfg, run).out.split("\n").map((l) => l.split("=")));
  assert.deepEqual(Object.keys(t), ["repeat", "mutation_budget", "slow_ratio"], "thresholds keeps its recorded shape");
  const c = Object.fromEntries(gate("caps", cfg, run).out.split("\n").map((l) => l.split("=")));
  assert.deepEqual(c, { review_rounds: "7", review_minutes: "45" });
  assert.deepEqual(Object.fromEntries(gate("caps").out.split("\n").map((l) => l.split("="))), { review_rounds: "4", review_minutes: "120" });
  assert.equal(t.mutation_budget, "3", "a plan field requests a budget; only the user's approval raises it");
});

test("plan-contract validates the plan's Test review budget", async () => {
  const { testReviewBudgetProblems } = await import("../../skills/plan-contract/scripts/validate-plan.mjs");
  assert.deepEqual(testReviewBudgetProblems(["- rounds: 3", "- minutes: 90", "- units: 12", ""]), []);
  assert.equal(testReviewBudgetProblems(["- rounds: 0", "- speed: 2", "- units: 1", "- units: 2"]).length, 3);
});
