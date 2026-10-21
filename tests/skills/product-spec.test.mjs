import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SKILL = fileURLToPath(new URL("../../skills/product-spec/", import.meta.url));
const FIX = fileURLToPath(new URL("../../fixtures/product-spec/orders-export/", import.meta.url));
const { validateClaims } = await import(join(SKILL, "scripts/validate-product-claims.mjs"));
const { checkPrd, readiness } = await import(join(SKILL, "scripts/check-prd.mjs"));
const { coverage } = await import(join(SKILL, "scripts/check-coverage.mjs"));
const { trace } = await import(join(SKILL, "scripts/trace.mjs"));
const PRD = readFileSync(join(FIX, "PRD.md"), "utf8");

// a project root with docs/product/orders-export/{PRD,REVIEW}.md and one task covering FR-1 and NFR-1
function project({ prd = PRD } = {}) {
  const root = mkdtempSync(join(tmpdir(), "product-spec-"));
  const dir = join(root, "docs/product/orders-export");
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIX, "REVIEW.md"), join(dir, "REVIEW.md"));
  writeFileSync(join(dir, "PRD.md"), prd);
  mkdirSync(join(root, ".agents/tasks/todo"), { recursive: true });
  writeFileSync(join(root, ".agents/tasks/todo/TASK-1.md"), [
    "# Task: TASK-1 - Export CSV", "", "---", "prd: orders-export", "", "---", "", "## Acceptance criteria", "",
    "- AC-1: Clicking Export CSV downloads one row per order of the month.", "  Covers: FR-1, NFR-1", "",
  ].join("\n"));
  return { root, prd: join(dir, "PRD.md") };
}

test("the fixture PRD is clean, its claims valid, and it is ready to split", () => {
  const r = checkPrd(PRD);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.prd.requirements, ["FR-1", "FR-2", "NFR-1"]);
  assert.equal(validateClaims(PRD, { sections: ["Problem", "Assumptions"] }).unmarked.length, 0);
  const { root, prd } = project();
  assert.equal(readiness(prd).ready, true);
  rmSync(root, { recursive: true, force: true });
});

test("a fact without a source is rejected; an unmarked claim is only reported", () => {
  for (const m of ["[fact]", "[fact: web https://example.org/a]", "[fact: interview \"no id\"]", "[fact: data `q.sql`]"]) {
    const r = validateClaims(`## Problem\n\nExports are slow. ${m}\n`);
    assert.equal(r.valid, false, m);
  }
  assert.match(validateClaims("## Assumptions\n\n- A-1: x [assumption: cost]\n").errors[0].message, /risk type/);
  const u = validateClaims("## Problem\n\nExports are slow.\n");
  assert.equal(u.valid, true);
  assert.equal(u.unmarked.length, 1);
});

