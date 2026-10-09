import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const skill = join(dirname(fileURLToPath(import.meta.url)), "../../skills/debug-proof");
const script = join(skill, "scripts/validate-debug.mjs");
const { validate } = await import(script);

const good = () => ({
  schema_version: 1, kind: "bug", status: "fixed", symptom: "totals are off by one cent for 3 items",
  reproduction: { command: "node --test test/total.test.js", exit_code: 1, runs: 3, failures: 3, output_excerpt: "AssertionError: 10.01 !== 10.02" },
  hypotheses: [
    { id: "H1", rank: 1, statement: "src/total.js:sum rounds each line before adding", falsifier: "per-line rounding disabled still shows the cent error", status: "confirmed" },
    { id: "H2", rank: 2, statement: "src/tax.js:apply uses float division", falsifier: "integer cents in tax.js still fails", status: "refuted" },
  ],
  experiments: [
    { id: "E1", hypothesis: "H2", change: "tax.js integer cents (4 lines)", command: "node --test test/total.test.js", exit_code: 1, outcome: "still 10.01", result: "refutes", flips_failure: false, isolates_cause: true },
    { id: "E2", hypothesis: "H1", change: "sum rounds once at the end (2 lines), nothing else", command: "node --test test/total.test.js", exit_code: 0, outcome: "passes; reverting restores the failure", result: "confirms", flips_failure: true, isolates_cause: true },
  ],
  bisect: { good: "a1b2c3d", bad: "e4f5a6b", script: "/tmp/bisect.sh", first_bad_commit: "9c8d7e6", worktree: "/tmp/wt-bisect" },
  root_cause: { statement: "sum rounds per line, accumulating error (src/total.js:sum)", path: "src/total.js", hypothesis: "H1", proof_experiment: "E2" },
  fix: { paths: ["src/total.js"], summary: "round once after summing" },
  regression_test: { type: "test", path: "test/total.test.js", command: "node --test test/total.test.js", before: { exit_code: 1, output_excerpt: "AssertionError: 10.01 !== 10.02" }, after: { exit_code: 0 }, suite_exit_code: 0 },
});
const errs = (d, o = {}) => validate(d, o);
const has = (e, s) => assert.ok(e.some((x) => x.includes(s)), `expected "${s}" in ${JSON.stringify(e)}`);

