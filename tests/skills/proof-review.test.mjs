import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { validate, checkReproductionPaths, checkConsistency } from "../../skills/proof-review/scripts/validate-findings.mjs";
import { computeGate, RUN_DIR, HEADER_FOCUS, FOCUSES, FORBIDDEN_BY_FOCUS } from "../../skills/proof-review/scripts/gate.mjs";

const SCRIPT = new URL("../../skills/proof-review/scripts/validate-findings.mjs", import.meta.url).pathname;
const SCHEMA = JSON.parse(readFileSync(new URL("../../skills/proof-review/schema/findings.schema.json", import.meta.url)));

const loc = { file: "src/shop.ts", line: 12 };
// structuredClone: tests mutate documents, and `loc` must not be shared between them.
const doc = () => structuredClone({
  schema_version: 1, skill_version: "0.0.19", generated_at: "2026-10-08T12:00:00Z",
  target: { type: "branch", name: "feature/discount", slug: "feature-discount", base: "aaa111", head: "bbb222" },
  scope: { changed_files: 2, changed_lines: 40, excluded: ["package-lock.json"], not_reviewed: [{ path: "docs/", reason: "docs only" }], rule_files_read: ["CLAUDE.md"], rule_files_not_read: [] },
  claims: [
    { id: "C001", text: "codes are case-insensitive", source: "user", status: "done", locations: [loc] },
    { id: "C002", text: "old endpoint removed", source: "commit", status: "partial", locations: [loc], missing_part: "route still registered" },
    { id: "C003", text: "adds audit log", source: "issue", status: "missing", locations: [] },
  ],
  rules: [{ id: "R001", rule: "No business logic in controllers", source: { file: "CLAUDE.md", line: 7 }, location: loc, violation: "The handler computes the discount itself." }],
  unrequested: [{ id: "U001", files: ["src/log.ts"], description: "Adds request logging." }],
  bugs: [
    { id: "F001", evidence: "reproduced", location: loc, input: "save10", expected: "90", actual: "100",
      impact: "A customer typing the code in lowercase pays full price.",
      reproduction: { file: "evidence/F001/repro.test.ts", command: "npx vitest run evidence/F001/repro.test.ts", output: "evidence/F001/output.txt" },
      status: "open" },
    { id: "F002", evidence: "traced", location: loc, input: "empty cart", expected: "0", actual: "NaN",
      impact: "An empty cart shows NaN to the customer.",
      trace: ["src/shop.ts:10 total starts undefined", "src/shop.ts:14 undefined + 0 yields NaN"], status: "open" },
  ],
  suspicions: [{ id: "S001", location: loc, reason: "unbounded retry", why_unproven: "no failing input found" }],
});

const tmpDirs = [];
const mktmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function fixture(d = doc(), { files = ["evidence/F001/repro.test.ts", "evidence/F001/output.txt"] } = {}) {
  const dir = mktmp("proof-review-test-");
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "x");
  }
  writeFileSync(join(dir, "findings.json"), JSON.stringify(d));
  return dir;
}
const all = (d, dir) => [...validate(d), ...(dir ? checkReproductionPaths(d, dir) : [])].join("\n");

test("valid document passes, including the CLI", () => {
  const dir = fixture();
  assert.equal(all(doc(), dir), "");
  const out = execFileSync("node", [SCRIPT, join(dir, "findings.json")], { encoding: "utf8" });
  assert.match(out, /^OK:/);
});

test("CLI exits 1 with one line per error", () => {
  const d = doc(); d.bugs[0].impact = "";
  const dir = fixture(d);
  const r = spawnSync("node", [SCRIPT, join(dir, "findings.json")], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /INVALID/);
  assert.match(r.stderr, /bugs\[0\]\.impact/);
});

test("reproduced bug without reproduction fails", () => {
  const d = doc(); delete d.bugs[0].reproduction;
  assert.match(all(d), /requires "reproduction"/);
});

