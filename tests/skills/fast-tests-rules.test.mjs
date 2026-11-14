// Issue 265 package A (A273): the rules for fast, deterministic tests reach the implementer before any test is written (AC-1),
// and the ecosystem facts they rest on are data in ecosystems.json (no ecosystem branching in shared code).
// No test here waits, reads the clock or touches the network: it reads files and calls pure functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate, loadEcosystems, flatten } from "../../control-plane/agents/ecosystems.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");
const tdd = read("skills/tdd-proof/SKILL.md");
const data = () => structuredClone(loadEcosystems(join(root, "control-plane/agents/ecosystems.json")));
const has = (e, s) => assert.ok(e.some((x) => x.includes(s)), `expected "${s}" in ${JSON.stringify(e)}`);

test("tdd-proof states the fast-test rules before the Flow section where RED is recorded", () => {
  const flow = tdd.indexOf("\n## Flow");
  assert.ok(flow > 0);
  const before = tdd.slice(0, flow).toLowerCase();
  for (const phrase of [
    "same time on every run",
    "no real waiting",
    "injectable clock",
    "fake time",
    "system clock directly",
    "no test asserts on wall-clock elapsed time",
    "fixed seed",
    "external calls are faked",
    "waits on an event",
    "parallelism is not a fix",
  ]) assert.ok(before.includes(phrase), `rule text missing before the RED step: "${phrase}"`);
});

test("the implementer is handed tdd-proof first, and SKILL.md links the long reference", () => {
  const role = read("roles/implementer.md");
  assert.match(role, /^[s]kills: tdd-proof\b/m);
  assert.match(tdd, /\]\(references\/FAST\.md\)/);
  const ref = read("skills/tdd-proof/references/FAST.md");
  assert.match(ref, /fast_tests/);
  assert.match(ref, /unsupported/);
});

test("every ecosystem carries fast_tests data and the validator accepts the shipped file", () => {
  assert.deepEqual(validate(data()), []);
  for (const e of data().ecosystems) {
    assert.ok(["supported", "unsupported"].includes(e.fast_tests.fake_clock.status), e.id);
    assert.ok(e.fast_tests.sleep.length > 0 && e.fast_tests.clock_reads.length > 0, e.id);
  }
});

test("the shipped data names the facilities the issue lists and marks a missing one unsupported", () => {
  const by = Object.fromEntries(data().ecosystems.map((e) => [e.id, e.fast_tests]));
  assert.match(by.dotnet.fake_clock.facility, /TimeProvider/);
  assert.match(by.dotnet.fake_clock.facility, /FakeTimeProvider/);
  assert.ok(by.dotnet.sleep.includes("Task.Delay"));
  assert.match(by.npm.fake_clock.facility, /fake timers/);
  assert.ok(by.npm.sleep.includes("setTimeout"));
  assert.ok(by.python.sleep.includes("time.sleep"));
  assert.match(by.go.fake_clock.facility, /Clock/);
  assert.ok(Object.values(by).some((f) => f.fake_clock.status === "unsupported"));
});

test("validate rejects a missing fast_tests, a bad status and empty lists", () => {
  let d = data(); delete d.ecosystems[0].fast_tests; has(validate(d), "fast_tests");
  d = data(); d.ecosystems[0].fast_tests.fake_clock.status = "maybe"; has(validate(d), "fake_clock.status");
  d = data(); d.ecosystems[0].fast_tests.fake_clock.facility = ""; has(validate(d), "fake_clock.facility");
  d = data(); d.ecosystems[1].fast_tests.sleep = []; has(validate(d), "fast_tests.sleep");
  d = data(); d.ecosystems[1].fast_tests.clock_reads = [""]; has(validate(d), "fast_tests.clock_reads");
});

test("the flat form of the data carries the facts, so the core can read them without a branch", () => {
  const rows = flatten(data());
  assert.ok(rows.some(([id, p, v]) => id === "dotnet" && p === "fast_tests.sleep" && v === "Thread.Sleep"));
  assert.ok(rows.some(([id, p]) => id === "swift" && p === "fast_tests.fake_clock.status"));
});

test("the copy of ecosystems.json in the package stays byte-identical to the control plane's", () => {
  assert.equal(read("skills/tdd-proof/references/ecosystems.json"), read("control-plane/agents/ecosystems.json"));
});