test("accepts a fully proven fix", () => assert.deepEqual(errs(good(), { scope: ["src/total.js", "test/total.test.js"] }), []));
test("reproduction must fail and run at least twice", () => {
  const d = good(); d.reproduction.exit_code = 0; d.reproduction.runs = 1; d.reproduction.failures = 2;
  const e = errs(d); has(e, "must fail"); has(e, "at least twice"); has(e, "between 1 and runs");
});
test("reproduction is mandatory", () => {
  const d = good(); delete d.reproduction; has(errs(d), "missing");
});
test("needs 2+ hypotheses with falsifiers and unique ranks", () => {
  const d = good(); d.hypotheses = [d.hypotheses[0]]; has(errs(d), "at least 2");
  const e = good(); e.hypotheses[1].falsifier = ""; has(errs(e), "falsifier");
  const f = good(); f.hypotheses[1].rank = 1; has(errs(f), "duplicate rank");
});
test("experiments reference known hypotheses and have unique ids", () => {
  const d = good(); d.experiments[0].hypothesis = "H9"; has(errs(d), "unknown hypothesis");
  const e = good(); e.experiments[1].id = "E1"; has(errs(e), "duplicate id");
});
test("confirmed and refuted hypotheses need a matching experiment", () => {
  const d = good(); d.experiments[0].result = "inconclusive"; has(errs(d), "refuted without a refuting");
  const e = good(); e.experiments[1].result = "inconclusive"; has(errs(e), "confirmed without a confirming");
});
test("only one hypothesis may be confirmed", () => {
  const d = good(); d.hypotheses[1].status = "confirmed"; d.experiments[0].result = "confirms"; has(errs(d), "at most one");
});
test("the proof experiment must isolate the cause and flip the failure", () => {
  const d = good(); d.experiments[1].isolates_cause = false; d.experiments[1].flips_failure = false;
  const e = errs(d); has(e, "only the cause"); has(e, "flip the failure");
});
test("the proof experiment must test the root-cause hypothesis", () => {
  const d = good(); d.root_cause.proof_experiment = "E1"; const e = errs(d);
  has(e, "must test the root-cause hypothesis"); has(e, "must confirm");
});
test("root cause must reference the confirmed hypothesis", () => {
  const d = good(); d.root_cause.hypothesis = "H2"; has(errs(d), "confirmed hypothesis");
});
test("fixed without a regression test is rejected", () => {
  const d = good(); delete d.regression_test; has(errs(d), "never fixed without a regression test");
});
test("regression test must fail before, pass after, suite green", () => {
  const d = good(); d.regression_test.before.exit_code = 0; d.regression_test.after.exit_code = 1; d.regression_test.suite_exit_code = 1;
  const e = errs(d); has(e, "fail before"); has(e, "pass after"); has(e, "suite must exit 0");
});
test("regression test failing on a compile/import error is the wrong reason", () => {
  const d = good(); d.regression_test.before.output_excerpt = "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './total.js'";
  has(errs(d), "wrong reason");
});
test("build regression check is allowed only for build_error and skips the assertion check", () => {
  const d = good(); d.regression_test.type = "build"; has(errs(d), "only for kind build_error");
  d.kind = "build_error"; d.regression_test.before.output_excerpt = "error TS2339: Property 'x' does not exist"; assert.deepEqual(errs(d), []);
});
test("bisect must be complete and in a worktree", () => {
  const d = good(); d.bisect.first_bad_commit = "HEAD"; d.bisect.worktree = "wt"; const e = errs(d);
  has(e, "commit id"); has(e, "absolute path");
  const f = good(); f.bisect = null; assert.deepEqual(errs(f), []);
});
test("scope: fix and regression test outside scope rejected", () => {
  const e = errs(good(), { scope: ["src/other.js"] }); has(e, "$.fix.paths"); has(e, "$.regression_test.path");
});
test("unresolved: needs blocked_reason and next_experiment, forbids a claimed cause", () => {
  const d = good(); d.status = "unresolved"; const e = errs(d);
  has(e, "blocked_reason"); has(e, "next_experiment"); has(e, "$.root_cause"); has(e, "$.regression_test");
  for (const k of ["root_cause", "fix", "regression_test"]) delete d[k];
  d.blocked_reason = "cannot reproduce in prod data"; d.next_experiment = "replay the prod payload"; d.hypotheses.forEach((h) => (h.status = "open"));
  assert.deepEqual(errs(d), []);
});
test("fixed must not carry blocked_reason", () => {
  const d = good(); d.blocked_reason = "x"; has(errs(d), "must not carry");
});
test("path traversal in fix paths rejected", () => {
  const d = good(); d.fix.paths = ["../x"]; has(errs(d), "repo-relative");
});
test("unknown keys rejected", () => {
  const d = good(); d.extra = 1; has(errs(d), "unexpected");
});
test("CLI: reads .json and the fenced block of a .md result, exit codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "dbg-"));
  const j = join(dir, "d.json"), m = join(dir, "r.md");
  writeFileSync(j, JSON.stringify(good()));
  writeFileSync(m, `ROLE: implementer\n\n| id |\n\n\`\`\`json\n${JSON.stringify(good())}\n\`\`\`\n`);
  assert.equal(spawnSync("node", [script, j]).status, 0);
  assert.equal(spawnSync("node", [script, m, "--scope", "src/total.js,test/total.test.js"]).status, 0);
  const bad = good(); delete bad.regression_test; writeFileSync(j, JSON.stringify(bad));
  assert.equal(spawnSync("node", [script, j]).status, 1);
  writeFileSync(m, "no block here");
  assert.equal(spawnSync("node", [script, m]).status, 2);
  assert.equal(spawnSync("node", [script]).status, 2);
});
test("SKILL.md frontmatter and schema", () => {
  const t = readFileSync(join(skill, "SKILL.md"), "utf8");
  assert.match(t, /^---\nname: debug-proof\n/);
  assert.ok(t.split("\n").length < 500);
  JSON.parse(readFileSync(join(skill, "schema/debug.schema.json"), "utf8"));
});