test("traced bug with 1 step fails; traced with reproduction fails", () => {
  let d = doc(); d.bugs[1].trace = ["only one"];
  assert.match(all(d), /at least 2 steps/);
  d = doc(); d.bugs[1].reproduction = doc().bugs[0].reproduction;
  assert.match(all(d), /allowed only when evidence is reproduced/);
});

test("partial without missing_part fails; missing_part on done fails", () => {
  let d = doc(); delete d.claims[1].missing_part;
  assert.match(all(d), /missing_part: required/);
  d = doc(); d.claims[0].missing_part = "x";
  assert.match(all(d), /missing_part: allowed only when status is partial/);
});

test("done claim needs a location; missing claim may have none", () => {
  const d = doc(); d.claims[0].locations = [];
  assert.match(all(d), /at least 1 location/);
});

test("duplicate id fails", () => {
  const d = doc(); d.bugs[1].id = "F001";
  assert.match(all(d), /duplicate id F001/);
});

test("wrong id prefix fails", () => {
  const d = doc(); d.bugs[1].id = "C002";
  assert.match(all(d), /id must match \^F/);
});

test("bad enums fail", () => {
  let d = doc(); d.claims[0].status = "finished";
  assert.match(all(d), /status: must be one of/);
  d = doc(); d.bugs[0].evidence = "guessed";
  assert.match(all(d), /evidence: must be one of/);
  d = doc(); d.target.type = "tag";
  assert.match(all(d), /target\.type: must be one of/);
});

test("severity field is rejected", () => {
  const d = doc(); d.bugs[0].severity = "high";
  assert.match(all(d), /unexpected "severity"/);
});

test("empty impact fails", () => {
  const d = doc(); d.bugs[1].impact = "  ";
  assert.match(all(d), /impact: expected non-empty string/);
});

test("working_tree needs null head; branch needs a head", () => {
  let d = doc(); d.target = { type: "working_tree", name: "working-tree", slug: "working-tree", base: "aaa", head: "bbb" };
  assert.match(all(d), /head: must be null/);
  d = doc(); d.target.head = null;
  assert.match(all(d), /head: expected non-empty string/);
});

test("path escape fails: .. and absolute", () => {
  let d = doc(); d.bugs[0].reproduction.file = "../secret.txt";
  assert.match(all(d, fixture(d)), /escapes the output folder/);
  d = doc(); d.bugs[0].reproduction.output = "/etc/passwd";
  assert.match(all(d, fixture(d)), /escapes the output folder/);
});

test("symlink out of the output folder fails", () => {
  const outside = mktmp("proof-review-outside-");
  writeFileSync(join(outside, "o.txt"), "x");
  const dir = fixture();
  symlinkSync(join(outside, "o.txt"), join(dir, "evidence", "F001", "link.txt"));
  const d = doc(); d.bugs[0].reproduction.output = "evidence/F001/link.txt";
  assert.match(all(d, dir), /resolves outside the output folder/);
});

test("missing evidence file fails", () => {
  const d = doc();
  const dir = fixture(d, { files: ["evidence/F001/repro.test.ts"] });
  assert.match(all(d, dir), /reproduction output not found/);
});

test("schema file parses and mirrors the validator's enums", () => {
  assert.deepEqual(SCHEMA.properties.bugs.items.properties.evidence.enum, ["reproduced", "traced"]);
  assert.equal(SCHEMA.properties.bugs.items.properties.severity, undefined);
  assert.ok(SCHEMA.required.includes("rules"));
  assert.ok(SCHEMA.properties.scope.required.includes("rule_files_not_read"));
});

test("document with a rules record passes; empty rules array passes", () => {
  assert.equal(all(doc()), "");
  const d = doc(); d.rules = [];
  assert.equal(all(d), "");
});

test("rule without a verbatim quote fails", () => {
  const d = doc(); d.rules[0].rule = " ";
  assert.match(all(d), /rules\[0\]\.rule: expected non-empty string/);
  const e = doc(); delete e.rules[0].rule;
  assert.match(all(e), /missing required "rule"/);
});

