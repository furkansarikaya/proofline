import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateVerify, visualProofIds } from "../../skills/verify-proof/scripts/validate-verify.mjs";

const SCRIPT = fileURLToPath(new URL("../../skills/verify-proof/scripts/validate-verify.mjs", import.meta.url));
const TASK = "## Acceptance criteria\n- AC-1: returns 429\n- AC-2: resets counter\n";
const PLAN = (exempt = true, second = false) => `---\nscope:\n  - path: docs/message.md\n    criteria: [AC-2]\n${exempt ? '    tdd_exemption: "Corrected text is confirmed by a direct content check"\n' : ''}${second ? '  - path: docs/other.md\n    criteria: [AC-2]\n' : ''}---\n`;

const mk = (o = {}) => `# Verification: T-1

## Commands
${o.commands ?? "- `npm test` | exit=0\n  output: 12 pass\n- `npm run lint` | exit=0\n  output: clean"}

## AC coverage
| AC | test | status | evidence |
|---|---|---|---|
${o.rows ?? "| AC-1 | tests/login.test.js::sixth attempt | PASS | `npm test` exit=0 |\n| AC-2 | tests/login.test.js::reset | PASS | `npm test` exit=0 |"}

## Scope
${o.scope ?? "verify-scope: exit=0"}

## Design sync
${o.ds ?? "design-sync: SKIPPED (no design docs)"}

## Pre-existing failures
${o.pre ?? "None."}

## Failures
${o.failures ?? "None."}

${o.verdict ?? "Verdict: PASS"}
`;
const e = (o, task = TASK) => validateVerify(mk(o), task).errors.join("\n");

test("accepts a passing verification", () => {
  const r = validateVerify(mk(), TASK);
  assert.equal(r.valid, true, r.errors.join());
  assert.equal(r.computed, "PASS");
});

test("a failing command forces FAIL; PASS verdict is rejected", () => {
  assert.match(e({ commands: "- `npm test` | exit=1\n  output: 1 failing" }), /contradicts the evidence/);
  assert.equal(e({ commands: "- `npm test` | exit=1\n  output: 1 failing", verdict: "Verdict: FAIL", failures: "npm test fails" }), "");
});

