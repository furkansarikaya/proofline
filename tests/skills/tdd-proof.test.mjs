import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const skill = join(dirname(fileURLToPath(import.meta.url)), "../../skills/tdd-proof");
const vScript = join(skill, "scripts/validate-tdd.mjs");
const cScript = join(skill, "scripts/classify-red.mjs");
const { validate } = await import(vScript);
const { classify } = await import(cScript);

// Realistic runner output signatures, per ecosystem.
const SAMPLES = {
  assertion: {
    node: "not ok 1 - parses\n  error: |-\n    Expected values to be strictly equal:\n    0 !== 90000\n  code: 'ERR_ASSERTION'\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal",
    jest: "  expect(received).toBe(expected) // Object.is equality\n\n  Expected: 90000\n  Received: 0",
    pytest: "    def test_x():\n>       assert parse('90s') == 90000\nE       assert 0 == 90000",
    go: "--- FAIL: TestParse (0.00s)\n    parse_test.go:12: got 0, want 90000\nFAIL\nFAIL\texample/parse\t0.003s",
    cargo: "thread 'parse' panicked at src/lib.rs:9:5:\nassertion `left == right` failed\n  left: 0\n right: 90000",
    dotnet: "  Failed ParseTests.Parses [3 ms]\n  Error Message:\n   Assert.Equal() Failure: Values differ\n   Expected: 90000\n   Actual:   0",
    java: "org.opentest4j.AssertionFailedError: expected: <90000> but was: <0>",
    ruby: "Failure:\nParseTest#test_parses\nExpected: 90000\n  Actual: 0",
    phpunit: "Failed asserting that 0 matches expected 90000.",
  },
  syntax: { node: "SyntaxError: Unexpected token '}'", python: "  File \"t.py\", line 3\nIndentationError: unexpected indent", go: "./a_test.go:4:2: syntax error: unexpected }" },
  compile: {
    ts: "src/parse.test.ts(3,10): error TS2305: Module './parse' has no exported member 'parseDuration'.",
    go: "# example/parse [example/parse.test]\n./parse_test.go:9:9: undefined: ParseDuration\nFAIL example/parse [build failed]",
    cargo: "error[E0425]: cannot find function `parse_duration` in this scope\nerror: could not compile `x`",
    dotnet: "ParseTests.cs(10,20): error CS0103: The name 'ParseDuration' does not exist\nBuild FAILED.",
    java: "[ERROR] COMPILATION ERROR :\n[ERROR] cannot find symbol",
  },
  import: {
    node: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/p/src/parse.js' imported from /p/test.js",
    python: "ModuleNotFoundError: No module named 'parse'",
    ruby: "cannot load such file -- parse (LoadError)",
    vitest: "Error: Failed to resolve import \"./parse\" from \"test.js\". Does the file exist?",
  },
  missing_file: { node: "Error: ENOENT: no such file or directory, open 'fixtures/a.json'", python: "FileNotFoundError: [Errno 2] No such file or directory: 'a.json'" },
  no_tests: { pytest: "collected 0 items\n\n============ no tests ran in 0.01s ============", go: "ok  \texample/parse\t0.002s [no tests to run]", node: "ℹ tests 0\nℹ pass 0", dotnet: "No test is available in /p/bin/Tests.dll" },
  setup_crash: { pytest: "ERROR at setup of test_parse\nE   fixture 'db' not found", mocha: "1) \"before each\" hook for \"parses\":", jest: "Test suite failed to run" },
  timeout: { mocha: "Error: Timeout of 2000ms exceeded", node: "test timed out after 30000ms" },
  crash: { node: "TypeError: parseDuration is not a function\n    at Object.<anonymous> (test.js:3:1)", python: "Traceback (most recent call last):\n  File \"t.py\", line 2\nNameError: name 'parse' is not defined" },
};