test("bad R id and wrong prefix in rules fail", () => {
  let d = doc(); d.rules[0].id = "R1";
  assert.match(all(d), /id must match \^R/);
  d = doc(); d.rules[0].id = "F001";
  assert.match(all(d), /id must match \^R/);
});

test("rules source and location need line >= 1", () => {
  const d = doc(); d.rules[0].source.line = 0;
  assert.match(all(d), /rules\[0\]\.source\.line/);
});

test("missing scope.rule_files_not_read or rules array fails", () => {
  let d = doc(); delete d.scope.rule_files_not_read;
  assert.match(all(d), /missing required "rule_files_not_read"/);
  d = doc(); delete d.rules;
  assert.match(all(d), /missing required "rules"/);
});

test("Windows drive-letter path fails", () => {
  const d = doc(); d.bugs[0].reproduction.file = "C:\\Users\\x\\repro.ts";
  assert.match(all(d, fixture(d)), /escapes the output folder/);
  d.bugs[0].reproduction.file = "C:repro.ts";
  assert.match(all(d, fixture(d)), /escapes the output folder/);
});

test("a directory is not accepted as reproduction file or output", () => {
  const d = doc(); d.bugs[0].reproduction.file = "evidence/F001";
  assert.match(all(d, fixture(d)), /is not a file/);
});

test("slug must not start with a dot", () => {
  for (const slug of [".", "..", ".hidden"]) {
    const d = doc(); d.target.slug = slug;
    assert.match(all(d), /target\.slug/);
  }
  assert.match(SCHEMA.properties.target.properties.slug.pattern, /\(\?!\\\.\)/);
});

test("CLI runs through a symlinked skill folder", () => {
  const link = join(mktmp("proof-review-link-"), "skill");
  symlinkSync(new URL("../../skills/proof-review", import.meta.url).pathname, link);
  const script = join(link, "scripts", "validate-findings.mjs");
  const bad = join(fixture({}), "findings.json");
  const r = spawnSync("node", [script, bad], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /INVALID/);
  const ok = spawnSync("node", [script, join(fixture(), "findings.json")], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^OK:/);
});

test("working_tree target passes; wrong slug fails on the slug rule only", () => {
  const d = doc(); d.target = { type: "working_tree", name: "working-tree", slug: "working-tree", base: "aaa", head: null };
  assert.equal(all(d), "");
  d.target.slug = "other";
  assert.equal(validate(d).length, 1);
  assert.match(all(d), /target\.slug: must be working-tree/);
});

test("pr target passes with pr-N slug; fails with another slug", () => {
  const d = doc(); d.target = { type: "pr", name: "#12", slug: "pr-12", base: "aaa", head: "bbb" };
  assert.equal(all(d), "");
  d.target.slug = "feature-x";
  assert.match(all(d), /target\.slug: must match \^pr-/);
});

test("reproduced bug with trace fails; traced bug without trace fails", () => {
  let d = doc(); d.bugs[0].trace = ["a", "b"];
  assert.match(all(d), /bugs\[0\]\.trace: allowed only when evidence is traced/);
  d = doc(); delete d.bugs[1].trace;
  assert.match(all(d), /requires "trace"/);
});

test("single-field mutations fail with the field path", () => {
  const cases = [
    ["$.schema_version", (d) => { d.schema_version = 2; }],
    ["$.generated_at", (d) => { d.generated_at = "yesterday"; }],
    ["$.scope.changed_files", (d) => { d.scope.changed_files = -1; }],
    ["$.scope.changed_lines", (d) => { d.scope.changed_lines = 1.5; }],
    ["$.unrequested[0].files", (d) => { d.unrequested[0].files = []; }],
    ["$.suspicions[0].why_unproven", (d) => { d.suspicions[0].why_unproven = ""; }],
    ["$.bugs[0].location.line", (d) => { d.bugs[0].location.line = 2.5; }],
    ["$.scope.not_reviewed[0].reason", (d) => { delete d.scope.not_reviewed[0].reason; }],
    ["$.bugs[0].impact", (d) => { d.bugs[0].impact = "   "; }],
  ];
  for (const [path, mutate] of cases) {
    const d = doc(); mutate(d);
    const errs = validate(d);
    assert.ok(errs.length > 0, `${path} should fail`);
    assert.ok(errs.some((e) => e.includes(path) || e.includes(path.replace(/\.reason$/, ""))), `${path} not in: ${errs.join("; ")}`);
  }
});

