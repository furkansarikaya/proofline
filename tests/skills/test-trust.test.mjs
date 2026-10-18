import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { validate, missingEvidence, checkConsistency, checkClaims } from "../../skills/test-trust/scripts/validate-findings.mjs";
import { thresholds, computeGate, minMutants } from "../../skills/test-trust/scripts/gate.mjs";

const SCRIPT = new URL("../../skills/test-trust/scripts/validate-findings.mjs", import.meta.url).pathname;
const schema = JSON.parse(readFileSync(new URL("../../skills/test-trust/schema/findings.schema.json", import.meta.url)));

const hollow = () => ({
  id: "F001", kind: "hollow", verdict: "confirmed", source_commit: "abc123",
  test: { file: "billing/refund_test.go", name: "TestRefund" },
  evidence: [{ path: "evidence/hollow-refund-m1.out", command: "go test ./billing -run '^TestRefund$' -count=1" }],
  observed: {
    unit: "billing/refund.go:Refund", covering_tests: ["TestRefund"],
    surviving_mutants: [{ diff_path: "evidence/hollow-refund-m1.diff", summary: "return 0" }],
  },
});
const doc = (...findings) => ({ scope: { slug: "billing", paths: ["billing/"], commit: "abc123" }, findings });

test("valid document passes", () => {
  assert.deepEqual(validate(schema, doc(hollow())), []);
});

test("needs_validation requires missing, others forbid it", () => {
  assert.match(validate(schema, doc({ ...hollow(), verdict: "needs_validation" })).join(), /missing required "missing"/);
  assert.match(validate(schema, doc({ ...hollow(), verdict: "cleared", missing: "x" })).join(), /missing: not allowed/);
});

test("confirmed flaky needs a pass and a fail", () => {
  const f = { ...hollow(), kind: "flaky_nondeterministic", observed: { passes: 20, fails: 0, runs: 20, stage: "isolated" } };
  assert.match(validate(schema, doc(f)).join(), /fails: less than 1/);
});

test("flaky_unclassified is confirmed with missing, and still needs a pass and a fail", () => {
  const f = {
    ...hollow(), kind: "flaky_unclassified", missing: "single-test selection unsupported",
    observed: { passes: 3, fails: 2, runs: 5, stage: "suite" },
  };
  assert.deepEqual(validate(schema, doc(f)), []);
  const { missing, ...noMissing } = f;
  assert.match(validate(schema, doc(noMissing)).join(), /missing required "missing"/);
  assert.match(validate(schema, doc({ ...f, observed: { passes: 5, fails: 0, runs: 5, stage: "suite" } })).join(), /fails: less than 1/);
});

test("confirmed needs evidence; hollow needs a survivor", () => {
  assert.match(validate(schema, doc({ ...hollow(), evidence: [] })).join(), /at least 1/);
  const h = hollow(); h.observed.surviving_mutants = [];
  assert.match(validate(schema, doc(h)).join(), /surviving_mutants: needs at least 1/);
});

test("CLI checks evidence files exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-"));
  const file = join(dir, "findings.json");
  writeFileSync(file, JSON.stringify(doc(hollow())));
  assert.equal(missingEvidence(doc(hollow()), dir).length, 2);
  assert.throws(() => execFileSync("node", [SCRIPT, file], { stdio: "pipe" }), (e) => e.status === 1);
  mkdirSync(join(dir, "evidence"));
  writeFileSync(join(dir, "evidence/hollow-refund-m1.out"), "");
  writeFileSync(join(dir, "evidence/hollow-refund-m1.diff"), "");
  assert.match(execFileSync("node", [SCRIPT, file]).toString(), /^VALID/);
});

test("absolute and parent-relative evidence paths escape the output folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-"));
  const f = hollow();
  f.evidence = [{ path: "/etc/hosts" }, { path: "../../etc/hosts" }];
  f.observed.surviving_mutants = [{ diff_path: "/etc/hosts" }, { diff_path: "../../etc/hosts" }];
  const errors = missingEvidence(doc(f), dir);
  assert.equal(errors.length, 4);
  assert.ok(errors.every((error) => error.includes("escapes the output folder")));
});

// ---- proofline extensions: diff mode, gate, thresholds, pruned evidence ----