for (const [cls, byEco] of Object.entries(SAMPLES)) {
  for (const [eco, out] of Object.entries(byEco)) {
    test(`classify: ${cls} (${eco})`, () => assert.equal(classify(out).class, cls));
  }
}
test("classify: only assertion is a valid RED", () => {
  assert.equal(classify(SAMPLES.assertion.node).red_valid, true);
  assert.equal(classify(SAMPLES.compile.go).red_valid, false);
});
test("classify: assertion text mentioning a TypeError is still an assertion", () => {
  assert.equal(classify("AssertionError: expected TypeError to be thrown").class, "assertion");
});
test("classify: a compile error beside an assertion is not RED", () => {
  assert.equal(classify(`${SAMPLES.assertion.pytest}\n${SAMPLES.import.python}`).class, "import");
});
test("classify: empty and unrecognised output is unknown, not RED", () => {
  assert.equal(classify("").class, "unknown");
  assert.equal(classify("something happened").red_valid, false);
});
test("classify CLI: exit 0 for assertion, 1 otherwise, 2 on bad usage; stdin and --file", () => {
  assert.equal(spawnSync("node", [cScript], { input: SAMPLES.assertion.jest }).status, 0);
  assert.equal(spawnSync("node", [cScript], { input: SAMPLES.import.python }).status, 1);
  const f = join(mkdtempSync(join(tmpdir(), "tdd-")), "o.txt");
  writeFileSync(f, SAMPLES.assertion.go);
  const r = spawnSync("node", [cScript, "--file", f]);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout.toString()).class, "assertion");
  assert.equal(spawnSync("node", [cScript, "--bogus"]).status, 2);
});

const good = () => ({
  schema_version: 1, mode: "team", task: "T-1",
  cycles: [{
    path: "src/parse.js", criterion: "AC-1",
    test: { file: "test/parse.test.js", name: "parses seconds" },
    red: { command: "node --test test/parse.test.js", exit_code: 1, failure_class: "assertion", expected_failure: "parseDuration('90s') returns 0 instead of 90000", output_excerpt: SAMPLES.assertion.node, stub_written: true },
    green: { command: "node --test test/parse.test.js", exit_code: 0, suite_command: "node --test", suite_exit_code: 0 },
    hollow_check: { method: "revert", worktree: "/tmp/wt-1", command: "node --test test/parse.test.js", exit_code: 1, output_excerpt: SAMPLES.assertion.node, failed_for_expected_reason: true },
    refactor: { changes: "extract unit table", command: "node --test", exit_code: 0 },
  }],
  exemptions: [{ path: "docs/guide.md", reason: "documentation only, no executable behaviour" }],
});
const errs = (d, o = {}) => validate(d, o);
const has = (e, s) => assert.ok(e.some((x) => x.includes(s)), `expected "${s}" in ${JSON.stringify(e)}`);