test("CLI exits 2 without arguments and for a nonexistent file", () => {
  assert.equal(spawnSync("node", [SCRIPT], { encoding: "utf8" }).status, 2);
  const r = spawnSync("node", [SCRIPT, join(mktmp("proof-review-none-"), "nope.json")], { encoding: "utf8" });
  assert.equal(r.status, 2);
});

// ---- proofline extensions: run mode, focus, gate, plan deviations, pruned evidence ----

const GATE = new URL("../../skills/proof-review/scripts/gate.mjs", import.meta.url).pathname;
const FP = "b".repeat(40);
// A run document for one focus: base fields plus run, focus, gate, fingerprint.
const runDoc = (focus, parts = {}, gate) => {
  const d = {
    ...doc(), run: { task: "TASK-7" }, focus, fingerprint: FP, plan_deviations: [],
    claims: [], rules: [], unrequested: [], bugs: [], suspicions: [], ...parts,
  };
  if (!["plan", "all"].includes(focus) && !("plan_deviations" in parts)) delete d.plan_deviations;
  d.gate = gate ?? computeGate(d);
  return d;
};
const planClaim = (id, status, extra = {}) => ({
  id, text: `criterion ${id}`, source: "plan", criterion: "AC-1", status,
  locations: status === "missing" ? [] : [loc], ...(status === "partial" ? { missing_part: "the second half" } : {}), ...extra,
});
const deviation = (id = "P001", kind = "new_dependency") => ({ id, kind, subject: "ioredis", location: { file: "package.json", line: 9 }, description: "ioredis is added; PLAN.md names no new dependency." });
const runAll = (d) => [...validate(d), ...checkConsistency(d)].join("\n");

test("a plan-focus run document passes; PASS with only done claims, unrequested and suspicions", () => {
  const d = runDoc("plan", { claims: [planClaim("C001", "done")], unrequested: [{ id: "U001", files: ["src/log.ts"], description: "Outside the plan scope." }], suspicions: [{ id: "S001", location: loc, reason: "r", why_unproven: "w" }] });
  assert.equal(d.gate.result, "PASS");
  assert.equal(runAll(d), "");
});

test("gate: partial or missing claim, rule violation, plan deviation and open bug each fail; fixed bug does not", () => {
  const bug = doc().bugs[1];
  assert.deepEqual(computeGate({ claims: [planClaim("C001", "partial")] }), { result: "FAIL", failing: ["C001"] });
  assert.deepEqual(computeGate({ claims: [planClaim("C002", "missing")] }), { result: "FAIL", failing: ["C002"] });
  assert.deepEqual(computeGate({ rules: doc().rules }), { result: "FAIL", failing: ["R001"] });
  assert.deepEqual(computeGate({ plan_deviations: [deviation("P002", "contract_change")] }), { result: "FAIL", failing: ["P002"] });
  assert.deepEqual(computeGate({ bugs: [bug] }), { result: "FAIL", failing: ["F002"] });
  assert.deepEqual(computeGate({ bugs: [{ ...bug, status: "fixed" }] }), { result: "PASS", failing: [] });
  assert.deepEqual(computeGate({ claims: [planClaim("C001", "done")], suspicions: doc().suspicions, unrequested: doc().unrequested }), { result: "PASS", failing: [] });
  assert.deepEqual(computeGate({}), { result: "PASS", failing: [] });
});

test("a hand-edited gate is rejected", () => {
  const d = runDoc("plan", { claims: [planClaim("C001", "missing")] });
  assert.equal(d.gate.result, "FAIL");
  assert.match(runAll({ ...d, gate: { result: "PASS", failing: [] } }), /gate\.result is PASS but the rule computes FAIL/);
  assert.match(runAll({ ...d, gate: { result: "FAIL", failing: [] } }), /gate\.failing must list exactly the blocking ids: C001/);
});