const GATE = new URL("../../skills/test-trust/scripts/gate.mjs", import.meta.url).pathname;
const flaky = () => ({
  id: "F002", kind: "flaky_nondeterministic", verdict: "confirmed", source_commit: null,
  test: { file: "checkout_test.go", name: "TestBackoff" },
  evidence: [{ path: "evidence/flaky-backoff.out", command: "go test -run '^TestBackoff$' -count=1" }],
  observed: { passes: 3, fails: 2, runs: 5, stage: "isolated" },
});
const slow = (ratio = 40) => ({
  id: "F003", kind: "slow", verdict: "confirmed", source_commit: null,
  test: { file: "checkout_test.go", name: "TestReconcile" },
  evidence: [{ path: "evidence/slow.out", command: "go test -json" }],
  observed: { mean_ms: 1000, runs_ms: [1000, 1001], median_ms: 25, ratio_to_median: ratio, share_of_total: 0.9 },
});
const diffDoc = (gate, ...findings) => ({
  mode: "diff", fingerprint: "a".repeat(40), evidence_pruned: true, gate,
  scope: {
    slug: "diff", paths: ["."], commit: "abc123",
    diff: {
      base: "abc123", thresholds: { repeat: 5, mutation_budget: 20, slow_ratio: 3 },
      changed_units: ["shop.go:NormalizeEmail"], tests: ["TestNormalizeEmail", "TestBackoff"], mutants_run: 4, not_examined: [],
    },
  },
  findings,
});
const diffErrors = (d) => [...validate(schema, d), ...checkConsistency(d)].join("\n");

test("full mode documents stay valid without mode, gate or diff scope", () => {
  assert.deepEqual(validate(schema, doc(hollow())), []);
  assert.deepEqual(checkConsistency(doc(hollow())), []);
  assert.deepEqual(validate(schema, { ...doc(hollow()), mode: "full" }), []);
});

test("gate: confirmed flaky or hollow fails; slow, needs_validation and cleared never do", () => {
  assert.deepEqual(computeGate([flaky()]), { result: "FAIL", failing: ["F002"] });
  assert.deepEqual(computeGate([hollow()]), { result: "FAIL", failing: ["F001"] });
  assert.deepEqual(computeGate([{ ...flaky(), kind: "flaky_unclassified" }]).result, "FAIL");
  assert.deepEqual(computeGate([slow(), { ...hollow(), verdict: "needs_validation" }, { ...flaky(), verdict: "cleared" }]), { result: "PASS", failing: [] });
  assert.deepEqual(computeGate([]), { result: "PASS", failing: [] });
});

test("diff document with a correct gate passes; PASS with only a slow finding passes", () => {
  const h = { ...hollow(), observed: { ...hollow().observed, unit: "shop.go:NormalizeEmail" } };
  assert.equal(diffErrors(diffDoc({ result: "FAIL", failing: ["F001", "F002"] }, h, flaky())), "");
  assert.equal(diffErrors(diffDoc({ result: "PASS", failing: [] }, slow())), "");
});

test("a hand-written gate that disagrees with the rule is rejected", () => {
  assert.match(diffErrors(diffDoc({ result: "PASS", failing: [] }, flaky())), /gate\.result is PASS but the rule computes FAIL/);
  assert.match(diffErrors(diffDoc({ result: "FAIL", failing: [] }, flaky())), /gate\.failing must list exactly/);
  assert.match(diffErrors(diffDoc({ result: "FAIL", failing: ["F003"] }, slow())), /gate\.result is FAIL but the rule computes PASS/);
});

test("diff mode requires gate, fingerprint and scope.diff; full mode forbids gate and scope.diff", () => {
  const d = diffDoc({ result: "PASS", failing: [] });
  const { gate, ...noGate } = d;
  assert.match(diffErrors(noGate), /missing required "gate"/);
  const { fingerprint, ...noFp } = d;
  assert.match(diffErrors(noFp), /missing required "fingerprint"/);
  const noDiff = structuredClone(d); delete noDiff.scope.diff;
  assert.match(diffErrors(noDiff), /missing required "diff"/);
  assert.match(diffErrors({ ...doc(hollow()), gate }), /gate: not allowed/);
  const full = doc(hollow()); full.scope.diff = d.scope.diff;
  assert.match(diffErrors(full), /diff: not allowed/);
});