test("an acceptance criterion with an unmeasurable word is caught (English, Turkish, config)", () => {
  const rules = (t, o) => checkPrd(t, o).findings.filter((f) => f.rule === "vague-word").map((f) => f.message).join("\n");
  assert.match(rules(PRD.replace("downloads a file with", "quickly downloads a file with")), /AC-1 .*"quickly"/);
  assert.match(rules(PRD.replace("downloads a file that", "hızlı bir şekilde downloads a file that")), /AC-2 .*"hızlı"/);
  assert.equal(rules(PRD.replace("downloads a file with", "snappily downloads a file with")), "");
  assert.match(rules(PRD.replace("downloads a file with", "snappily downloads a file with"), { vagueWords: ["snappily"] }), /snappily/);
  const { root, prd } = project({ prd: PRD.replace("downloads a file with", "snappily downloads a file with") });
  writeFileSync(join(root, ".agents/config.yaml"), "product:\n  dir: docs/product\n  vague_words: snappily, anında\n");
  const cli = spawnSync("node", [join(SKILL, "scripts/check-prd.mjs"), "orders-export", "--root", root, "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stdout).findings[0].rule, "vague-word");
  rmSync(root, { recursive: true, force: true });
});

test("empty non-goals, a metric without its method and a requirement without an id are findings", () => {
  const bad = PRD.replace("- Scheduled or emailed exports.\n- File formats other than CSV.\n", "- none\n")
    .replace("; source: product analytics", "").replace("- FR-2: The file", "- The file");
  const rules = checkPrd(bad).findings.map((f) => f.rule);
  for (const r of ["empty-non-goals", "metric-method", "requirement-id"]) assert.ok(rules.includes(r), `${r} in ${rules}`);
});

test("a PRD with a blocking open question is not splittable; do-not-ship blocks too", () => {
  const { root, prd } = project({ prd: PRD.replace("### Blocking\n\n- none", "### Blocking\n\n- Q-2: Which months may finance export?") });
  const r = readiness(prd);
  assert.equal(r.ready, false);
  assert.match(r.reasons.join("\n"), /blocking open question .*Q-2/);
  const cli = spawnSync("node", [join(SKILL, "scripts/check-prd.mjs"), "--ready", "orders-export", "--root", root], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  writeFileSync(prd, PRD);
  writeFileSync(join(root, "docs/product/orders-export/REVIEW.md"), "verdict: do-not-ship\n");
  assert.match(readiness(prd).reasons.join("\n"), /do-not-ship/);
  rmSync(root, { recursive: true, force: true });
});

test("an uncovered FR is caught by the coverage check; a deferred one with a reason is not", () => {
  const { root, prd } = project();
  const r = coverage(prd, [join(root, ".agents/tasks")]);
  assert.equal(r.complete, false);
  assert.deepEqual(r.gaps, ["FR-2"]);
  writeFileSync(prd, `${PRD}\n## Deferred\n\n- FR-2: column set waits for Q-1\n`);
  assert.equal(coverage(prd, [join(root, ".agents/tasks")]).complete, true);
  rmSync(root, { recursive: true, force: true });
});

test("trace shows a broken link and the full chain from records on disk, writing nothing", () => {
  const { root } = project();
  const files = () => spawnSync("find", [root, "-type", "f"], { encoding: "utf8" }).stdout.split("\n").sort().join("\n");
  const before = files();
  const broken = trace("FR-1", { root });
  assert.equal(broken.complete, false);
  assert.match(broken.missing.join("\n"), /TASK-1 AC-1: no test linked/);
  assert.match(broken.missing.join("\n"), /TASK-1: no PR recorded/);
  assert.match(trace("FR-2", { root }).missing.join("\n"), /FR-2 .*no task linked/);
  const run = join(root, ".agents/runs/TASK-1");
  mkdirSync(join(run, "worker-evidence"), { recursive: true });
  writeFileSync(join(run, "PLAN.md"), "## Tests\n\n- AC-1: `test/export.test.mjs` \"exports the month\"\n");
  writeFileSync(join(run, "worker-evidence/GREEN-1.yaml"), 'task_id: "TASK-1"\nphase: "GREEN"\nresult: "pass"\ncommand: node --test test/export.test.mjs\ntarget: src/export.mjs,test/export.test.mjs\ntimestamp: "2026-10-21T10:00:00Z"\n');
  mkdirSync(join(root, ".agents/local/deliver/TASK-1"), { recursive: true });
  writeFileSync(join(root, ".agents/local/deliver/TASK-1/PR"), "42\n");
  const full = trace("TASK-1", { root });
  assert.deepEqual(full.missing, [], full.missing.join("\n"));
  assert.equal(full.task.criteria[0].tests[0].evidence[0].phase, "GREEN");
  assert.equal(full.task.pr.pr, "42");
  const withRecords = files();
  const cli = spawnSync("node", [join(SKILL, "scripts/trace.mjs"), "FR-1", "--root", root], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /test: test\/export.test.mjs/);
  assert.equal(files(), withRecords);
  assert.notEqual(before, withRecords);
  assert.equal(readdirSync(join(root, ".agents/local")).join(), "deliver");
  rmSync(root, { recursive: true, force: true });
});

test("unknowns: TBD in capitals or a whole-value unknown is flagged, the word inside a sentence is not", () => {
  const rules = (t) => checkPrd(t).findings.filter((f) => f.rule === "unknown-as-fact").length;
  assert.equal(rules(PRD.replace("- FR-2: The file", "- FR-3: Orders with an unknown currency are skipped.\n- FR-2: The file")), 0);
  assert.equal(rules(PRD.replace("- FR-2: The file", "- FR-3: unknown\n- FR-2: The file")), 1);
  assert.equal(rules(PRD.replace("- FR-2: The file", "- FR-3: Columns TBD\n- FR-2: The file")), 1);
  assert.equal(rules(PRD.replace("- FR-2: The file", "- FR-3: a tbd-free note\n- FR-2: The file")), 0);
});

test("requirements are checked for unmeasurable words; a real HTML tag is no placeholder", () => {
  const f = checkPrd(PRD.replace("completes within 5 seconds on the production server", "is fast and easy")).findings;
  assert.ok(f.some((x) => x.rule === "vague-word" && /NFR-1/.test(x.message)), JSON.stringify(f));
  assert.equal(checkPrd(PRD.replace("## Goals\n", "## Goals\n\n<table><tr><td>x</td></tr></table>\n")).findings.filter((x) => x.rule === "placeholder").length, 0);
  assert.equal(checkPrd(PRD.replace("## Goals\n", "## Goals\n\n<the goal>\n")).findings.filter((x) => x.rule === "placeholder").length, 1);
});

test("trace of a delivered task reads the done/ file, the delivery commit and the merge commit, with no false missing link", () => {
  const { root } = project();
  const g = (...a) => { const r = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-q", "-m", "init");
  g("checkout", "-q", "-b", "proofline/TASK-1-export");
  mkdirSync(join(root, "test")); writeFileSync(join(root, "test/export.test.mjs"), "// test\n");
  mkdirSync(join(root, ".agents/tasks/done"));
  const task = readFileSync(join(root, ".agents/tasks/todo/TASK-1.md"), "utf8");
  rmSync(join(root, ".agents/tasks/todo/TASK-1.md"));
  writeFileSync(join(root, ".agents/tasks/done/TASK-1.md"), `${task}\n## Completion Report\n\n<!-- COMPLETION-REPORT:BEGIN:TASK-1 -->\n# Completion Report: TASK-1\n\n## TDD Evidence\n\n- test/export.test.mjs: RED fail, GREEN pass\n<!-- COMPLETION-REPORT:END:TASK-1 -->\n`);
  g("add", "-A"); g("commit", "-q", "-m", "feat: export CSV (TASK-1)");
  g("checkout", "-q", "main"); g("merge", "-q", "--no-ff", "-m", "Merge pull request #7 from o/proofline/TASK-1-export", "proofline/TASK-1-export");
  const before = g("status", "--porcelain");
  const r = trace("FR-1", { root });
  assert.deepEqual(r.missing, []);
  const c = r.chains[0].tasks[0];
  assert.equal(c.criteria[0].tests[0].file, "test/export.test.mjs");
  assert.equal(c.criteria[0].tests[0].evidence[0].phase, "RED");
  assert.equal(c.pr.pr, "7");
  assert.equal(g("status", "--porcelain"), before);
  rmSync(root, { recursive: true, force: true });
});
