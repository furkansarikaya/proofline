import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validatePlan, validateReport, computeVerdict, sha256 } from "../../skills/qa-plan/scripts/validate-qa.mjs";

const SCRIPT = fileURLToPath(new URL("../../skills/qa-plan/scripts/validate-qa.mjs", import.meta.url));

const TASK = "## Acceptance criteria\n- AC-1: returns 429\n- AC-2: resets counter\n";
const PLAN = `# QA plan: T-1

## Acceptance scenarios
- QA-1 (AC-1): sixth failure is rejected
  input: 6 wrong passwords within 10 minutes
  expected: sixth response is HTTP 429
  execution: auto
  run: \`npm test -- login\`
- QA-2 (AC-2): success resets
  input: 3 failures then a correct password
  expected: next failure count is 1
  execution: auto
  run: \`curl\` sequence in a scratch worktree

## Adversarial scenarios
- QA-3 (AC-1) [concurrency]: parallel attempts
  input: 20 simultaneous wrong passwords
  expected: at most 5 are answered 401, the rest 429
  execution: auto
  run: node script firing 20 requests

## Regression surface
Existing login success path: \`npm test -- auth\`.
`;
const report = (plan, body = {}) => `# QA report: T-1

Verdict: ${body.verdict ?? "PASS"}
Plan sha256: ${body.hash ?? sha256(plan)}

## Scenarios
${body.scenarios ?? "- QA-1: PASS — got 429 on request 6 (`npm test -- login`, exit 0)\n- QA-2: PASS — counter was 1 (`curl` sequence)\n- QA-3: PASS — 15 of 20 answered 429, no defect reproduced"}

## Failures
${body.failures ?? "None."}
`;
const perr = (t, task) => validatePlan(t, task).errors.join("\n");

test("accepts a good plan, with and without task", () => {
  assert.equal(validatePlan(PLAN).valid, true, perr(PLAN));
  assert.equal(validatePlan(PLAN, TASK).valid, true, perr(PLAN, TASK));
});

test("plan: every AC needs an acceptance scenario; unknown AC refs rejected", () => {
  assert.match(perr(PLAN, TASK + "- AC-3: shows banner\n"), /AC-3 has no acceptance scenario/);
  assert.match(perr(PLAN.replace("QA-2 (AC-2)", "QA-2 (AC-9)"), TASK), /unknown AC-9/);
});

test("plan: scenarios need input, expected and run", () => {
  assert.match(perr(PLAN.replace(/  run: `npm test -- login`\n/, "")), /QA-1: missing "run:"/);
  assert.match(perr(PLAN.replace("  expected: next failure count is 1\n", "")), /QA-2: missing "expected:"/);
});