test("validate: accepts a good ledger and full scope coverage", () => {
  assert.deepEqual(errs(good(), { scope: ["src/parse.js", "docs/guide.md"] }), []);
});
test("validate: RED with a compile error is rejected", () => {
  const d = good(); d.cycles[0].red.failure_class = "compile"; d.cycles[0].red.output_excerpt = SAMPLES.compile.ts;
  const e = errs(d); has(e, "not RED"); has(e, "classifies as compile");
});
test("validate: failure_class claiming assertion over an import error excerpt is caught", () => {
  const d = good(); d.cycles[0].red.output_excerpt = SAMPLES.import.node; has(errs(d), "classifies as import");
});
test("validate: RED exit 0 rejected", () => {
  const d = good(); d.cycles[0].red.exit_code = 0; has(errs(d), "exit non-zero");
});
test("validate: stock or short expected_failure rejected", () => {
  for (const s of ["test fails", "not implemented", "assertion failed", "short"]) {
    const d = good(); d.cycles[0].red.expected_failure = s; has(errs(d), "expected_failure");
  }
});
test("validate: GREEN must use the RED command, exit 0, suite green", () => {
  const d = good(); d.cycles[0].green.command = "node --test"; d.cycles[0].green.exit_code = 1; d.cycles[0].green.suite_exit_code = 2;
  const e = errs(d); has(e, "same command"); has(e, "GREEN must exit 0"); has(e, "suite must exit 0");
});
test("validate: hollow test (still passes without the change) rejected", () => {
  const d = good(); d.cycles[0].hollow_check.exit_code = 0; has(errs(d), "hollow test");
});
test("validate: hollow check inconclusive (compile error) or unconfirmed reason rejected", () => {
  const d = good(); d.cycles[0].hollow_check.output_excerpt = SAMPLES.compile.go; d.cycles[0].hollow_check.failed_for_expected_reason = false;
  const e = errs(d); has(e, "classifies as compile"); has(e, "failed_for_expected_reason");
});
test("validate: hollow check needs an absolute worktree and a method", () => {
  const d = good(); d.cycles[0].hollow_check.worktree = "wt"; d.cycles[0].hollow_check.method = "skip";
  const e = errs(d); has(e, "absolute worktree"); has(e, "revert or mutate");
});
test("validate: missing hollow_check rejected", () => {
  const d = good(); delete d.cycles[0].hollow_check; has(errs(d), "hollow_check");
});
test("validate: refactor with failing tests rejected; null refactor allowed", () => {
  const d = good(); d.cycles[0].refactor.exit_code = 1; has(errs(d), "refactor only with tests green");
  const e = good(); e.cycles[0].refactor = null; assert.deepEqual(errs(e), []);
});
test("validate: scope path without cycle or exemption, and out-of-scope cycle, rejected", () => {
  has(errs(good(), { scope: ["src/parse.js", "docs/guide.md", "src/other.js"] }), "neither a cycle nor an exemption");
  has(errs(good(), { scope: ["docs/guide.md"] }), "outside the scope");
});
test("validate: exemption needs a specific reason", () => {
  const d = good(); d.exemptions[0].reason = "n/a"; has(errs(d), "exemptions[0].reason");
});
test("validate: path in both a cycle and an exemption, duplicate cycles, traversal rejected", () => {
  const d = good(); d.exemptions[0].path = "src/parse.js"; has(errs(d), "both a cycle and an exemption");
  const e = good(); e.cycles.push(structuredClone(e.cycles[0])); has(errs(e), "duplicate cycle");
  const f = good(); f.cycles[0].path = "../x"; has(errs(f), "repo-relative");
});
test("validate: unknown keys rejected", () => {
  const d = good(); d.x = 1; has(errs(d), "unexpected");
});
test("validate CLI exit codes", () => {
  const f = join(mkdtempSync(join(tmpdir(), "tdd-")), "tdd.json");
  writeFileSync(f, JSON.stringify(good()));
  assert.equal(spawnSync("node", [vScript, f, "--scope", "src/parse.js,docs/guide.md"]).status, 0);
  assert.equal(spawnSync("node", [vScript, f, "--scope", "src/parse.js,src/new.js"]).status, 1);
  assert.equal(spawnSync("node", [vScript]).status, 2);
});
test("SKILL.md frontmatter and schema", () => {
  const t = readFileSync(join(skill, "SKILL.md"), "utf8");
  assert.match(t, /^---\nname: tdd-proof\n/);
  assert.ok(t.split("\n").length < 500);
  JSON.parse(readFileSync(join(skill, "schema/tdd.schema.json"), "utf8"));
});
test("validate CLI reads the fenced json block of a .md result", () => {
  const dir = mkdtempSync(join(tmpdir(), "tdd-"));
  const m = join(dir, "r.md");
  writeFileSync(m, `ROLE: implementer\n\n\`\`\`json\n${JSON.stringify(good())}\n\`\`\`\n`);
  assert.equal(spawnSync("node", [vScript, m]).status, 0);
  writeFileSync(m, "nothing");
  assert.equal(spawnSync("node", [vScript, m]).status, 2);
});

test("validate: one cycle per criterion; a path may have several cycles, one for each criterion", () => {
  const d = good();
  const second = structuredClone(d.cycles[0]); second.criterion = "AC-2"; second.test.name = "second behaviour";
  d.cycles.push(second);
  assert.deepEqual(errs(d), []);
  const noName = structuredClone(d); noName.cycles[1].criterion = "second behaviour";
  assert.deepEqual(errs(noName), []);   // a named criterion without an AC id is its own criterion
  const dupe = structuredClone(d); dupe.cycles[1].criterion = "AC-1"; has(errs(dupe), "one cycle per criterion");
});
test("validate: --scope path:AC-1+AC-2 needs a cycle for every listed criterion", () => {
  const f = join(mkdtempSync(join(tmpdir(), "tddc-")), "tdd.json");
  writeFileSync(f, JSON.stringify(good()));
  assert.equal(spawnSync("node", [vScript, f, "--scope", "src/parse.js:AC-1,docs/guide.md"]).status, 0);
  const r = spawnSync("node", [vScript, f, "--scope", "src/parse.js:AC-1+AC-2,docs/guide.md"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carries AC-2 but no cycle proves it/);
});
