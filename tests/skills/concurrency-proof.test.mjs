import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { validate, checkRepo, checkReport, gate, rows, safetyClaim, CATEGORIES } from "../../skills/concurrency-proof/scripts/validate-concurrency.mjs";
import { scan, scanText } from "../../skills/concurrency-proof/scripts/find-shared-state.mjs";

const SKILL = new URL("../../skills/concurrency-proof/", import.meta.url).pathname;
const VALIDATE = join(SKILL, "scripts/validate-concurrency.mjs");
const FIND = join(SKILL, "scripts/find-shared-state.mjs");
const SETUP = new URL("../../fixtures/concurrency-proof/setup.sh", import.meta.url).pathname;
const dirs = [];
const mktmp = () => { const d = mkdtempSync(join(tmpdir(), "cp-test-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// The known answer for the fixture, written from its planted facts (fixtures/concurrency-proof/EXPECTED.md).
// The text on each cited fixture line (required with --repo).
const CODE = {
  "src/wallet.js:3": "const account = await store.get(accountId);", "src/wallet.js:5": "await store.put(accountId, { ...account, balance });",
  "src/orders.js:3": "const order = await store.get(orderId);", "src/orders.js:4": "if (order.status === 'shipped')",
  "src/orders.js:5": "await shipper.ship(orderId, order.address);", "src/payments.js:5": "gateway.charge({ cents, reference:",
  "src/retry.js:13": "return await withTimeout(operation(), timeoutMs * attempt);",
  "src/gateway.js:9": "if (idempotencyKey !== undefined && seen.has(idempotencyKey))",
};
const step = (n, actor, file, line, action, code = CODE[`${file}:${line}`]) => ({ n, actor, file, line, action, ...(code ? { code } : {}) });
const lostUpdate = () => ({
  id: "C001", category: "lost_update", title: "Concurrent deposits overwrite each other", status: "open",
  location: { file: "src/wallet.js", line: 5 }, shared_state: "account row balance", evidence: "traced",
  trace: {
    actors: ["request A", "request B"],
    steps: [
      step(1, "request A", "src/wallet.js", 3, "reads balance 100, yields at await", "const account = await store.get(accountId);"),
      step(2, "request B", "src/wallet.js", 3, "reads balance 100"),
      step(3, "request A", "src/wallet.js", 5, "writes 110"),
      step(4, "request B", "src/wallet.js", 5, "writes 120 over 110", "await store.put(accountId, { ...account, balance });"),
    ],
    outcome: "balance 120 after deposits of 10 and 20 on 100",
  },
  why_not_reproduced: "reproduction UNSUPPORTED in this test",
});
const doubleShip = () => ({
  id: "C002", category: "double_processing", title: "Two workers ship the same order", status: "open",
  location: { file: "src/orders.js", line: 5 }, shared_state: "order status", evidence: "traced",
  trace: {
    actors: ["worker 1", "worker 2"],
    steps: [
      step(1, "worker 1", "src/orders.js", 3, "reads status paid"),
      step(2, "worker 2", "src/orders.js", 3, "reads status paid"),
      step(3, "worker 1", "src/orders.js", 4, "check passes", "if (order.status === 'shipped')"),
      step(4, "worker 2", "src/orders.js", 4, "check passes"),
      step(5, "worker 1", "src/orders.js", 5, "ships"),
      step(6, "worker 2", "src/orders.js", 5, "ships again"),
    ],
    outcome: "shipper.ship called twice for o1",
  },
  why_not_reproduced: "reproduction UNSUPPORTED in this test",
});
const doubleCharge = () => ({
  id: "C003", category: "retry_side_effect", title: "A timed-out charge is retried without an idempotency key", status: "open",
  location: { file: "src/payments.js", line: 5 }, shared_state: "gateway charges for the order", evidence: "traced",
  trace: {
    actors: ["attempt 1", "attempt 2"],
    steps: [
      step(1, "attempt 1", "src/payments.js", 5, "sends charge without idempotencyKey"),
      step(2, "attempt 1", "src/retry.js", 13, "times out at 50 ms; the request is not cancelled", "return await withTimeout(operation(), timeoutMs * attempt);"),
      step(3, "attempt 2", "src/payments.js", 5, "sends a second charge"),
      step(4, "attempt 1", "src/gateway.js", 9, "no key: a new charge is created", "if (idempotencyKey !== undefined && seen.has(idempotencyKey))"),
      step(5, "attempt 2", "src/gateway.js", 9, "no key: a second charge is created"),
    ],
    outcome: "two charges for one order",
  },
  why_not_reproduced: "reproduction UNSUPPORTED in this test",
});
const CHANGED = ["src/inventory.js", "src/orders.js", "src/payments.js", "src/rates.js", "src/refunds.js", "src/retry.js", "src/wallet.js", "test/features.test.js"];
const doc = (findings = [lostUpdate(), doubleShip(), doubleCharge()], over = {}) => ({
  schema_version: 1, skill_version: "0.0.8",
  target: { type: "branch", name: "main", base: "base", head: "HEAD" },
  scope: { changed_files: CHANGED, candidates: 40, not_reviewed: [] },
  reproduction: { status: "unsupported", reason: "test only" },
  findings,
  unproven_risks: [{ id: "U001", category: "race", location: { file: "src/rates.js", line: 7 }, reason: "shared cache check and set", why_unproven: "no suspension point between check (7) and set (9); refuted on one event loop" }],
  judged: [],
  verdict: { summary: "Three proven problems: a lost update, a double shipment and a duplicate charge." },
  ...over,
});
const clone = (o) => JSON.parse(JSON.stringify(o));
const bad = (d, re) => {
  const e = validate(d);
  assert.ok(e.length > 0, "expected errors");
  assert.ok(e.some((m) => re.test(m)), `no error matching ${re}: ${e.join(" | ")}`);
};
const runCli = (script, args) => spawnSync("node", [script, ...args], { encoding: "utf8" });
const writeDoc = (d) => { const f = join(mktmp(), "concurrency.json"); writeFileSync(f, typeof d === "string" ? d : JSON.stringify(d)); return f; };

let fx;
const fixture = () => {
  if (fx) return fx;
  fx = join(mktmp(), "fx");
  const r = spawnSync("sh", [SETUP, fx], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return fx;
};

test("categories cover the scope of the skill", () => {
  for (const c of ["race", "deadlock", "lost_update", "double_processing", "idempotency", "retry_side_effect", "ordering", "redelivery", "timeout", "transaction_boundary", "lock_lifecycle"]) assert.ok(CATEGORIES.includes(c), c);
});

test("known answer: valid, FAIL, three blocking rows, unproven risk as info", () => {
  assert.deepEqual(validate(doc()), []);
  const g = gate(doc());
  assert.equal(g.result, "FAIL");
  assert.equal(g.confidence, "medium");
  const r = rows(doc()).split("\n");
  assert.equal(r.filter((l) => l.startsWith("blocking|")).length, 3);
  assert.match(r[0], /^blocking\|src\/wallet\.js:5\|C001 lost_update: /);
  assert.match(r[0], /traced: 1\.request A@src\/wallet\.js:3 -> 2\.request B@src\/wallet\.js:3/);
  assert.ok(r.some((l) => /^info\|src\/rates\.js:7\|U001 unproven race/.test(l)));
  assert.ok(r.some((l) => /^info\|-\|reproduction UNSUPPORTED: test only\|/.test(l)));
});

test("PASS is no proven problem; confidence high when reproduction ran, low with not_reviewed", () => {
  const d = doc([], { reproduction: { status: "ran", runner: "node --test", worktree: "/tmp/concurrency-proof-x" } });
  assert.deepEqual(validate(d), []);
  assert.deepEqual([gate(d).result, gate(d).confidence], ["PASS", "high"]);
  d.scope.not_reviewed = [{ path: "vendor/x.js", reason: "vendored" }];
  assert.equal(gate(d).confidence, "low");
});

test("trace: two distinct actors, each with a step, ordered steps, location among steps", () => {
  let d = doc(); d.findings[0].trace.actors = ["request A"];
  bad(d, /at least 2 distinct/);
  d = doc(); d.findings[0].trace.actors = ["request A", "request A"];
  bad(d, /at least 2 distinct/);
  d = doc(); d.findings[0].trace.steps.forEach((s) => { s.actor = "request A"; });
  bad(d, /at least 2 different actors/);
  d = doc(); d.findings[0].trace.actors.push("request C");
  bad(d, /every actor takes at least one step/);
  d = doc(); d.findings[0].trace.steps[1].n = 3;
  bad(d, /steps\[1\]\.n: expected 2/);
  d = doc(); d.findings[0].trace.steps[2].actor = "request Z";
  bad(d, /expected one of trace\.actors/);
  d = doc(); d.findings[0].trace.steps = [d.findings[0].trace.steps[0]];
  bad(d, /at least 2 ordered steps/);
  d = doc(); d.findings[0].location.line = 4;
  bad(d, /location to be one of the trace steps/);
  d = doc(); delete d.findings[0].trace;
  bad(d, /trace: expected/);
  d = doc(); d.findings[0].trace.steps[0].file = "../etc/passwd";
  bad(d, /repository-relative/);
});

test("evidence: traced needs why_not_reproduced; reproduced needs ran, runs >= 2, 1..runs failures", () => {
  let d = doc(); delete d.findings[0].why_not_reproduced;
  bad(d, /why_not_reproduced/);
  const rep = { command: "node --test test/race.test.js", runs: 10, failures: 4, observed: "balance 120 != 130", saved_copy: "evidence/C001.test.txt" };
  d = doc(); delete d.findings[0].why_not_reproduced; d.findings[0].evidence = "reproduced"; d.findings[0].reproduction = rep;
  bad(d, /reproduced requires reproduction\.status ran/);
  d.reproduction = { status: "ran", runner: "node --test", worktree: "/tmp/concurrency-proof-fx" };
  d.findings = [d.findings[0]]; d.unproven_risks = [];
  assert.deepEqual(validate(d), []);
  for (const [k, v, re] of [["runs", 1, /runs/], ["failures", 0, /failures/], ["failures", 11, /failures/], ["saved_copy", "out/x", /saved_copy/]]) {
    const e = clone(d); e.findings[0].reproduction[k] = v; bad(e, re);
  }
  d = doc(); d.findings[0].evidence = "judged";
  bad(d, /expected traced\|reproduced/);
});

test("reproduction status is always stated", () => {
  bad(doc([], { reproduction: undefined }), /reproduction: expected object/);
  bad(doc([], { reproduction: { status: "skipped" } }), /ran\|unsupported\|none_needed/);
  bad(doc([], { reproduction: { status: "unsupported" } }), /needs the reason/);
  bad(doc([], { reproduction: { status: "ran", runner: "x", worktree: "/tmp/other" } }), /concurrency-proof-/);
  bad(doc(undefined, { reproduction: { status: "none_needed", reason: "nothing found" } }), /none_needed only when/);
  assert.deepEqual(validate(doc([], { unproven_risks: [], reproduction: { status: "none_needed", reason: "no candidate survived" } })), []);
});

test("accepted by the plan does not fail; closed needs recheck; pre_existing is info", () => {
  let d = doc([lostUpdate()]); d.findings[0].status = "accepted";
  bad(d, /accepted_by/);
  d.findings[0].accepted_by = { file: "PLAN.md", line: 12, quote: "deposits are serialised by the caller" };
  assert.deepEqual(validate(d), []);
  assert.equal(gate(d).result, "PASS");
  d = doc([lostUpdate()]); d.findings[0].status = "closed";
  bad(d, /recheck/);
  d = doc([lostUpdate()]); d.findings[0].accepted_by = { file: "PLAN.md", line: 1, quote: "x" };
  bad(d, /only an accepted finding/);
  d = doc([lostUpdate()]); d.findings[0].status = "pre_existing";
  assert.equal(gate(d).result, "PASS");
  assert.match(rows(d), /^info\|src\/wallet\.js:5\|C001 pre-existing lost_update/m);
  d = doc([lostUpdate()]); d.scope.changed_files = ["src/other.js"];
  bad(d, /scope\.changed_files/);
});

test("judged fails only with a cited criterion", () => {
  const d = doc([], { judged: [{ id: "J001", location: { file: "src/inventory.js", line: 3 }, note: "one global mutex for all SKUs" }] });
  assert.equal(gate(d).result, "PASS");
  d.judged[0].violates = { file: "PLAN.md", line: 20, quote: "reservations of different SKUs never wait on each other" };
  assert.deepEqual(validate(d), []);
  assert.equal(gate(d).result, "FAIL");
  assert.match(rows(d), /^blocking\|src\/inventory\.js:3\|J001 judged: /m);
});

test("safety claims rejected; quoted code, identifiers, unsafe and safety are not claims", () => {
  for (const s of ["The change is safe.", "The code is thread-safe.", "It is thread safe.", "threadsafe now", "Race-free after review.", "deadlock free",
    "Runs safely under load.", "Not proven safe either.", "concurrency-safe", "race-condition-free", "race condition free",
    "The code is free of races.", "free of data races", "free of deadlocks", "free of race conditions",
    "The workers cannot race.", "they can not deadlock", "it can't race", "impossible to deadlock",
    "There are no races.", "no data race", "guaranteed correct", "guaranteed safe", "no concurrency issues", "No concurrency problems.",
    "The reviewer says \"this is thread-safe now\"."]) {
    assert.ok(safetyClaim(s), s);
    bad(doc([], { verdict: { summary: s } }), /asserts safety/);
  }
  for (const s of ["No proven problem; `isSafe()` and `thread_safe` were read.", "The helper \"safe\" is a function name.", "unsafe publication was examined",
    "No safety property is claimed.", "safeParse and is_safe are called", "```\nconst safe = 1;\n```\nNo proven problem.", "No proven race or deadlock.",
    "Three proven problems: a lost update, a double shipment and a duplicate charge."]) {
    assert.equal(safetyClaim(s), null, s);
  }
  assert.deepEqual(checkReport("# r\n## Summary\nNo proven problem; `safe()` is called.\n## Findings\nthe lock looks safe\n## Verdict\nRESULT: PASS\n"), []);
  assert.match(checkReport("## Verdict\nRESULT: PASS. The code is race-free.\n").join(), /verdict: asserts safety \("race-free"\)/);
  for (const h of ["# Verdict", "### verdict:", "###### VERDICT", "## Summary:", "#### summary"]) {
    assert.match(checkReport(`${h}\nThe change is safe.\n`).join(), /asserts safety/, h);
  }
  assert.deepEqual(checkReport("## Verdicts and more\nsafe\n## Summary of tools\nsafe\n"), []);
});

test("report verdict word must match the computed result", () => {
  assert.deepEqual(checkReport("## Verdict\nRESULT: FAIL, CONFIDENCE: medium.\n", "FAIL"), []);
  assert.match(checkReport("## Verdict\nRESULT: PASS\n", "FAIL").join(), /says PASS but the computed result is FAIL/);
  assert.deepEqual(checkReport("## Verdict\nRESULT: PASS. The `FAIL` path was examined.\n", "PASS"), []);
});

test("unknown keys and duplicate ids rejected", () => {
  let d = doc(); d.extra = 1; bad(d, /unexpected "extra"/);
  d = doc(); d.findings[0].trace.steps[0].extra = 1; bad(d, /unexpected "extra"/);
  d = doc(); d.findings[1].id = "C001"; bad(d, /duplicate id C001/);
  d = doc(); d.unproven_risks[0].severity = "high"; bad(d, /unexpected "severity"/);
});

test("repo and base: the fixture's known answer passes; bad citations fail", () => {
  const repo = fixture();
  assert.deepEqual(checkRepo(doc(), repo, "base"), []);
  let d = doc(); d.findings[0].trace.steps[0].line = 999;
  assert.match(checkRepo(d, repo).join(), /has 7 lines, not 999/);
  d = doc(); d.findings[0].trace.steps[0].code = "store.get(otherId)";
  assert.match(checkRepo(d, repo).join(), /does not contain/);
  d = doc(); d.findings[0].trace.steps[0].file = "src/missing.js";
  assert.match(checkRepo(d, repo).join(), /does not exist/);
  d = doc(); delete d.findings[1].trace.steps[2].code;
  assert.match(checkRepo(d, repo).join(), /findings\[1\]\.trace\.steps\[2\]\.code: required with --repo/);
  assert.deepEqual(validate(d), [], "code stays optional without --repo");
  // A schedule entirely on base lines (gateway.js is unchanged) is not a finding in the change.
  d = doc([doubleCharge()]);
  d.findings[0].trace.steps = [step(1, "attempt 1", "src/gateway.js", 9, "a"), step(2, "attempt 2", "src/gateway.js", 9, "b")];
  d.findings[0].location = { file: "src/gateway.js", line: 9 };
  d.findings[0].status = "pre_existing";
  assert.deepEqual(checkRepo(d, repo, "base"), []);
  d.findings[0].status = "open";
  assert.match(checkRepo(d, repo, "base").join(), /no trace step is on a line changed since base/);
});

test("CLI: exit codes, result lines, rows only, report check", () => {
  const repo = fixture();
  const f = writeDoc(doc(undefined, { scope: { changed_files: CHANGED, candidates: scan({ repo, base: "base" }).candidates.length, not_reviewed: [] } }));
  let r = runCli(VALIDATE, [f, "--repo", repo, "--base", "base"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^RESULT: FAIL\nCONFIDENCE: medium\nREPRODUCTION: UNSUPPORTED \(test only\)$/m);
  r = runCli(VALIDATE, [f, "--rows"]);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /RESULT/);
  assert.equal(r.stdout.trim().split("\n").filter((l) => l.startsWith("blocking|")).length, 3);
  const rep = join(mktmp(), "REPORT.md");
  writeFileSync(rep, "## Verdict\nThe change is safe.\n");
  r = runCli(VALIDATE, [f, "--report", rep]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /asserts safety/);
  writeFileSync(rep, "## Verdict\nRESULT: PASS\n");
  r = runCli(VALIDATE, [f, "--report", rep]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /says PASS but the computed result is FAIL/);
  writeFileSync(rep, "## Summary\nThree proven problems.\n## Verdict\nRESULT: FAIL\n");
  assert.equal(runCli(VALIDATE, [f, "--repo", repo, "--base", "base", "--report", rep]).status, 0);
  const b = doc(); b.findings[0].trace.actors = ["one"];
  assert.equal(runCli(VALIDATE, [writeDoc(b)]).status, 1);
  assert.equal(runCli(VALIDATE, [writeDoc("{ nope")]).status, 2);
  assert.equal(runCli(VALIDATE, [f, "--base", "base"]).status, 2);
  assert.equal(runCli(VALIDATE, []).status, 2);
});

test("find-shared-state: candidates on the fixture's planted and decoy sites, a list not a verdict", () => {
  const repo = fixture();
  const out = scan({ repo, base: "base", changedOnly: true });
  assert.deepEqual(out.files, CHANGED);
  assert.ok(out.limits.some((l) => /never a finding/.test(l)));
  const has = (file, line, category) => out.candidates.some((c) => c.file === file && c.line === line && c.category === category);
  assert.ok(has("src/wallet.js", 3, "suspension"), "wallet read");
  assert.ok(has("src/wallet.js", 5, "suspension"), "wallet write");
  assert.ok(has("src/orders.js", 4, "check_then_act"), "orders check");
  assert.ok(has("src/payments.js", 5, "retry"), "payments retry");
  assert.ok(has("src/retry.js", 13, "timeout"), "retry timeout");
  assert.ok(has("src/inventory.js", 7, "lock"), "decoy lock is a candidate too");
  assert.ok(has("src/refunds.js", 5, "idempotency"), "decoy key is a candidate too");
  assert.ok(has("src/rates.js", 7, "check_then_act"), "trap is a candidate too");
  assert.ok(out.candidates.every((c) => c.changed_line));
  // CLI with explicit files; base files are not in the --base list.
  const r = runCli(FIND, ["--repo", repo, "src/mutex.js"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).candidates.some((c) => c.file === "src/mutex.js" && c.category === "suspension"));
  assert.equal(runCli(FIND, ["--repo", repo]).status, 2);
});

test("find-shared-state patterns: languages, comments skipped, identifiers", () => {
  const cats = (line) => scanText("x", line, null).map((c) => c.category);
  assert.ok(cats("mu.Lock()").includes("lock"));
  assert.ok(cats("go func() { work() }()").includes("concurrency"));
  assert.ok(cats("with transaction.atomic():").includes("transaction"));
  assert.ok(cats("UPDATE accounts SET n = n + 1 WHERE id = ? FOR UPDATE").includes("lock"));
  assert.ok(cats("count += 1").includes("shared_state"));
  assert.ok(cats("total = total + amount").includes("shared_state"));
  assert.ok(cats("INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING").includes("idempotency"));
  assert.ok(cats("channel.ack(msg)").includes("queue"));
  assert.deepEqual(cats("// retry with a lock and a timeout"), []);
  assert.deepEqual(cats("# lock the queue"), []);
  assert.deepEqual(cats("const blockSize = 4"), []);
});

// --- review round 2 (A93): the agent's own labels never close a traced or reproduced finding ------------------
const { checkLabels } = await import("../../skills/concurrency-proof/scripts/validate-concurrency.mjs");
const truthful = (repo, findings) => doc(findings, { scope: { changed_files: CHANGED, candidates: scan({ repo, base: "base" }).candidates.length, not_reviewed: [] } });
const labels = (d, opts) => checkLabels(d, { docDir: mktmp(), ...opts });

test("H6: pre_existing is valid only when --repo --base shows no trace step on a changed line", () => {
  const repo = fixture();
  const d = truthful(repo, [lostUpdate()]); d.findings[0].status = "pre_existing";
  assert.deepEqual(validate(d), []);
  assert.match(labels(d, { repo, base: "base" }).join(), /pre_existing, but trace step 1 \(src\/wallet\.js:3\) is on a line changed since base/);
  assert.match(labels(d, {}).join(), /pre_existing needs --repo and --base/);
  assert.match(labels(d, { repo }).join(), /pre_existing needs --repo and --base/);
  const g = truthful(repo, [doubleCharge()]);
  g.findings[0].trace.steps = [step(1, "attempt 1", "src/gateway.js", 9, "a"), step(2, "attempt 2", "src/gateway.js", 9, "b")];
  g.findings[0].location = { file: "src/gateway.js", line: 9 }; g.findings[0].status = "pre_existing";
  assert.deepEqual(labels(g, { repo, base: "base" }), []);
});

test("H6: closed needs a recheck the validator re-checks, never a sentence", () => {
  const repo = fixture();
  const d = truthful(repo, [lostUpdate()]); d.findings[0].status = "closed";
  d.findings[0].recheck = "looked again";
  assert.ok(validate(d).some((e) => /recheck: a closed finding needs a recheck \{kind: reproduction\|fix/.test(e)));
  d.findings[0].recheck = { kind: "fix", file: "src/wallet.js", line: 5, code: "await store.put(accountId, { ...account, balance });" };
  assert.deepEqual(validate(d), []);
  assert.match(labels(d, { repo, base: "base" }).join(), /is a step of the traced schedule, not a fix/);
  assert.match(labels(d, {}).join(), /a fix recheck needs --repo and --base/);
  d.findings[0].recheck = { kind: "fix", file: "src/gateway.js", line: 9, code: "if (idempotencyKey" };
  const e = labels(d, { repo, base: "base" }).join();
  assert.match(e, /src\/gateway\.js is not a file of the traced schedule/); assert.match(e, /src\/gateway\.js:9 is not a line changed since base/);
  const o = truthful(repo, [lostUpdate()]); o.findings[0].recheck = { kind: "fix", file: "src/wallet.js", line: 5, code: "x" };
  assert.ok(validate(o).some((x) => /only a closed finding carries a recheck/.test(x)));
});
test("H6 re-review: a fix line is code inside the traced function and carries a synchronisation token", () => {
  // a fixed copy of the fixture: wallet.js gets a lock line in deposit, a comment trick and an unrelated function
  const repo = join(mktmp(), "fx"); assert.equal(spawnSync("sh", [SETUP, repo]).status, 0);
  writeFileSync(join(repo, "src/wallet.js"), [
    "// Deposits add to an account balance.", "export async function deposit(store, accountId, cents) {",
    "  const account = await store.get(accountId);", "  await mutex.lock(accountId); const balance = account.balance + cents;",
    "  await store.put(accountId, { ...account, balance });", "  return balance; // lock released by the caller", "}",
    "// lock the account first", "export function unrelated() { return mutex.lock(); }", ""].join("\n"));
  const d = doc([lostUpdate()]); d.findings[0].status = "closed";
  const fix = (line, code, extra = {}) => { d.findings[0].recheck = { kind: "fix", file: "src/wallet.js", line, code, ...extra }; return labels(d, { repo, base: "base" }).filter((x) => !/scope\.candidates/.test(x)).join("\n"); };
  assert.equal(fix(4, "await mutex.lock(accountId);"), "");
  assert.equal(fix(4, "await mutex.lock(accountId);", { fix_token: "mutex.lock" }), "");
  assert.match(fix(4, "await mutex.lock(accountId);", { fix_token: "serialise(" }), /not the stated fix_token "serialise\("/);
  assert.match(fix(6, "return balance;"), /has no synchronisation token/);
  assert.match(fix(8, "// lock the account first"), /is a comment or blank, not a fix/);
  assert.match(fix(9, "return mutex.lock();"), /is not inside a function of the traced schedule/);
});
test("H6 re-review: a reproduction recheck re-runs the original command, with its hash and observed text", () => {
  const rep = { command: "node --test test/race.test.js", runs: 10, failures: 4, observed: "balance 120 != 130", saved_copy: "evidence/C001.test.txt" };
  const d = doc([{ ...lostUpdate(), evidence: "reproduced", reproduction: rep, why_not_reproduced: undefined }]);
  delete d.findings[0].why_not_reproduced;
  d.reproduction = { status: "ran", runner: "node --test", worktree: "/tmp/concurrency-proof-x" };
  d.findings[0].status = "closed";
  const dir = mktmp(); mkdirSync(join(dir, "evidence"));
  const out = "10/10 runs passed\nbalance 130 == 130\n"; writeFileSync(join(dir, "evidence/C001-recheck.txt"), out);
  const sha = createHash("sha256").update(out).digest("hex");
  const rc = { kind: "reproduction", command: rep.command, runs: 10, failures: 0, observed: "balance 130 == 130", saved_copy: "evidence/C001-recheck.txt", sha256: sha };
  d.findings[0].recheck = { ...rc };
  assert.deepEqual(validate(d), []);
  assert.deepEqual(checkLabels(d, { docDir: dir }), []);
  const bad = (over, re) => { d.findings[0].recheck = { ...rc, ...over }; assert.match([...validate(d), ...checkLabels(d, { docDir: dir })].join("\n"), re); };
  bad({ failures: 2 }, /0 failing runs/);
  bad({ sha256: undefined }, /sha256 of the saved copy/);
  bad({ sha256: "0".repeat(64) }, /sha256: does not match/);
  bad({ observed: "all good" }, /observed: the text is not in/);
  bad({ command: "node --test test/other.test.js" }, /must be the original reproduction command/);
  bad({ runs: 3 }, /3 < the original 10 runs/);
  bad({ saved_copy: "evidence/missing.txt" }, /does not exist next to concurrency\.json/);
  // a traced finding is closed by a fix, not by a new test the validator cannot relate to the schedule
  const t = doc([lostUpdate()]); t.findings[0].status = "closed"; t.reproduction = d.reproduction; t.findings[0].recheck = { ...rc };
  assert.match(checkLabels(t, { docDir: dir }).join(), /a traced finding is closed by a fix recheck/);
  d.reproduction = { status: "unsupported", reason: "x" }; d.findings[0].recheck = { ...rc };
  assert.match(checkLabels(d, { docDir: dir }).join(), /a reproduction recheck needs reproduction\.status ran/);
});

test("H6: accepted_by cites the frozen plan or spec verbatim, names the finding, never the changed code", () => {
  const repo = fixture();
  const d = truthful(repo, [lostUpdate()]); d.findings[0].status = "accepted";
  d.findings[0].accepted_by = { file: "src/wallet.js", line: 5, quote: "await store.put(accountId, { ...account, balance });" };
  assert.deepEqual(validate(d), []);
  assert.match(labels(d, { repo }).join(), /cites src\/wallet\.js, which is changed code/);
  const text = "# Plan\n\n## Risk\n\nconcurrency: yes\n- C001 (src/wallet.js:5): deposits are serialised by the caller (one request per account).\n- Deposits are serialised by the caller.\n";
  const runDir = join(repo, ".agents/runs/T1"); mkdirSync(runDir, { recursive: true });
  const plan = join(runDir, "PLAN.md"); writeFileSync(plan, text);
  const ref = () => [{ path: plan, text: readFileSync(plan, "utf8") }];
  const p = truthful(repo, [lostUpdate()]); p.findings[0].status = "accepted";
  p.findings[0].accepted_by = { file: ".agents/runs/T1/PLAN.md", line: 6, quote: "deposits are serialised by the caller" };
  try {
    assert.match(labels(p, { repo }).join(), /pass --plan or --spec/);
    assert.deepEqual(labels(p, { repo, refs: ref() }), []);
    // the line must name the finding (id, path:line or a symbol of its steps)
    p.findings[0].accepted_by = { file: ".agents/runs/T1/PLAN.md", line: 7, quote: "Deposits are serialised by the caller." };
    assert.match(labels(p, { repo, refs: ref() }).join(), /does not name the finding \(C001, src\/wallet\.js:5/);
    p.findings[0].accepted_by.symbol = "store.put";
    assert.match(labels(p, { repo, refs: ref() }).join(), /does not name the finding/, "the symbol must be on the cited line");
    p.findings[0].accepted_by = { file: ".agents/runs/T1/PLAN.md", line: 6, quote: "duplicates are tolerated" };
    assert.match(labels(p, { repo, refs: ref() }).join(), /does not contain the quote verbatim/);
    // a run PLAN.md must be the frozen one
    p.findings[0].accepted_by = { file: ".agents/runs/T1/PLAN.md", line: 6, quote: "deposits are serialised by the caller" };
    writeFileSync(join(runDir, "RUN.yaml"), `freeze:\n  plan_sha256: "${"0".repeat(64)}"\n`);
    assert.match(labels(p, { repo, refs: ref() }).join(), /is not the frozen PLAN\.md/);
    writeFileSync(join(runDir, "RUN.yaml"), `freeze:\n  plan_sha256: "${createHash("sha256").update(text).digest("hex")}"\n`);
    assert.deepEqual(labels(p, { repo, refs: ref() }), []);
    // outside a run folder the plan read is pinned by sha256
    const loose = join(repo, "PLAN.md"); writeFileSync(loose, text);
    p.findings[0].accepted_by = { file: "PLAN.md", line: 6, quote: "deposits are serialised by the caller" };
    const lref = [{ path: loose, text }];
    assert.match(labels(p, { repo, refs: lref }).join(), /is not a run artifact .*accepted_by\.sha256 must pin the file read/);
    p.findings[0].accepted_by.sha256 = createHash("sha256").update(text).digest("hex");
    assert.deepEqual(labels(p, { repo, refs: lref }), []);
    assert.match(labels(p, { repo, refs: ref() }).join(), /PLAN\.md is not one of the --plan\/--spec files/);
    rmSync(loose);
    const w = join(repo, "src/wallet.js");
    assert.match(labels(d, { repo, refs: [{ path: w, text: readFileSync(w, "utf8") }] }).join(), /src\/wallet\.js is in scope\.changed_files/);
  } finally { rmSync(join(repo, ".agents"), { recursive: true, force: true }); rmSync(join(repo, "PLAN.md"), { force: true }); }
});

test("L7: scope.candidates must equal a fresh find-shared-state count with --repo --base", () => {
  const repo = fixture();
  const n = scan({ repo, base: "base" }).candidates.length;
  const d = truthful(repo, []); d.reproduction = { status: "ran", runner: "node --test", worktree: "/tmp/concurrency-proof-x" }; d.unproven_risks = [];
  assert.deepEqual(labels(d, { repo, base: "base" }), []);
  d.scope.candidates = n + 5;
  assert.match(labels(d, { repo, base: "base" }).join(), new RegExp(`scope\\.candidates: ${n + 5}, but find-shared-state\\.mjs --base base finds ${n}`));
  const f = writeDoc(d);
  const r = runCli(VALIDATE, [f, "--repo", repo, "--base", "base"]);
  assert.equal(r.status, 1); assert.match(r.stderr, /scope\.candidates/);
});
