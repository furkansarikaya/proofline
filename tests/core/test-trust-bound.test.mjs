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

test("the counter is the plain budget cap; results are not in this script (they are the control plane's, A359)", () => {
  const { run, cfg, src, count } = setup();
  assert.equal(gate("mutant", count, cfg, run).out, "OK 1/3");
  assert.equal(gate("mutant", count, cfg, run, "--file", src, "--id", "m1").code, 2, "no per-file results here");
  assert.equal(gate("mutant-record", count, src, "m1", "killed").code, 2);
  assert.equal(gate("mutant-summary", count).code, 2);
});

test("a counter outside the run folder is refused, and thresholds report the plan's rounds without raising the budget", () => {
  const { run, cfg, src } = setup();
  assert.equal(gate("mutant", join(run, "..", "..", "evil.count"), cfg, run).code, 2);
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