test("plan deviations: valid record passes and fails the gate; bad kind or id fails", () => {
  const d = runDoc("plan", { plan_deviations: [deviation()] });
  assert.deepEqual(d.gate, { result: "FAIL", failing: ["P001"] });
  assert.equal(runAll(d), "");
  assert.match(runAll(runDoc("plan", { plan_deviations: [{ ...deviation(), kind: "style" }] })), /kind: must be one of new_dependency, contract_change/);
  assert.match(runAll(runDoc("plan", { plan_deviations: [{ ...deviation(), id: "F001" }] })), /id must match \^P/);
  const noSubject = deviation(); delete noSubject.subject;
  assert.match(runAll(runDoc("plan", { plan_deviations: [noSubject] })), /missing required "subject"/);
});

test("focus discipline: each focus may only report its own series", () => {
  assert.match(runAll(runDoc("rules", { claims: [planClaim("C001", "missing")] })), /focus rules must not report claims/);
  assert.match(runAll(runDoc("rules", { bugs: [doc().bugs[1]] })), /focus rules must not report bugs/);
  assert.match(runAll(runDoc("bugs", { rules: doc().rules })), /focus bugs must not report rules/);
  assert.match(runAll(runDoc("bugs", { unrequested: doc().unrequested })), /focus bugs must not report unrequested/);
  assert.match(runAll(runDoc("plan", { bugs: [doc().bugs[1]] })), /focus plan must not report bugs/);
  assert.match(runAll(runDoc("plan", { rules: doc().rules })), /focus plan must not report rules/);
  assert.match(runAll(runDoc("rules+tests", { claims: [planClaim("C001", "done")] })), /focus rules\+tests must not report claims/);
  assert.equal(runAll(runDoc("rules+tests", { rules: doc().rules, bugs: [doc().bugs[1]] })), "");
  assert.match(runAll(runDoc("rules+bugs", { claims: [planClaim("C001", "done")] })), /focus rules\+bugs must not report claims/);
  assert.match(runAll(runDoc("rules+bugs", { plan_deviations: [deviation()] })), /focus rules\+bugs must not report plan_deviations/);
  assert.equal(runAll(runDoc("rules+bugs", { rules: doc().rules, bugs: [doc().bugs[1]] })), "");
  assert.equal(runAll(runDoc("rules", { rules: doc().rules })), "");
  assert.equal(runAll(runDoc("bugs", { bugs: [doc().bugs[1]] })), "");
  assert.equal(runAll(runDoc("all", { claims: [planClaim("C001", "partial")], rules: doc().rules, bugs: [doc().bugs[1]] })), "");
});

test("a run requires focus, gate, fingerprint, and plan_deviations for plan and all", () => {
  for (const k of ["focus", "gate", "fingerprint"]) {
    const d = runDoc("rules"); delete d[k];
    assert.match(runAll(d), new RegExp(`inside a run "${k}" is required`));
  }
  const d = runDoc("plan"); delete d.plan_deviations;
  assert.match(runAll(d), /requires "plan_deviations"/);
  const e = runDoc("all"); delete e.plan_deviations;
  assert.match(runAll(e), /requires "plan_deviations"/);
  assert.match(runAll({ ...runDoc("rules"), focus: "tests" }), /focus: must be one of plan, rules, bugs, rules\+bugs, rules\+tests, all/);
  assert.match(runAll({ ...runDoc("rules"), fingerprint: "xyz" }), /fingerprint: must match/);
});

test("plan claims: criterion required, only inside a run, and every claim in a run comes from the plan", () => {
  const noCrit = planClaim("C001", "done"); delete noCrit.criterion;
  assert.match(runAll(runDoc("plan", { claims: [noCrit] })), /criterion: required and non-empty when source is plan/);
  assert.match(runAll(runDoc("plan", { claims: [{ ...planClaim("C001", "done"), source: "user" }] })), /inside a run every claim comes from the plan/);
  assert.match(runAll(runDoc("plan", { claims: [{ ...planClaim("C001", "done"), source: "user" }] })), /criterion: allowed only when source is plan/);
  const standalone = doc(); standalone.claims[0].source = "plan"; standalone.claims[0].criterion = "AC-1";
  assert.match(all(standalone), /plan is only allowed inside a run/);
});

