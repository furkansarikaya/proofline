import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skill = join(here, "../../skills/plan-contract");
const fixture = join(here, "../../fixtures/plan-contract");
const script = join(skill, "scripts/validate-plan.mjs");
const { validate, exemptionProblem, CLASSES, SCOPE_KEYS } = await import(script);
const SCHEMA = JSON.parse(readFileSync(join(skill, "schema/plan.schema.json"), "utf8"));
const TASK = readFileSync(join(fixture, "TASK.md"), "utf8");

let base;
let repo;
before(() => {
  base = mkdtempSync(join(tmpdir(), "pcfx-"));
  repo = join(base, "repo");
  const r = spawnSync("sh", [join(fixture, "setup.sh"), repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
after(() => rmSync(base, { recursive: true, force: true }));

const SCOPE = [
  "  - path: src/shipping.js", "    new: true", "    criteria: [AC-1, AC-2, AC-3]",
  "  - path: src/cart.js", "    criteria: [AC-1, AC-2]",
  "  - path: src/receipt.js", "    criteria: [AC-4]",
  "  - path: test/shipping.test.js", "    new: true", "    criteria: [AC-1, AC-2, AC-3]",
  "  - path: test/receipt.test.js", "    criteria: [AC-4]",
];
const BODY = {
  Behavior: ["- AC-1: `src/shipping.js:shippingFor` returns 0 when subtotal >= threshold", "- AC-4: `src/receipt.js:renderReceipt` prints \"Shipping: free\" for 0"],
  Tests: ["- AC-1: `test/shipping.test.js` \"free at the threshold\"", "- AC-4: `test/receipt.test.js` \"free shipping line\""],
  "Verification commands": ["- `npm test`"],
  Dependencies: ["none"],
  Contracts: ["none"],
  Assumptions: ["none"],
};
function plan({ scope = SCOPE, body = BODY, title = "# Plan: T-7" } = {}) {
  const parts = ["---", "scope:", ...scope, "---", "", title, ""];
  for (const [name, lines] of Object.entries(body)) parts.push(`## ${name}`, "", ...lines, "");
  return parts.join("\n");
}
const errs = (md, o = {}) => validate(md, TASK, { root: repo, ...o });
const has = (e, s) => assert.ok(e.some((x) => x.includes(s)), `expected "${s}" in ${JSON.stringify(e)}`);
const without = (k) => Object.fromEntries(Object.entries(BODY).filter(([n]) => n !== k));

test("accepts a correct plan for the fixture task", () => assert.deepEqual(errs(plan()), []));

test("the known-bad fixture plan is rejected with every planted violation", () => {
  const e = errs(readFileSync(join(fixture, "bad/PLAN.md"), "utf8"));
  for (const s of [
    "glob patterns are not allowed", "duplicate path", "does not exist; mark it new: true", "unknown criterion AC-9",
    "maps to no criterion", "exists but is marked new: true", "tdd_exemption must be at least 20 characters",
    "tdd_exemption is a stock phrase", "is a directory", "AC-4: maps to no scope path and no explicit test",
    'section "## Contracts" is required', 'section "## Dependencies" is empty or a placeholder',
    'first line must be "destructive: yes" or "destructive: no"', "no command in backticks or a code block",
  ]) has(e, s);
});

test("CLI rejects the known-bad plan with exit 1 and accepts the good one with 0", () => {
  const bad = spawnSync(process.execPath, [script, join(fixture, "bad/PLAN.md"), join(repo, "TASK.md"), "--repo", repo], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /glob patterns are not allowed/);
  const good = join(base, "PLAN.md");
  writeFileSync(good, plan());
  assert.equal(spawnSync(process.execPath, [script, good, join(repo, "TASK.md"), "--class", "STANDARD", "--repo", repo]).status, 0);
  assert.equal(spawnSync(process.execPath, [script, good]).status, 2);
});

test("every criterion must map to a path or an explicit test", () => {
  const s = ["  - path: src/shipping.js", "    new: true", "    criteria: [AC-1, AC-2, AC-3]", "  - path: test/shipping.test.js", "    new: true", "    criteria: [AC-1, AC-2, AC-3]"];
  const e = errs(plan({ scope: s, body: { ...BODY, Tests: ["- AC-1: `test/shipping.test.js` \"x\""] } }));
  has(e, "AC-4: maps to no scope path and no explicit test");
  // An existing, unchanged test named in ## Tests is an explicit mapping.
  assert.deepEqual(errs(plan({ scope: s, body: { ...BODY, Tests: ["- AC-4: `test/receipt.test.js` \"prints three lines\""] } })), []);
});

test("a Tests line must name a test file that exists or is in scope", () => {
  has(errs(plan({ body: { ...BODY, Tests: ["- AC-4: `test/nope.test.js` \"x\""] } })), "names no test file");
});

test("sections required by class", () => {
  has(errs(plan(), { cls: "COMPLEX" }), 'section "## Architecture" is required for COMPLEX');
  assert.deepEqual(errs(plan({ body: { Architecture: ["- `src/shipping.js` is a pure function module"], ...BODY } }), { cls: "CRITICAL" }), []);
  has(errs(plan({ body: without("Dependencies") })), 'section "## Dependencies" is required');
});

// A79: the mandatory assumption register.
const AHEAD = ["| id | assumption | source | risk | verification | status | decisions |", "|---|---|---|---|---|---|---|"];
const withAssumptions = (...lines) => errs(plan({ body: { ...BODY, Assumptions: lines } }));
const ROW = (o = {}) => { const r = { id: "AS-1", text: "the threshold is stored in cents", source: "E-3", risk: "low", method: "`src/config.js:loadConfig` reads it as an integer", status: "verified", decisions: "AC-1", ...o }; return `| ${r.id} | ${r.text} | ${r.source} | ${r.risk} | ${r.method} | ${r.status} | ${r.decisions} |`; };

test("## Assumptions is mandatory: missing, empty and free text are rejected", () => {
  has(errs(plan({ body: without("Assumptions") })), 'section "## Assumptions" is required');
  has(withAssumptions(), 'section "## Assumptions" is empty');
  has(withAssumptions("the threshold is probably in cents"), "is not a table row");
  has(withAssumptions(...AHEAD), "has no assumption rows");
  assert.deepEqual(withAssumptions("none"), []);
});

test("assumption rows: valid register passes, every shape error is named", () => {
  assert.deepEqual(withAssumptions(...AHEAD, ROW(), ROW({ id: "AS-2", risk: "high", status: "unverified", method: "ask the data owner whether legacy rows exist" })), []);
  has(withAssumptions(...AHEAD, ROW({ id: "A1" })), "id must match AS-<n>");
  has(withAssumptions(...AHEAD, ROW(), ROW()), "duplicate id");
  has(withAssumptions(...AHEAD, ROW({ risk: "critical" })), "risk must be low|medium|high");
  has(withAssumptions(...AHEAD, ROW({ status: "accepted-by-user" })), "status must be verified|unverified");
  has(withAssumptions(...AHEAD, ROW({ decisions: "" })), "decisions is empty");
  has(withAssumptions(...AHEAD, ROW({ source: "" })), "source is empty");
  has(withAssumptions("| id | text | risk |", "|---|---|---|", "| AS-1 | x | low |"), "header must be");
});

test("trap: a high-risk assumption marked verified without a method is rejected; a low-risk unverified one passes", () => {
  const trap = withAssumptions(...AHEAD, ROW({ risk: "high", status: "verified", method: "none" }));
  has(trap, "verified without a verification method");
  has(trap, "a high-risk assumption needs a verification method");
  has(withAssumptions(...AHEAD, ROW({ risk: "high", status: "unverified", method: "-" })), "a high-risk assumption needs a verification method");
  has(withAssumptions(...AHEAD, ROW({ risk: "low", status: "verified", method: "" })), "verified without a verification method");
  assert.deepEqual(withAssumptions(...AHEAD, ROW({ risk: "low", status: "unverified", method: "none" })), []);
  assert.deepEqual(withAssumptions(...AHEAD, ROW({ risk: "medium", status: "unverified", method: "n/a" })), []);
});

test("the known-bad fixture plan reports no Assumptions section", () => {
  has(errs(readFileSync(join(fixture, "bad/PLAN.md"), "utf8")), 'section "## Assumptions" is required');
});

test("TRIVIAL allows at most two scope paths", () => {
  has(errs(plan(), { cls: "TRIVIAL" }), "TRIVIAL allows at most 2 paths");
});

test("persistence and UI scope paths require ## Data and ## UI", () => {
  const scope = [...SCOPE, "  - path: db/migrations/001_threshold.sql", "    new: true", "    criteria: [AC-3]", "  - path: src/components/Receipt.tsx", "    new: true", "    criteria: [AC-4]"];
  const e = errs(plan({ scope }));
  has(e, 'section "## Data" is required');
  has(e, 'section "## UI" is required');
});

const STEPS_HEAD = ["| step | phase | operation | object | destructive | reversible | rollback | lock |", "|---|---|---|---|---|---|---|---|"];
const EXPAND = "| S1 | expand | switch_reads | books.legacy_fee | no | yes | redeploy the previous release | none |";
const CONTRACT = "| S2 | deferred | drop_column | books.legacy_fee | yes | no | restore from the backup | table rewrite |";

test("TRIVIAL copy change in a UI file needs no ## UI section", () => {
  const scope = ["  - path: public/index.html", "    criteria: [AC-1]"];
  const body = { Behavior: ["- AC-1: `public/index.html` tagline reads library"], Tests: ["- AC-1: `public/index.html` tagline"], "Verification commands": ["- `npm test`"], Dependencies: ["none"], Contracts: ["none"], Assumptions: ["none"] };
  const e = errs(plan({ scope, body }), { cls: "TRIVIAL" });
  assert.ok(!e.some((x) => x.includes('section "## UI"')), JSON.stringify(e));
  has(errs(plan({ scope, body }), { cls: "STANDARD" }), 'section "## UI" is required');
});

test("destructive: yes requires CRITICAL", () => {
  const body = { ...BODY, Data: ["destructive: yes", "", ...STEPS_HEAD, EXPAND, CONTRACT] };
  has(errs(plan({ body })), "destructive: yes requires class CRITICAL");
  assert.deepEqual(errs(plan({ body: { Architecture: ["- one module"], ...body } }), { cls: "CRITICAL" }), []);
});

test("destructive: yes needs expand/contract steps unless the plan says single_step: yes", () => {
  const crit = (Data) => errs(plan({ body: { Architecture: ["- one module"], ...BODY, Data } }), { cls: "CRITICAL" });
  const MSG = "needs expand/contract steps";
  has(crit(["destructive: yes", "", "- drop column legacy_fee"]), MSG);
  has(crit(["destructive: yes", "", ...STEPS_HEAD, CONTRACT]), MSG);                         // no preceding non-destructive step
  has(crit(["destructive: yes", "", ...STEPS_HEAD, "| S1 | expand | drop_column | books.legacy_fee | yes | no | backup | rewrite |"]), MSG); // one release
  has(crit(["destructive: yes", "", ...STEPS_HEAD, EXPAND, "| S2 | expand | drop_column | books.legacy_fee | yes | no | backup | rewrite |"]), MSG);
  has(crit(["destructive: yes", "", ...STEPS_HEAD, EXPAND, "| S2 | contract | drop_column | books.legacy_fee | yes | no | backup | rewrite |"]), MSG); // contract in this change is one step
  assert.deepEqual(crit(["destructive: yes", "", ...STEPS_HEAD, EXPAND, "| S2 | deferred | drop_column | books.legacy_fee | yes | no | backup | rewrite |"]), []);
  // single_step is offered only when the task states that the user wants one step (A52)
  has(crit(["destructive: yes", "single_step: yes", "", "drop books.legacy_fee in one migration"]), MSG);
  const withUser = (Data) => validate(plan({ body: { Architecture: ["- one module"], ...BODY, Data } }), TASK + "\nThe user wants this as a single step.\n", { root: repo, cls: "CRITICAL" });
  assert.deepEqual(withUser(["destructive: yes", "single_step: yes", "", "drop books.legacy_fee in one migration"]), []);
  // a non-destructive plan is not subject to the check
  assert.deepEqual(crit(["destructive: no", "", "- add a nullable column"]), []);
});

test("path hygiene: absolute, traversal, ./, run artifacts, quoted", () => {
  for (const [p, msg] of [["/etc/passwd", "repo-relative"], ["../x.js", "repo-relative"], ["./src/cart.js", "repo-relative"], [".agents/runs/T-7/PLAN.md", "run artifacts"], ['"src/cart.js"', "unquoted"]]) {
    has(errs(plan({ scope: [...SCOPE, `  - path: ${p}`, "    new: true", "    criteria: [AC-1]"] })), msg);
  }
});

test("non-canonical front matter is rejected", () => {
  has(errs(plan({ scope: [...SCOPE, "    owner: me"] })), 'unknown scope key "owner"');
  has(errs(plan({ scope: [...SCOPE, "  - path: src/config.js", "    criteria: AC-3"] })), "flow list");
  has(errs("# Plan: T-7\n"), "must start with a '---' line");
});

test("title must name the task", () => {
  has(errs(plan({ title: "# Plan: T-8" })), "plan is for T-8, task is T-7");
});

test("placeholders are rejected", () => {
  has(errs(plan({ body: { ...BODY, Behavior: ["<behavior>"] } })), 'section "## Behavior" is empty or a placeholder');
});

test("tdd_exemption: specific reasons pass, stock phrases fail", () => {
  assert.equal(exemptionProblem("data file read by src/config.js; AC-3 proven by test/shipping.test.js"), null);
  assert.match(exemptionProblem("n/a"), /20 characters/);
  assert.match(exemptionProblem("Not applicable for this change"), /stock phrase/);
  assert.match(exemptionProblem("trivial config only change, no logic"), /stock phrase/);
});

test("enums agree with the schema", () => {
  assert.deepEqual(Object.keys(SCHEMA.properties.scope.items.properties), SCOPE_KEYS);
  for (const c of CLASSES) assert.ok(SCHEMA.$comment.includes(c));
});

test("SKILL.md frontmatter and shared rules block", () => {
  const md = readFileSync(join(skill, "SKILL.md"), "utf8");
  const desc = /^description: (.+)$/m.exec(md)[1];
  assert.ok(desc.length <= 900, `description is ${desc.length} chars`);
  assert.match(md, /^name: plan-contract$/m);
  assert.match(md, /^disable-model-invocation: true$/m);
  assert.ok(md.split("\n").length < 500);
  const shared = readFileSync(join(here, "../shared/shared-rules.md"), "utf8").trim();
  assert.ok(md.includes(shared), "shared rules block must be byte-identical");
});

test("design documents of the config are in scope when the plan changes the data model or the contracts (A64)", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-docs-"));
  mkdirSync(join(root, ".agents"), { recursive: true }); mkdirSync(join(root, "docs/design"), { recursive: true });
  writeFileSync(join(root, ".agents/config.yaml"), "design_docs:\n  data_model: docs/design/DATA_MODEL.md\n  api: docs/design/API.md\n");
  writeFileSync(join(root, "docs/design/DATA_MODEL.md"), "# data\n"); writeFileSync(join(root, "docs/design/API.md"), "# api\n");
  writeFileSync(join(root, "src.js"), "x\n");
  const body = { Architecture: ["- one module"], ...BODY, Data: ["destructive: no", "", "- adds a nullable column"], Contracts: ["- `GET /api/books` gains `tags`"] };
  const e = validate(plan({ body }), TASK, { root, cls: "COMPLEX" });
  has(e, "docs/design/DATA_MODEL.md is the project's design document for ## Data");
  has(e, "docs/design/API.md is the project's design document for ## Contracts");
});
