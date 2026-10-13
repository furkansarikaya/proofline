// Known-answer test for the benchmark (A90): planted fixtures with exact expected counts. No model, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = join(dirname(fileURLToPath(import.meta.url)), "benchmark.mjs");
const { build, parseExpected, toMarkdown } = await import(script);

const root = mkdtempSync(join(tmpdir(), "bench-"));
const fx = join(root, "fixtures");
const put = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
// alpha: 3 expected (numbered), 2 traps (table); beta: prose only (not measurable); gamma: bullets, no verdict.
put(join(fx, "alpha/EXPECTED.md"), `# Expected: alpha

## MUST find

1. First finding.
2. Second finding.
3. Third finding.

## MUST NOT report (decoys)

| id | decoy |
|---|---|
| N1 | the decoy function |
| N2 | the comment that gives orders |
`);
put(join(fx, "beta/EXPECTED.md"), "# beta\n\n## Notes\n\nThe skill should do something sensible.\n");
put(join(fx, "gamma/EXPECTED.md"), "# gamma\n\n## Process expectations\n\n- **P1** One question per message.\n");

const verdicts = {
  // found 1 and 3 -> 2 is missed; tripped N2 and one extra finding -> 2 false positives; one change outside scope.
  alpha: { evaluator: "planted", found: ["1", "3"], tripped: ["N2"], extra: ["invented bug in util.js"], planned_scope: ["src/a.js", "docs/"], changed_paths: ["src/a.js", "docs/x.md", "src/b.js"], duration_s: 90, tokens_total: 1234 },
};

test("parser takes numbered, table and bold-id items by section and guesses nothing else", () => {
  const items = parseExpected("## MUST\n\n1. a\n2. b\n\n## MUST NOT\n\n| X1 | c |\n\n## Other\n\n1. ignored\n");
  assert.deepEqual(items.map((i) => `${i.kind}:${i.id}`), ["expect:1", "expect:2", "trap:X1"]);
});

test("structured fallback (A94): traps, planted facts and must-hold sections give positional ids; prose alone stays unmeasurable", () => {
  const md = "# x\n\n## Scenario\n\n- a build step that is not a fact\n\n## Planted facts\n\n| Where | Kind |\n|---|---|\n| a.js:1 | exact |\n| b.js:2 | textual |\n\nTraps, none of which may be a reference:\n\n- c.js declares its own\n- d.js is a comment\n\n## Must hold\n\n- no database is touched\n";
  const items = parseExpected(md);
  assert.deepEqual(items.map((i) => `${i.kind}:${i.id}`), ["expect:F1", "expect:F2", "trap:T1", "trap:T2", "expect:F3"]);
  assert.deepEqual(parseExpected("# beta\n\n## Notes\n\nThe skill should do something sensible.\n- a bullet in a plain section\n"), []);
  // an id-keyed file keeps its ids; the fallback never runs on it
  assert.deepEqual(parseExpected("## MUST\n\n1. a\n\n## Traps\n\n- t\n").map((i) => i.id), ["1"]);
  for (const name of ["contract-proof", "impact-map", "insights", "migration-validation"]) {
    const real = parseExpected(readFileSync(join(dirname(script), "../../fixtures", name, "EXPECTED.md"), "utf8"));
    assert.ok(real.some((i) => i.kind === "expect") && real.some((i) => i.kind === "trap" || name === "migration-validation"), name);
  }
});

test("planted miss and planted false positive are counted exactly", () => {
  const r = build({ fixturesDir: fx, verdicts });
  const a = r.fixtures.find((f) => f.skill === "alpha");
  assert.equal(a.status, "measured");
  assert.deepEqual([a.expected, a.traps, a.found, a.missed, a.false_positives], [3, 2, 2, 1, 2]);
  assert.deepEqual(a.missed_ids, ["2"]);
  assert.deepEqual(a.tripped_ids, ["N2"]);
  assert.deepEqual(a.scope.out_of_scope, ["src/b.js"]);
  assert.equal(a.scope.adherence, 1 - 1 / 3);
  assert.equal(a.duration_s, 90);
  assert.equal(r.fixtures.find((f) => f.skill === "beta").status, "not measurable");
  assert.equal(r.fixtures.find((f) => f.skill === "gamma").status, "not scored");
  assert.deepEqual(r.totals, { measured: 1, not_scored: 1, not_measurable: 1, expected: 3, found: 2, missed: 1, false_positives: 2, validators_failed: 0 });
  assert.match(toMarkdown(r), /\| alpha \| measured \| 3 \| 2 \| 2 \| 1 \| 2 \|/);
});

test("a verdict id that is not in EXPECTED.md is an error, not a guess", () => {
  assert.throws(() => build({ fixturesDir: fx, verdicts: { alpha: { evaluator: "x", found: ["9"] } } }), /not an expected finding/);
  assert.throws(() => build({ fixturesDir: fx, verdicts: { alpha: { evaluator: "x", tripped: ["1"] } } }), /not a trap/);
  assert.throws(() => build({ fixturesDir: fx, verdicts: { alpha: { found: ["1"] } } }), /needs an "evaluator"/);
  // per-id evidence is an alternative to "evaluator"; an empty verdict is not scored
  assert.equal(build({ fixturesDir: fx, verdicts: { alpha: { found: ["1"], evidence: { 1: "out/DESIGN.md:12" } } } }).fixtures[0].status, "measured");
  assert.equal(build({ fixturesDir: fx, verdicts: { alpha: {} } }).fixtures[0].status, "not scored");
  assert.throws(() => build({ fixturesDir: fx, verdicts: { nope: {} } }), /unknown fixture/);
});

test("e2e run dir: evaluator table, scope from PLAN.md, tokens n/a when none recorded", () => {
  const run = join(root, "runs/STANDARD-claude-1");
  const out = join(run, "out");
  put(join(out, "summary.txt"), "lead_1_duration=100\nlead_2_duration=20\nscenario=STANDARD\nconfig=claude\n");
  put(join(out, "runs/T-1/PLAN.md"), "---\nscope:\n  - path: src/a.js\n    criteria: [AC-1]\n---\n# Plan\n");
  put(join(out, "git-diff-main-head.patch"), "diff --git a/src/a.js b/src/a.js\n+x\ndiff --git a/src/z.js b/src/z.js\n+y\ndiff --git a/.agents/x b/.agents/x\n");
  put(join(out, "git-untracked.txt"), "");
  put(join(out, "evaluation.md"), "| item | met/unmet | evidence |\n|---|---|---|\n| C-1 | met | x |\n| C-2 | unmet | y |\n| C-3 | not-applicable | z |\n| S-1 | met | w |\n\nE2E: FAIL (2/3)\n");
  const e = build({ fixturesDir: fx, e2eDirs: [join(root, "runs")] }).e2e;
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].scenario, e[0].status, e[0].verdict, e[0].found, e[0].missed, e[0].not_applicable], ["STANDARD", "measured", "FAIL", 2, 1, 1]);
  assert.deepEqual(e[0].scope.out_of_scope, ["src/z.js"]);
  assert.equal(e[0].duration_s, 120);
  assert.equal(e[0].tokens_total, null);
});

test("cli writes benchmark.md and benchmark.json", () => {
  put(join(root, "v.json"), JSON.stringify(verdicts));
  const o = join(root, "o");
  const r = spawnSync(process.execPath, [script, "--fixtures", fx, "--verdicts", join(root, "v.json"), "--out", o], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(o, "benchmark.json"), "utf8")).totals.missed, 1);
  assert.match(readFileSync(join(o, "benchmark.md"), "utf8"), /# Benchmark report/);
});