test("diff mode: hollow only on changed units, mutants within budget, slow above slow_ratio", () => {
  assert.match(diffErrors(diffDoc({ result: "FAIL", failing: ["F001"] }, hollow())), /not a changed unit/);
  const over = diffDoc({ result: "PASS", failing: [] }); over.scope.diff.mutants_run = 21;
  assert.match(diffErrors(over), /exceeds mutation_budget 20/);
  assert.match(diffErrors(diffDoc({ result: "PASS", failing: [] }, slow(2))), /does not exceed slow_ratio 3/);
});

test("diff mode rejects out-of-range thresholds and carried_forward findings", () => {
  const d = diffDoc({ result: "PASS", failing: [] }); d.scope.diff.thresholds.repeat = 1;
  assert.match(diffErrors(d), /repeat: less than 2/);
  const e = diffDoc({ result: "PASS", failing: [] }); e.scope.diff.thresholds.slow_ratio = 1;
  assert.match(diffErrors(e), /slow_ratio: not greater than 1/);
  assert.match(diffErrors(diffDoc({ result: "FAIL", failing: ["F002"] }, { ...flaky(), carried_forward: true })), /carried_forward is not allowed/);
});

test("duplicate finding ids are rejected in every mode", () => {
  assert.match(checkConsistency(doc(hollow(), hollow())).join(), /F001: duplicate finding id/);
});

test("thresholds: defaults without a config, values from the test_trust block, invalid values fall back", () => {
  assert.deepEqual(thresholds(""), { repeat: 5, mutation_budget: 20, slow_ratio: 3, notes: [] });
  const yaml = "canonical_branch: main\ntest_trust:\n  repeat: 8   # more runs\n  mutation_budget: 12\n  slow_ratio: 2.5\nbudgets:\n  repeat: 99\n";
  assert.deepEqual(thresholds(yaml), { repeat: 8, mutation_budget: 12, slow_ratio: 2.5, notes: [] });
  const bad = thresholds("test_trust:\n  repeat: 1\n  mutation_budget: lots\n  slow_ratio: 1\n");
  assert.deepEqual([bad.repeat, bad.mutation_budget, bad.slow_ratio], [5, 20, 3]);
  assert.equal(bad.notes.length, 3);
  assert.deepEqual(thresholds("test_trust:\n  repeat: 4\n").mutation_budget, 20);
});

test("gate.mjs CLI: thresholds from a file, gate exit codes, usage error", () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-gate-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, "test_trust:\n  repeat: 7\n");
  assert.equal(execFileSync("node", [GATE, "thresholds", cfg]).toString(), "repeat=7\nmutation_budget=20\nslow_ratio=3\n");
  assert.equal(execFileSync("node", [GATE, "thresholds", join(dir, "absent.yaml")]).toString(), "repeat=5\nmutation_budget=20\nslow_ratio=3\n");
  const pass = join(dir, "pass.json"), fail = join(dir, "fail.json");
  writeFileSync(pass, JSON.stringify(doc(slow())));
  writeFileSync(fail, JSON.stringify(doc(flaky())));
  assert.equal(execFileSync("node", [GATE, "gate", pass]).toString().trim(), "PASS");
  assert.throws(() => execFileSync("node", [GATE, "gate", fail], { stdio: "pipe" }), (e) => e.status === 1 && /FAIL F002/.test(e.stdout.toString()));
  assert.throws(() => execFileSync("node", [GATE], { stdio: "pipe" }), (e) => e.status === 2);
});

test("evidence_pruned skips the existence check but still rejects escaping paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-"));
  const d = { ...doc(hollow()), evidence_pruned: true };
  assert.deepEqual(missingEvidence(d, dir), []);
  const f = hollow(); f.evidence = [{ path: "../../etc/hosts", command: "x" }];
  assert.match(missingEvidence({ ...d, findings: [f] }, dir).join(), /escapes the output folder/);
  assert.equal(missingEvidence(doc(hollow()), dir).length, 2);
});