test("outside a run: no focus or gate needed, and a gate without a focus is rejected", () => {
  assert.equal(all(doc()), "");
  const d = doc(); d.gate = { result: "PASS", failing: [] };
  assert.match(all(d), /\$\.gate: requires "focus"/);
  const e = { ...doc(), focus: "rules", gate: { result: "FAIL", failing: ["R001", "F001", "F002", "C002", "C003"] } };
  assert.equal([...validate(e), ...checkConsistency(e)].filter((x) => /gate/.test(x)).length, 0);
});

test("evidence_pruned: reproduced bugs must carry reproduction.source; existence is not checked, escaping still is", () => {
  const dir = fixture(doc(), { files: [] });
  const d = { ...doc(), evidence_pruned: true };
  assert.match(all(d), /reproduction\.source: required when evidence_pruned/);
  d.bugs[0].reproduction.source = "// repro\ntest('x', () => {});";
  assert.equal(all(d, dir), "");
  d.bugs[0].reproduction.output = "../../etc/hosts";
  assert.match(all(d, dir), /escapes the output folder/);
});

test("without evidence_pruned, a reproduction.source does not replace the files", () => {
  const d = doc(); d.bugs[0].reproduction.source = "x";
  const dir = fixture(d, { files: [] });
  assert.match(all(d, dir), /reproduction file not found/);
});

test("gate.mjs CLI prints PASS or FAIL with ids and exits 0, 1, 2", () => {
  const dir = mktmp("proof-review-gate-");
  const ok = join(dir, "ok.json"), bad = join(dir, "bad.json");
  writeFileSync(ok, JSON.stringify(runDoc("plan", { claims: [planClaim("C001", "done")] })));
  writeFileSync(bad, JSON.stringify(runDoc("plan", { claims: [planClaim("C001", "missing")], plan_deviations: [deviation()] })));
  assert.equal(execFileSync("node", [GATE, ok], { encoding: "utf8" }).trim(), "PASS");
  const r = spawnSync("node", [GATE, bad], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), "FAIL C001 P001");
  assert.equal(spawnSync("node", [GATE], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("node", [GATE, join(dir, "nope.json")], { encoding: "utf8" }).status, 2);
});

test("validator CLI rejects a run document with the wrong gate and accepts the right one", () => {
  const d = runDoc("plan", { claims: [planClaim("C001", "missing")] });
  const bad = join(fixture({ ...d, gate: { result: "PASS", failing: [] } }), "findings.json");
  const r = spawnSync("node", [SCRIPT, bad], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gate\.result is PASS/);
  const ok = spawnSync("node", [SCRIPT, join(fixture(d), "findings.json")], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /gate FAIL/);
});

test("the schema declares the run fields", () => {
  assert.deepEqual(SCHEMA.properties.focus.enum, ["plan", "rules", "bugs", "rules+bugs", "rules+tests", "config", "all"]);
  assert.ok(SCHEMA.properties.gate && SCHEMA.properties.run && SCHEMA.properties.plan_deviations && SCHEMA.properties.evidence_pruned);
  assert.ok(SCHEMA.properties.claims.items.properties.source.enum.includes("plan"));
  assert.ok(SCHEMA.properties.bugs.items.properties.reproduction.properties.source);
  assert.deepEqual(SCHEMA.properties.plan_deviations.items.properties.kind.enum, ["new_dependency", "contract_change"]);
});