test("a failure that also fails at base is pre-existing, not FAIL", () => {
  const o = { commands: "- `npm test` | exit=1 | base_exit=1\n  output: same failure at base", pre: "- `npm test`: fails at base commit" };
  assert.equal(e(o), "");
  assert.match(e({ ...o, pre: "None." }), /not listed under ## Pre-existing failures/);
});

test("a failure that passes at base is a regression (FAIL)", () => {
  assert.match(e({ commands: "- `npm test` | exit=1 | base_exit=0\n  output: x" }), /contradicts the evidence/);
});

test("passing command cannot carry base_exit", () => {
  assert.match(e({ commands: "- `npm test` | exit=0 | base_exit=1" }), /only recorded for failing/);
});

test("AC without a passing test forces FAIL; missing row rejected", () => {
  assert.match(e({ rows: "| AC-1 | t | PASS | e |\n| AC-2 | - | MISSING | no test references it |" }), /AC-2 MISSING/);
  assert.match(e({ rows: "| AC-1 | tests/x::a | PASS | `npm test` |" }), /AC-2 has no row/);
  assert.match(e({ rows: "| AC-1 | | PASS | |\n| AC-2 | t | PASS | e |" }), /AC-1: PASS needs a test reference/);
});

test("command proof requires all mapped paths exempt and recorded passing output", () => {
  const rows = "| AC-1 | tests/login.test.js::sixth attempt | PASS | `npm test` exit=0 |\n| AC-2 | command: `grep -n corrected docs/message.md` | PASS | `grep -n corrected docs/message.md` exit=0; output: 7:corrected text |";
  const commands = "- `npm test` | exit=0\n  output: 12 pass\n- `grep -n corrected docs/message.md` | exit=0\n  output: 7:corrected text";
  assert.equal(validateVerify(mk({ rows, commands }), TASK, PLAN()).errors.join(), "");
  assert.match(validateVerify(mk({ rows, commands }), TASK).errors.join(), /requires tdd_exemption/);
  assert.match(validateVerify(mk({ rows, commands }), TASK, PLAN(false)).errors.join(), /requires tdd_exemption/);
  assert.match(validateVerify(mk({ rows, commands }), TASK, PLAN(true, true)).errors.join(), /requires tdd_exemption/);
  assert.match(validateVerify(mk({ rows, commands: commands.replace("7:corrected text", "unrelated") }), TASK, PLAN()).errors.join(), /demonstrating output line/);
  assert.match(validateVerify(mk({ rows, commands: commands.replace("exit=0\n  output: 7", "exit=1\n  output: 7") }), TASK, PLAN()).errors.join(), /recorded passing exact command/);
});

test("scope failure forces FAIL", () => {
  assert.match(e({ scope: "verify-scope: exit=1" }), /verify-scope failed/);
  assert.match(e({ scope: "scope ok" }), /verify-scope: exit=N/);
});

test("design-sync FAIL forces FAIL; SKIPPED needs a reason", () => {
  assert.match(e({ ds: "design-sync: FAIL" }), /design-sync drift/);
  assert.match(e({ ds: "design-sync: SKIPPED" }), /needs a reason/);
  assert.equal(e({ ds: "design-sync: PASS" }), "");
});

test("verdict must be the single last line", () => {
  assert.match(e({ verdict: "Verdict: PASS\n\nnotes" }), /exactly one/);
  assert.match(e({ verdict: "Verdict: MAYBE" }), /exactly one/);
  assert.match(e({ verdict: "Verdict: PASS\nVerdict: PASS" }), /exactly one/);
});

test("BLOCKED needs a reason line", () => {
  assert.match(e({ verdict: "Verdict: BLOCKED" }), /BLOCKED: <reason>/);
  assert.equal(e({ verdict: "BLOCKED: no node installed\nVerdict: BLOCKED" }), "");
});

test("malformed command line and missing section", () => {
  assert.match(e({ commands: "- npm test passed" }), /malformed command line/);
  assert.match(validateVerify(mk().replace("## Scope", "## Other"), TASK).errors.join(), /missing section "## Scope"/);
});

test("CLI", () => {
  const d = mkdtempSync(join(tmpdir(), "vp-"));
  writeFileSync(join(d, "v.md"), mk());
  writeFileSync(join(d, "bad.md"), mk({ scope: "verify-scope: exit=2" }));
  writeFileSync(join(d, "t.md"), TASK);
  const run = (...a) => spawnSync("node", [SCRIPT, ...a], { encoding: "utf8" });
  assert.equal(run(join(d, "v.md"), "--task", join(d, "t.md")).status, 0);
  assert.equal(run(join(d, "bad.md")).status, 1);
  assert.equal(run(join(d, "nope.md")).status, 2);
  const commandRow = "| AC-1 | tests/login.test.js::sixth attempt | PASS | `npm test` exit=0 |\n| AC-2 | command: `grep -n corrected docs/message.md` | PASS | `grep -n corrected docs/message.md` exit=0; output: 7:corrected text |";
  writeFileSync(join(d, "command.md"), mk({ rows: commandRow, commands: "- `npm test` | exit=0\n  output: 12 pass\n- `grep -n corrected docs/message.md` | exit=0\n  output: 7:corrected text" }));
  writeFileSync(join(d, "plan.md"), PLAN());
  assert.equal(run(join(d, "command.md"), "--task", join(d, "t.md"), "--plan", join(d, "plan.md")).status, 0);
  assert.equal(run(join(d, "command.md"), "--task", join(d, "t.md")).status, 1);
});

test("entries under ## Failures (dependency, contract, design drift) fail the computed verdict", () => {
  for (const f of [
    "- package.json:9: new dependency ioredis is not listed in ## Dependencies",
    "- api/openapi.yaml:3: versioned contract /v1/cart changed but not named in ## Contracts",
    "- docs/design/DATA_MODEL.md:14 -> table `orders` not found in code",
    "| VERIFY-1 | blocking | package.json:9 | undeclared dependency | traced |",
  ]) {
    assert.match(e({ failures: f }), /contradicts the evidence \(computed FAIL: failure listed:/, f);
    assert.equal(e({ failures: f, verdict: "Verdict: FAIL" }), "", f);
  }
  const r = validateVerify(mk({ failures: "- package.json:9: undeclared dependency", verdict: "Verdict: FAIL" }), TASK);
  assert.deepEqual([r.valid, r.computed, r.reasons.length], [true, "FAIL", 1]);
});

test("None, an empty Failures section and table scaffolding do not fail the verdict", () => {
  for (const f of ["None.", "None", "", "| id | severity | path | finding | evidence |\n|---|---|---|---|---|"]) assert.equal(e({ failures: f }), "", JSON.stringify(f));
});

test("design-sync FAIL still fails, and its drift line under Failures is counted once per entry", () => {
  const r = validateVerify(mk({ ds: "design-sync: FAIL", failures: "- docs/a.md:1 -> x\n- docs/a.md:2 -> y", verdict: "Verdict: FAIL" }), TASK);
  assert.equal(r.valid, true);
  assert.equal(r.reasons.filter((x) => x.startsWith("failure listed")).length, 2);
  assert.ok(r.reasons.includes("design-sync drift"));
});

test("SKILL.md team mode: VERIFY-<n> rows, blocking|info, PASS|FAIL|BLOCKED, no V-<n> row ids", async () => {
  const { readFileSync } = await import("node:fs");
  const md = readFileSync(new URL("../../skills/verify-proof/SKILL.md", import.meta.url), "utf8");
  const team = md.slice(md.indexOf("## Team mode"), md.indexOf("<!-- proofline:shared-rules:begin"));
  const rows = [...team.matchAll(/^\| (\S+) \| (\S+) \|/gm)].map((m) => [m[1], m[2]]).filter(([id]) => id !== "id");
  assert.ok(rows.length >= 3);
  for (const [id, sev] of rows) { assert.match(id, /^VERIFY-\d+$/); assert.match(sev, /^(blocking|info)$/); }
  assert.match(team, /`RESULT: PASS \| FAIL \| BLOCKED` \(never `NEEDS_INPUT` or `DONE`/);
  assert.doesNotMatch(team, /\| V-<n> \| high/);
  assert.match(md, /Missing criteria: standalone, ask the user and stop; in a run -> `RESULT: BLOCKED`/);
  assert.doesNotMatch(md.replace(/<!-- proofline:shared-rules:begin[\s\S]*?shared-rules:end -->/, ""), /-> NEEDS_INPUT/);
});

test("A82: a criterion on the PLAN visual_proof line is unproven without visual-proof evidence", () => {
  const plan = `${PLAN()}\n## UI\n\nOrders screen.\nvisual_proof: AC-1\n`;
  // the test passes, but the criterion needs visual evidence: PASS is rejected, MISSING is the honest row
  assert.match(validateVerify(mk(), TASK, plan).errors.join(), /AC-1: marked visual_proof in PLAN\.md; PASS needs/);
  const missing = "| AC-1 | tests/login.test.js::sixth attempt | MISSING | no visual-proof report |\n| AC-2 | tests/login.test.js::reset | PASS | `npm test` exit=0 |";
  assert.equal(validateVerify(mk({ rows: missing, verdict: "Verdict: FAIL" }), TASK, plan).errors.join(), "");
  const cited = "| AC-1 | tests/login.test.js::sixth attempt | PASS | `npm test` exit=0; visual-proof: AC-1 proven (reviews/visual-proof/report.json) |\n| AC-2 | tests/login.test.js::reset | PASS | `npm test` exit=0 |";
  assert.equal(validateVerify(mk({ rows: cited }), TASK, plan).errors.join(), "");
  // an unproven citation, or another criterion's, does not count
  assert.match(validateVerify(mk({ rows: cited.replace("AC-1 proven", "AC-1 unproven") }), TASK, plan).errors.join(), /PASS needs/);
  assert.match(validateVerify(mk({ rows: cited.replace("AC-1 proven", "AC-10 proven") }), TASK, plan).errors.join(), /PASS needs/);
  // `none`, no line, or the line outside ## UI: unchanged behaviour
  for (const p of [`${PLAN()}\n## UI\nvisual_proof: none\n`, PLAN(), `${PLAN()}\n## Notes\nvisual_proof: AC-1\n`]) assert.equal(validateVerify(mk(), TASK, p).errors.join(), "");
});

test("visual_proof line: spacing and backtick variants parse; the plan validator reads the same shape (A94)", () => {
  const plan = (l) => `## UI\n\n${l}\n`;
  for (const l of ["visual_proof: AC-1, AC-3", "- visual_proof: AC-1, AC-3", "* visual_proof:   AC-1, AC-3  ", "`visual_proof: AC-1, AC-3`", "- `visual_proof: AC-1, AC-3`"]) {
    assert.deepEqual(visualProofIds(plan(l)), ["AC-1", "AC-3"], l);
  }
  assert.deepEqual(visualProofIds(plan("-visual_proof: AC-1")), [], "no space after the bullet marker is not a line");
  assert.deepEqual(visualProofIds(plan("visual_proof: none")), []);
});