test("validator CLI rejects a diff document whose gate was edited, and runs through a symlinked skill folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-"));
  const file = join(dir, "findings.json");
  writeFileSync(file, JSON.stringify(diffDoc({ result: "PASS", failing: [] }, flaky())));
  const r = spawnSync("node", [SCRIPT, file], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gate\.result is PASS but the rule computes FAIL/);
  writeFileSync(file, JSON.stringify(diffDoc({ result: "FAIL", failing: ["F002"] }, flaky())));
  const link = join(mkdtempSync(join(tmpdir(), "tt-link-")), "skill");
  symlinkSync(new URL("../../skills/test-trust", import.meta.url).pathname, link);
  const ok = spawnSync("node", [join(link, "scripts", "validate-findings.mjs"), file], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^VALID/);
});

test("the schema declares the diff-mode fields", () => {
  assert.deepEqual(schema.properties.mode.enum, ["full", "diff"]);
  assert.ok(schema.properties.gate && schema.properties.evidence_pruned && schema.properties.fingerprint);
  assert.ok(schema.properties.scope.properties.diff.required.includes("thresholds"));
});

test("run output dirs: tests/ for the gate, qa/ for the QA role (never a gate artifact)", () => {
  const md = readFileSync(new URL("../../skills/test-trust/SKILL.md", import.meta.url), "utf8");
  assert.match(md, /reviews\/test-trust\/tests\//);
  assert.match(md, /reviews\/test-trust\/qa\/[^\n]*never a gate artifact/);
  assert.match(md, /ARTIFACT: reviews\/test-trust\/tests\/REPORT\.md/);
  assert.doesNotMatch(md, /ARTIFACT: reviews\/test-trust\/REPORT\.md/);
});

// ---- fix round 2: quoted config numbers, result contract, QA use ----

test("thresholds: quoted numbers in config are parsed (repeat: \"7\", 'mutation_budget': '9')", () => {
  const t = thresholds('test_trust:\n  repeat: "7"\n  mutation_budget: \'9\'\n  slow_ratio: "2.5"   # quoted\n');
  assert.deepEqual(t, { repeat: 7, mutation_budget: 9, slow_ratio: 2.5, notes: [] });
  const bad = thresholds('test_trust:\n  repeat: "1"\n  mutation_budget: "lots"\n  slow_ratio: "1"\n');
  assert.deepEqual([bad.repeat, bad.mutation_budget, bad.slow_ratio], [5, 20, 3]);
  assert.equal(bad.notes.length, 3);
  assert.equal(thresholds('test_trust:\n  repeat: "7\n').repeat, 5); // an unbalanced quote is invalid, not parsed
});

test("gate.mjs CLI prints quoted thresholds", () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-q-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, 'test_trust:\n  repeat: "7"\n');
  const gate = new URL("../../skills/test-trust/scripts/gate.mjs", import.meta.url).pathname;
  assert.equal(execFileSync("node", [gate, "thresholds", cfg]).toString(), "repeat=7\nmutation_budget=20\nslow_ratio=3\n");
});

test("SKILL.md result contract: REVIEW_TESTS rows, blocking|info, PASS|FAIL|BLOCKED, QA use has no result of its own", () => {
  const md = readFileSync(new URL("../../skills/test-trust/SKILL.md", import.meta.url), "utf8");
  const i = md.indexOf("## Result in a run");
  const res = md.slice(i);
  assert.match(res, /^FOCUS: tests$/m);
  assert.match(res, /^RESULT: PASS \| FAIL \| BLOCKED$/m);
  assert.doesNotMatch(res, /^QUESTIONS:/m);
  const rows = [...res.matchAll(/^\| (\S+) \| (\S+) \|/gm)].map((m) => [m[1], m[2]]).filter(([id]) => id !== "id");
  assert.ok(rows.length >= 2);
  for (const [id, sev] of rows) { assert.match(id, /^REVIEW_TESTS-\d+$/); assert.match(sev, /^(blocking|info)$/); }
  assert.match(res, /F002: flaky_nondeterministic/); // internal id inside the finding text
  assert.match(res, /never `NEEDS_INPUT` or `DONE`/);
  assert.match(md, /\*\*QA use\*\*[^\n]*no result header[^\n]*no `FOCUS` and no `RESULT` of its own[^\n]*QA_REPORT\.md/);
  assert.match(res, /In the QA use there is no such message/);
  const noShared = md.replace(/<!-- proofline:shared-rules:begin[\s\S]*?shared-rules:end -->/, "");
  assert.doesNotMatch(noShared, /becomes `RESULT: NEEDS_INPUT`|is `NEEDS_INPUT` inside a run|`NEEDS_INPUT` with the estimate/);
  assert.match(readFileSync(new URL("../../skills/test-trust/references/DIFF.md", import.meta.url), "utf8"), /first-build failure is `BLOCKED` inside a run/);
});

