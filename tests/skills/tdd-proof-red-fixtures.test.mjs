// A173: classify-red against the runner output the definition's patterns were written from (tests/skills/fixtures/tdd-proof-output/).
// Every fixture is a real run ("source: captured" in its header); the exit-code table of ecosystems.json also holds entries taken from
// the runners' documentation ("source: docs"), tested separately and named so. A test never adds a pattern to ecosystems.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { classify } from "../../skills/tdd-proof/scripts/classify-red.mjs";
import { loadEcosystems } from "../../skills/tdd-proof/scripts/ecosystems.mjs";

const DIR = fileURLToPath(new URL("./fixtures/tdd-proof-output/", import.meta.url));
const CLI = fileURLToPath(new URL("../../skills/tdd-proof/scripts/classify-red.mjs", import.meta.url));
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith(".txt")).sort().map((f) => {
  const text = readFileSync(DIR + f, "utf8"), at = text.indexOf("=== OUTPUT ===\n");
  const header = Object.fromEntries(text.slice(0, at).split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  return { name: f.replace(/\.txt$/, ""), header, output: text.slice(at + "=== OUTPUT ===\n".length) };
});
const cli = (args, input) => spawnSync("node", [CLI, ...args], { input, encoding: "utf8" });
const byName = (n) => FIXTURES.find((f) => f.name === n) ?? assert.fail(`no fixture ${n}`);

test("fixtures: the directory holds real captured runs, each with a header the table below can use", () => {
  assert.ok(FIXTURES.length >= 90, `${FIXTURES.length} fixtures`);
  for (const f of FIXTURES) {
    for (const k of ["ecosystem", "runner", "command", "exit_code", "scenario", "expected_class", "source"]) assert.ok(f.header[k] !== undefined, `${f.name}: header lacks ${k}`);
    assert.equal(f.header.source, "captured", `${f.name} is not captured`);
  }
});

test("classify-red over every captured fixture: the class of the output alone is the header's expected_class", () => {
  const bad = FIXTURES.filter((f) => classify(f.output).class !== f.header.expected_class)
    .map((f) => `${f.name}: ${classify(f.output).class}, header says ${f.header.expected_class}`);
  assert.deepEqual(bad, [], `${bad.length} of ${FIXTURES.length}:\n${bad.join("\n")}`);
});

test("classify-red over every captured fixture, with its recorded --exit-code and --ecosystem: the same class (a green run may only fall back to no_tests, never to RED)", () => {
  const bad = [];
  for (const f of FIXTURES) {
    const r = classify(f.output, { exitCode: f.header.exit_code, ecosystem: f.header.ecosystem });
    if (f.header.expected_class === "unknown") { if (r.red_valid || r.class === "assertion") bad.push(`${f.name}: ${r.class} red_valid=${r.red_valid} for a run that is not RED`); continue; }
    if (r.class !== f.header.expected_class) bad.push(`${f.name}: ${r.class}, header says ${f.header.expected_class}`);
    if (r.red_valid !== (f.header.expected_class === "assertion")) bad.push(`${f.name}: red_valid=${r.red_valid}`);
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});

test("exit 0 never leaves an assertion as RED (captured assertion fixtures re-run with --exit-code 0)", () => {
  const assertions = FIXTURES.filter((f) => f.header.expected_class === "assertion");
  assert.ok(assertions.length >= 15);
  for (const f of assertions) {
    const r = classify(f.output, { exitCode: 0, ecosystem: f.header.ecosystem });
    assert.equal(r.red_valid, false, f.name); assert.notEqual(r.class, "assertion", f.name);
    assert.equal(cli(["--exit-code", "0", "--ecosystem", f.header.ecosystem], f.output).status, 1, `${f.name}: CLI exit status`);
  }
});

test("Microsoft.Testing.Platform exit code 8 is no_tests (captured: dotnet MTP fixtures and the bare exit code)", () => {
  const mtp = FIXTURES.filter((f) => f.header.ecosystem === "dotnet" && f.header.exit_code === "8");
  assert.ok(mtp.length >= 4, `${mtp.length} MTP exit-8 fixtures`);
  for (const f of mtp) assert.equal(classify(f.output, { exitCode: 8, ecosystem: "dotnet" }).class, "no_tests", f.name);
  // output the patterns do not know: the exit code alone names the class, the CLI says so too
  const r = JSON.parse(cli(["--exit-code", "8", "--ecosystem", "dotnet"], "some banner text\n").stdout);
  assert.equal(r.class, "no_tests"); assert.equal(r.red_valid, false); assert.equal(r.exit_code, 8);
  assert.match(r.evidence, /exit code 8 \(microsoft\.testing\.platform/);
  // without --ecosystem the code is a cross-check only: nothing is guessed
  assert.equal(classify("some banner text\n", { exitCode: 8 }).class, "unknown");
});

test("VSTest exit 0 with nothing run is no_tests (captured: dotnet vstest fixtures; empty output with the exit code)", () => {
  const vs = FIXTURES.filter((f) => f.header.ecosystem === "dotnet" && f.name.includes("-vstest-") && f.header.expected_class === "no_tests");
  assert.ok(vs.length >= 3, `${vs.length} vstest no-test fixtures`);
  for (const f of vs) assert.equal(classify(f.output, { exitCode: f.header.exit_code, ecosystem: "dotnet" }).class, "no_tests", f.name);
  assert.equal(classify("", { exitCode: 0, ecosystem: "dotnet" }).class, "no_tests");
  assert.equal(classify("", { exitCode: 0 }).class, "unknown", "no ecosystem: an empty output stays unknown");
});

test("the `unless` guard (captured go test): one package without test files beside another's failing assertion is an assertion", () => {
  for (const n of ["go-test-mixed-assertion", "go-test-mixed-filter-assertion"]) {
    const f = byName(n), r = classify(f.output, { exitCode: f.header.exit_code, ecosystem: "go" });
    assert.equal(r.class, "assertion", n); assert.equal(r.red_valid, true, n);
    assert.match(f.output, /\[no test files\]|\[no tests to run\]/, `${n} really holds a no-tests package line`);
  }
  // the same line alone, or in every package, is no_tests
  assert.equal(classify(byName("go-test-no-test-files").output, { exitCode: 0, ecosystem: "go" }).class, "no_tests");
  assert.equal(classify(byName("go-test-no-tests-all-packages").output, { exitCode: 0, ecosystem: "go" }).class, "no_tests");
  assert.equal(classify("?   \texample.com/a\t[no test files]\nok  \texample.com/b\t0.2s\n", { ecosystem: "go" }).class, "unknown", "a package that ran and passed beside a package without tests: nothing failed");
});

test("exit-code table of ecosystems.json: every entry names its class (captured entries)", () => exitTable("captured"));
test("exit-code table of ecosystems.json: every entry names its class (docs entries)", () => exitTable("docs"));
function exitTable(source) {
  let n = 0; const bad = [];
  for (const e of loadEcosystems().ecosystems) {
    const table = e.test_output?.exit_codes ?? {};
    for (const [cls, list] of Object.entries(table)) for (const x of list) {
      if (x.source !== source) continue;
      n++;
      const others = ["no_tests", "compile", "assertion"].filter((c) => c !== cls && (table[c] ?? []).some((y) => String(y.code) === String(x.code)));
      const r = classify("unrecognised runner banner\n", { exitCode: x.code, ecosystem: e.id });
      // a code listed for two classes (go: 1 is compile and assertion) cannot decide alone; an assertion code is never taken from the code alone
      const want = others.length || cls === "assertion" ? "unknown" : cls;
      if (r.class !== want) bad.push(`${e.id} ${x.runner} code ${x.code}: ${cls} -> ${r.class}, want ${want}`);
      if (r.red_valid) bad.push(`${e.id} code ${x.code} gave a RED from the exit code alone`);
    }
  }
  assert.ok(n > 0, `no ${source} entries`);
  assert.deepEqual(bad, [], bad.join("\n"));
}