test("plan: adversarial needs a known category; none-applicable allowed with reason", () => {
  assert.match(perr(PLAN.replace("[concurrency]", "[chaos]")), /category/);
  assert.match(perr(PLAN.replace(" [concurrency]", "")), /category/);
  const none = PLAN.replace(/## Adversarial scenarios[\s\S]*## Regression/, "## Adversarial scenarios\nNone applicable: pure text change\n\n## Regression");
  assert.equal(validatePlan(none).valid, true, perr(none));
  assert.match(perr(PLAN.replace(/## Adversarial scenarios[\s\S]*## Regression/, "## Adversarial scenarios\nnone\n\n## Regression")), /None applicable/);
});

test("plan: duplicate ids, missing sections, placeholders", () => {
  assert.match(perr(PLAN.replace("QA-3", "QA-1")), /duplicate scenario id QA-1/);
  assert.match(perr(PLAN.replace("## Regression surface", "## Other")), /missing section "## Regression surface"/);
  assert.match(perr(PLAN.replace("sixth failure", "TBD")), /placeholder/);
});

test("gate rule is mechanical", () => {
  assert.equal(computeVerdict(["PASS", "PASS"]), "PASS");
  assert.equal(computeVerdict(["PASS", "BLOCKED"]), "BLOCKED");
  assert.equal(computeVerdict(["BLOCKED", "FAIL"]), "FAIL");
});

test("accepts a good report and binds it to the plan hash", () => {
  assert.equal(validateReport(report(PLAN), PLAN).valid, true, validateReport(report(PLAN), PLAN).errors.join());
});

test("report: a FAIL scenario forces FAIL and must be described", () => {
  const sc = "- QA-1: PASS — ok (cmd)\n- QA-2: FAIL — counter stayed 3 (curl)\n- QA-3: PASS — fine (script)";
  const e = (b) => validateReport(report(PLAN, b), PLAN).errors.join("\n");
  assert.match(e({ scenarios: sc, verdict: "PASS", failures: "QA-2: expected 1, got 3" }), /contradicts the gate rule/);
  assert.match(e({ scenarios: sc, verdict: "FAIL" }), /QA-2 is FAIL but is not described/);
  assert.equal(e({ scenarios: sc, verdict: "FAIL", failures: "QA-2: expected 1, got 3" }), "");
});

test("report: BLOCKED needs a reason; PASS cannot hide a BLOCKED scenario", () => {
  const sc = "- QA-1: PASS — ok (cmd)\n- QA-2: BLOCKED — no database available\n- QA-3: PASS — fine (script)";
  const r = validateReport(report(PLAN, { scenarios: sc, verdict: "PASS", failures: "QA-2: no database" }), PLAN);
  assert.match(r.errors.join(), /contradicts/);
  assert.equal(validateReport(report(PLAN, { scenarios: sc, verdict: "BLOCKED", failures: "QA-2: no database" }), PLAN).valid, true);
});

test("report: stale or foreign plan hash is rejected (no weakening after freeze)", () => {
  const edited = PLAN.replace("HTTP 429", "HTTP 4xx");
  assert.match(validateReport(report(PLAN), edited).errors.join(), /Plan sha256 does not match/);
  assert.match(validateReport(report(PLAN, { hash: "abc" }), PLAN).errors.join(), /Plan sha256/);
});

test("report: missing results, extra results, missing evidence, two verdicts", () => {
  const e = (b, x = "") => validateReport(report(PLAN, b) + x, PLAN).errors.join("\n");
  assert.match(e({ scenarios: "- QA-1: PASS — ok (cmd)" }), /no result for plan scenario QA-2/);
  assert.match(e({ scenarios: "- QA-1: PASS\n- QA-2: PASS — ok\n- QA-3: PASS — ok" }), /QA-1: evidence/);
  assert.match(e({}, "\nVerdict: FAIL\n"), /exactly one/);
});

test("report: result for a scenario not in the plan", () => {
  const sc = "- QA-1: PASS — a\n- QA-2: PASS — b\n- QA-3: PASS — c\n- QA-9: PASS — d";
  assert.match(validateReport(report(PLAN, { scenarios: sc }), PLAN).errors.join(), /QA-9, which is not in the plan/);
});

test("CLI", () => {
  const d = mkdtempSync(join(tmpdir(), "qa-"));
  writeFileSync(join(d, "task.md"), TASK);
  writeFileSync(join(d, "plan.md"), PLAN);
  writeFileSync(join(d, "rep.md"), report(PLAN));
  const run = (...a) => spawnSync("node", [SCRIPT, ...a], { encoding: "utf8" });
  assert.equal(run("plan", join(d, "plan.md"), "--task", join(d, "task.md")).status, 0);
  assert.equal(run("report", join(d, "rep.md"), "--plan", join(d, "plan.md")).status, 0);
  assert.equal(run("hash", join(d, "plan.md")).stdout.trim(), sha256(PLAN));
  writeFileSync(join(d, "plan.md"), PLAN + "\nmore\n");
  assert.equal(run("report", join(d, "rep.md"), "--plan", join(d, "plan.md")).status, 1);
  assert.equal(run("plan", join(d, "missing.md")).status, 2);
  assert.equal(run("bogus").status, 2);
});

test("team mode ids: qa-<n> for the plan step, QA-<n> for gate findings, qa/ dir for test-trust", () => {
  const md = readFileSync(new URL("../../skills/qa-plan/SKILL.md", import.meta.url), "utf8");
  assert.match(md, /\| qa-<n> \| info \|/);
  assert.match(md, /reports\/qa-evidence\//);
  assert.match(md, /\| QA-<n> \| blocking \|/);
  assert.match(md, /reviews\/test-trust\/qa\//);
});

test("plan: an acceptance scenario may not carry an adversarial category", () => {
  assert.match(perr(PLAN.replace("QA-1 (AC-1):", "QA-1 (AC-1) [concurrency]:")), /QA-1: acceptance scenarios carry no category/);
  assert.equal(validatePlan(PLAN).valid, true);
});

test("report without --plan rejects zero scenario results (and a Scenarios section of prose)", () => {
  const empty = "# QA report: T-1\n\nVerdict: PASS\nPlan sha256: " + "a".repeat(64) + "\n\n## Scenarios\n\nnothing to report\n\n## Failures\n\nNone.\n";
  assert.match(validateReport(empty).errors.join("\n"), /no scenario results/);
  const file = join(mkdtempSync(join(tmpdir(), "qa-empty-")), "QA_REPORT.md");
  writeFileSync(file, empty);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "report", file]).status, 1);
  assert.equal(validateReport(report(PLAN)).valid, true);
});

const MAN = PLAN.replace("  execution: auto\n  run: `curl` sequence in a scratch worktree\n", "  execution: manual\n  reason: needs a real browser pager\n  human-check: page 2 link is highlighted\n  run: open /list and click page 2\n");

test("plan: execution field is required and must be auto|manual", () => {
  assert.match(perr(PLAN.replace("  execution: auto\n  run: `npm test -- login`", "  run: `npm test -- login`")), /QA-1: missing "execution/);
  assert.match(perr(PLAN.replace("execution: auto\n  run: `npm", "execution: sometimes\n  run: `npm")), /execution must be auto or manual/);
});

test("plan: manual needs reason and human-check", () => {
  assert.equal(validatePlan(MAN).valid, true, perr(MAN));
  assert.deepEqual(validatePlan(MAN).manual, ["QA-2"]);
  assert.match(perr(MAN.replace("  reason: needs a real browser pager\n", "")), /QA-2: manual scenario needs a "reason:"/);
  assert.match(perr(MAN.replace("  human-check: page 2 link is highlighted\n", "")), /QA-2: manual scenario needs a "human-check:"/);
});

test("report: manual scenarios are not-run (manual) and never block the gate", () => {
  const sc = "- QA-1: PASS — ok (cmd)\n- QA-2: not-run (manual) — human: click page 2, link highlighted\n- QA-3: PASS — fine (script)";
  const r = validateReport(report(MAN, { scenarios: sc }), MAN);
  assert.equal(r.valid, true, r.errors.join());
  assert.equal(computeVerdict(["PASS", "not-run (manual)"]), "PASS");
  assert.equal(computeVerdict(["FAIL", "not-run (manual)"]), "FAIL");
});

test("report: manual scenario cannot be reported run; auto cannot be not-run (manual); gate stays mechanical", () => {
  const e = (plan, sc, b = {}) => validateReport(report(plan, { scenarios: sc, ...b }), plan).errors.join("\n");
  assert.match(e(MAN, "- QA-1: PASS — a\n- QA-2: BLOCKED — no browser\n- QA-3: PASS — c", { verdict: "BLOCKED", failures: "QA-2: x" }), /QA-2 is execution: manual/);
  assert.match(e(PLAN, "- QA-1: PASS — a\n- QA-2: not-run (manual) — human\n- QA-3: PASS — c"), /QA-2 is execution: auto/);
  assert.match(e(MAN, "- QA-1: FAIL — a\n- QA-2: not-run (manual) — human\n- QA-3: PASS — c", { verdict: "PASS", failures: "QA-1" }), /contradicts the gate rule/);
  assert.match(e(MAN, "- QA-1: PASS — a\n- QA-2: not-run (manual) — human\n- QA-3: BLOCKED — no db", { verdict: "PASS", failures: "QA-3" }), /contradicts the gate rule/);
});