// ---- A59: claim mutants (the named test must observe its criterion) ----
const withClaims = (claims, gate = { result: "PASS", failing: [] }) => {
  const d = diffDoc(gate);
  d.scope.diff.claims = claims;
  return d;
};
const PLAN_TESTS = "# Plan\n\n## Tests\n\n- AC-8: `tests/tags.test.js` \"deleting a book removes its tag links\"\n- AC-2: `tests/tags.test.js` \"filters by tag\"\n\n## Verification commands\n\n- npm test\n";
const claim = (ac, over = {}) => ({ ac, test: "t", mutant: "drops the cascade without an error", outcome: "killed", failure: "assertion", killed_by: ["t"], ...over });
test("claims: the schema accepts them and every proven claim passes", () => {
  const d = withClaims([claim("AC-8"), claim("AC-2")]);
  assert.deepEqual(validate(schema, d), []);
  assert.deepEqual(checkClaims(d, PLAN_TESTS), []);
});
test("claims: a kill by an error is not a kill, and an unproven claim needs a failing gate", () => {
  const byError = withClaims([claim("AC-8", { failure: "error" }), claim("AC-2")]);
  assert.match(checkClaims(byError, PLAN_TESTS).join("\n"), /AC-8: a kill by error is not a kill of the claim/);
  const survived = withClaims([claim("AC-8", { outcome: "survived", failure: "none", killed_by: [] }), claim("AC-2")]);
  assert.match(checkClaims(survived, PLAN_TESTS).join("\n"), /AC-8: the claim is not proven/);
  const failed = withClaims([claim("AC-8", { outcome: "survived", failure: "none", killed_by: [] }), claim("AC-2")], { result: "FAIL", failing: ["F004"] });
  assert.deepEqual(checkClaims(failed, PLAN_TESTS), []);
});
test("claims: every criterion of PLAN ## Tests needs a claim", () => {
  const d = withClaims([claim("AC-2")]);
  assert.match(checkClaims(d, PLAN_TESTS).join("\n"), /AC-8: PLAN ## Tests names a test for it but findings.json has no claim mutant/);
  assert.deepEqual(checkClaims(d, undefined), []);
});

// The evidence run: 33 criteria in PLAN ## Tests against mutation_budget 20 blocked REVIEW_TESTS twice.
test("mutation_budget: never below one mutant per criterion (validator and thresholds CLI)", () => {
  const acs = Array.from({ length: 33 }, (_, i) => `- AC-${i + 1}: \`t.test.js\` "t${i + 1}"`).join("\n");
  const plan = `## Tests\n\n${acs}\n\n## Verification commands\n\n- npm test\n`;
  assert.equal(minMutants(plan), 33);
  const d = withClaims(Array.from({ length: 33 }, (_, i) => claim(`AC-${i + 1}`)));
  assert.match(checkClaims(d, plan).join("\n"), /mutation_budget 20 is below the 33 criteria/);
  const run = mkdtempSync(join(tmpdir(), "tt-run-"));
  writeFileSync(join(run, "PLAN.md"), plan);
  const out = (...a) => execFileSync("node", [GATE, "thresholds", join(run, "none.yaml"), ...a], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  assert.match(out(run), /mutation_budget=33\n/);
  writeFileSync(join(run, "mutation_budget"), "40\n");
  assert.match(out(run), /mutation_budget=33\n/, "an override file without its ledger row is ignored");
  writeFileSync(join(run, "LEDGER.log"), "seq=9 prev=x event=raise-budget role=lead from=- to=- digest=x ts=t epoch=1 detail=test_trust.mutation_budget 40 for this run, approval 001\n");
  assert.match(out(run), /mutation_budget=40\n/);
  assert.match(out(), /mutation_budget=20\n/);
});