test("run output dirs and header focus per focus (rules+bugs reports FOCUS: rules)", () => {
  assert.deepEqual(Object.keys(RUN_DIR).sort(), [...FOCUSES].sort());
  assert.equal(RUN_DIR.plan, "plan");
  assert.equal(RUN_DIR["rules+bugs"], "rules");
  assert.equal(RUN_DIR["rules+tests"], "small");
  assert.equal(HEADER_FOCUS["rules+bugs"], "rules");
  for (const f of ["plan", "rules", "rules+bugs", "rules+tests"]) assert.match(readFileSync(new URL("../../skills/proof-review/SKILL.md", import.meta.url), "utf8"), new RegExp(f.replace("+", "\\+")));
});

// ---- fix round 2: result contract, fingerprint command, plan_deviations vs rules+tests ----

test("focus discipline: rules+tests must not report plan_deviations (kills the FORBIDDEN_BY_FOCUS mutation)", () => {
  assert.match(runAll(runDoc("rules+tests", { plan_deviations: [deviation()] })), /focus rules\+tests must not report plan_deviations/);
  for (const f of ["rules", "bugs", "rules+bugs", "rules+tests"]) assert.ok(FORBIDDEN_BY_FOCUS[f].includes("plan_deviations"), f);
  assert.ok(!FORBIDDEN_BY_FOCUS.plan.includes("plan_deviations") && !FORBIDDEN_BY_FOCUS.all.includes("plan_deviations"));
});

const MD = (p) => readFileSync(new URL(`../../skills/${p}`, import.meta.url), "utf8");
const section = (md, h) => { const i = md.indexOf(`## ${h}`); const j = md.indexOf("\n## ", i + 3); return md.slice(i, j === -1 ? undefined : j); };

test("proof-review SKILL.md result contract: gate row ids, blocking|info, PASS|FAIL|BLOCKED, assigned FOCUS only", () => {
  const md = MD("proof-review/SKILL.md");
  const res = section(md, "Result in a run");
  assert.match(res, /^RESULT: PASS \| FAIL \| BLOCKED$/m);
  assert.match(res, /^FOCUS: plan \| rules \| rules\+tests$/m);
  assert.doesNotMatch(res, /^QUESTIONS:/m);
  const rows = [...res.matchAll(/^\| (\S+) \| (\S+) \|/gm)].map((m) => [m[1], m[2]]).filter(([id]) => id !== "id");
  assert.ok(rows.length >= 3);
  for (const [id, sev] of rows) { assert.match(id, /^REVIEW_(PLAN|RULES|SMALL)-\d+$/); assert.match(sev, /^(blocking|info)$/); }
  assert.match(res, /REVIEW_RULES-2/); assert.match(res, /REVIEW_SMALL-1/);
  assert.match(res, /C002: /); // the internal id lives in the finding text
  // size decision and worktree build failure are BLOCKED, never a question
  assert.match(md, /oversized change is `RESULT: BLOCKED`/);
  assert.match(md, /failing first \(unmodified\) worktree build is `RESULT: BLOCKED`/);
  assert.doesNotMatch(md.replace(/<!-- proofline:shared-rules:begin[\s\S]*?shared-rules:end -->/, ""), /returns? `?(RESULT: )?NEEDS_INPUT|becomes `NEEDS_INPUT`/);
});

// The standalone fingerprint command, taken from the docs and run in a repository where .agents/local/
// exists and is ignored by its own .gitignore ("*") and .agents/runs/ by the project's.
const FP_DOCS = ["proof-review/SKILL.md", "proof-review/references/BUGS.md", "proof-review/references/TARGET.md", "test-trust/SKILL.md"];
const docCommand = (md) => /(d=\$\(mktemp -d\); cp [^\n`]*write-tree; rm -f "\$d\/index"; rmdir "\$d")/.exec(md)?.[1];

test("docs: no exclude pathspec in any tree-id or fingerprint command", () => {
  for (const p of FP_DOCS) { const md = MD(p); assert.doesNotMatch(md, /:\(exclude\)\.agents/, p); assert.ok(docCommand(md), `${p} has the temporary-index command`); }
});

test("fingerprint command works where .agents/local/ exists and is ignored, and ignores its content", () => {
  const repo = mkdtempSync(join(tmpdir(), "pr-fp-"));
  const sh = (cmd) => spawnSync("sh", ["-c", cmd], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  sh("git init -q -b main && git config user.email t@example.invalid && git config user.name t");
  mkdirSync(join(repo, ".agents/local"), { recursive: true }); mkdirSync(join(repo, ".agents/runs/T-1"), { recursive: true });
  writeFileSync(join(repo, ".agents/local/.gitignore"), "*\n"); writeFileSync(join(repo, ".gitignore"), ".agents/runs/\n");
  writeFileSync(join(repo, "a.txt"), "one\n"); writeFileSync(join(repo, ".agents/local/state"), "x\n"); writeFileSync(join(repo, ".agents/runs/T-1/RUN.yaml"), "x\n");
  sh("git add -A && git commit -qm base");
  const old = `d=$(mktemp -d); cp "$(git rev-parse --git-path index)" "$d/index" 2>/dev/null; GIT_INDEX_FILE="$d/index" git add -A -- . ':(exclude).agents/runs' ':(exclude).agents/local' && GIT_INDEX_FILE="$d/index" git write-tree; rm -f "$d/index"; rmdir "$d"`;
  assert.equal(sh(old).stdout.trim(), "", "the excluded-pathspec form fails in such a repository (the reason it was dropped)");
  const ids = new Set();
  for (const p of FP_DOCS) {
    const r = sh(docCommand(MD(p)));
    assert.equal(r.status, 0, `${p}: ${r.stderr}`); assert.match(r.stdout.trim(), /^[0-9a-f]{40,64}$/, p); ids.add(r.stdout.trim());
  }
  assert.equal(ids.size, 1);
  const [id] = ids;
  assert.equal(sh("git rev-parse 'HEAD^{tree}'").stdout.trim(), id, "the tree equals the committed tree: nothing under .agents/ entered it");
  writeFileSync(join(repo, ".agents/local/state"), "changed\n"); writeFileSync(join(repo, ".agents/runs/T-1/RUN.yaml"), "changed\n");
  assert.equal(sh(docCommand(MD(FP_DOCS[0]))).stdout.trim(), id, "ignored proofline state does not change it");
  writeFileSync(join(repo, "b.txt"), "new\n");
  assert.notEqual(sh(docCommand(MD(FP_DOCS[0]))).stdout.trim(), id, "an untracked file does");
  assert.equal(sh("git status --porcelain").stdout.trim(), "?? b.txt", "the real index is untouched");
  rmSync(repo, { recursive: true, force: true });
});

// ---- A153: a blocking unrequested hunk inside the plan scope fails the plan gate ----
const blockU = { id: "U002", files: ["src/cache.ts"], description: "Adds a cache TTL nobody asked for.", blocking: true };

test("a blocking unrequested record fails the gate and lists its id; the run document is valid", () => {
  const d = runDoc("plan", { claims: [planClaim("C001", "done")], unrequested: [blockU] });
  assert.deepEqual(d.gate, { result: "FAIL", failing: ["U002"] });
  assert.equal(runAll(d), "");
  assert.deepEqual(computeGate({ unrequested: [{ id: "U001", files: ["a.ts"], description: "d" }, blockU] }), { result: "FAIL", failing: ["U002"] });
});

test("informational unrequested records (no blocking mark) stay PASS", () => {
  const info = ["formatting only", "comment reworded", "import order", "doubtful whether it changes behaviour"]
    .map((description, i) => ({ id: `U00${i + 1}`, files: ["src/a.ts"], description }));
  const d = runDoc("plan", { claims: [planClaim("C001", "done")], unrequested: info });
  assert.deepEqual(d.gate, { result: "PASS", failing: [] });
  assert.equal(runAll(d), "");
});

test("blocking: false is rejected, and blocking outside a run is rejected", () => {
  assert.match(runAll(runDoc("plan", { unrequested: [{ ...blockU, blocking: false }] })), /unrequested\[0\]\.blocking.*must be true when present/);
  const plain = doc(); plain.unrequested = [{ ...blockU }];
  assert.match(validate(plain).join("\n"), /unrequested\[0\]\.blocking.*allowed only inside a proofline run/);
});
