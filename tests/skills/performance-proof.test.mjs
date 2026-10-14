import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = join(root, "skills/performance-proof/scripts");
const samples = join(root, "fixtures/performance-proof/samples");
const { compare, stats, thresholds, readSamples, readEnv, worst } = await import(join(scripts, "compare-bench.mjs"));
const { validate, loadDoc } = await import(join(scripts, "validate-performance.mjs"));
const tmp = mkdtempSync(join(tmpdir(), "perf-proof-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

const cli = (...args) => spawnSync(process.execPath, [join(scripts, "compare-bench.mjs"), ...args], { encoding: "utf8" });
const pair = (c) => {
  const f = (side) => { for (const ext of ["json", "csv"]) { try { return readSamples(join(samples, `${c}-${side}.${ext}`)); } catch (e) { if (e.code !== "ENOENT") throw e; } } };
  return [f("base"), f("change")];
};
const statusOf = (c, opts = {}) => { const [b, ch] = pair(c); return compare(b.samples, ch.samples, opts).status; };
const has = (e, s) => assert.ok(e.some((x) => x.includes(s)), `expected "${s}" in ${JSON.stringify(e)}`);

const ENV = ["os=Linux 6.8.0 x86_64", "cpu_count=8", "load_avg_before=0.42, 0.40, 0.38", "command=npm run bench", "warmup_runs=1",
  "runs=12", "order=interleaved", "timer=date", "timeout_s=60", "base_rev=abc123", "change_rev=def456+uncommitted",
  "tool_version.node=v22.11.0", "started_at=2026-10-13T10:00:00Z", "load_avg_after=0.45, 0.41, 0.38", "finished_at=2026-10-13T10:02:00Z"].join("\n");
writeFileSync(join(tmp, "env.txt"), ENV + "\n");
const report = (c, ...extra) => {
  const ext = c === "c3" ? "csv" : "json";
  const r = cli("--base", join(samples, `${c}-base.${ext}`), "--change", join(samples, `${c}-change.${ext}`), "--env", join(tmp, "env.txt"), "--tool-source", "package.json scripts.bench", ...extra);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

// --- known answers (fixtures/performance-proof/EXPECTED.md) -------------------------------------------------
test("planted cases give the expected status", () => {
  assert.equal(statusOf("c1"), "FAIL");
  assert.equal(statusOf("c2"), "INCONCLUSIVE");
  assert.equal(statusOf("c3"), "PASS");
  assert.equal(statusOf("c4"), "PASS");
  assert.equal(statusOf("c5"), "INCONCLUSIVE");
  assert.equal(statusOf("c6"), "INCONCLUSIVE");
  assert.equal(statusOf("c8"), "FAIL");
  assert.equal(statusOf("c8", { th: thresholds("", 20) }), "PASS");
  assert.equal(statusOf("c9", { direction: "higher" }), "FAIL");
});
test("traps: noise, tiny samples, equal medians and lower-is-better throughput are never PASS", () => {
  for (const c of ["c2", "c5", "c6"]) assert.notEqual(statusOf(c), "PASS", c);
  assert.equal(statusOf("c9"), "PASS", "read as lower-is-better the throughput drop looks like a win; --direction higher is required");
});
test("unit mismatch is refused, never compared", () => {
  const r = cli("--base", join(samples, "c7-base.json"), "--change", join(samples, "c7-change.json"));
  assert.equal(r.status, 2); assert.equal(r.stdout, ""); assert.match(r.stderr, /unit mismatch: base ms, change s/);
});

// --- statistics ---------------------------------------------------------------------------------------------
test("median, MAD, quartiles and IQR", () => {
  const s = stats([1, 2, 3, 4, 100]);
  assert.equal(s.median, 3); assert.equal(s.mad, 1); assert.equal(s.q1, 2); assert.equal(s.q3, 4); assert.equal(s.iqr, 2);
  assert.equal(s.min, 1); assert.equal(s.max, 100); assert.equal(s.n, 5);
  assert.equal(stats([4, 1, 3, 2]).median, 2.5);
});
test("the bootstrap is deterministic for a seed", () => {
  const [b, c] = pair("c2");
  assert.deepEqual(compare(b.samples, c.samples, { seed: 7 }).delta, compare(b.samples, c.samples, { seed: 7 }).delta);
  assert.notDeepEqual(compare(b.samples, c.samples, { seed: 7 }).delta, compare(b.samples, c.samples, { seed: 8 }).delta);
});
test("worst status: FAIL over INCONCLUSIVE over PASS", () => {
  assert.equal(worst(["PASS", "INCONCLUSIVE"]), "INCONCLUSIVE");
  assert.equal(worst(["INCONCLUSIVE", "FAIL", "PASS"]), "FAIL");
  assert.equal(worst([]), "PASS");
});

// --- thresholds ---------------------------------------------------------------------------------------------
test("thresholds: defaults, config, plan budget wins, invalid values and the min_runs floor", () => {
  assert.deepEqual([thresholds("").regression_pct, thresholds("").noise_pct, thresholds("").min_runs, thresholds("").source], [10, 5, 10, "default"]);
  const y = "risk:\n  x: 1\nperformance:\n  regression_pct: 15  # project budget\n  min_runs: 3\n  noise_pct: abc\nother: 1\n";
  const t = thresholds(y);
  assert.equal(t.regression_pct, 15); assert.equal(t.source, "config"); assert.equal(t.min_runs, 10); assert.equal(t.noise_pct, 5);
  assert.equal(t.notes.length, 2);
  const p = thresholds(y, 25); assert.equal(p.regression_pct, 25); assert.equal(p.source, "plan");
});

// --- sample files -------------------------------------------------------------------------------------------
test("sample files: a failed run, mixed units and non-positive values are refused", () => {
  const w = (n, s) => { writeFileSync(join(tmp, n), s); return join(tmp, n); };
  assert.throws(() => readSamples(w("f.csv", "run,side,value,unit,exit\n1,base,10,ms,0\n2,base,11,ms,1\n")), /exited 1/);
  assert.throws(() => readSamples(w("u.csv", "value,unit\n10,ms\n11,s\n")), /mixed units/);
  assert.throws(() => readSamples(w("z.json", '{"unit":"ms","samples":[1,0]}')), /positive/);
  assert.throws(() => readSamples(w("n.csv", "run,ms\n1,10\n")), /header/);
  assert.deepEqual(readSamples(w("ok.csv", "value,unit\n10,ms\n11.5,ms\n")), { unit: "ms", samples: [10, 11.5] });
});
test("environment file: numbers, tool versions", () => {
  const e = readEnv(ENV);
  assert.equal(e.cpu_count, 8); assert.equal(e.runs, 12); assert.equal(e.tool_versions.node, "v22.11.0"); assert.equal(e.order, "interleaved");
});

// --- validator ----------------------------------------------------------------------------------------------
test("compare-bench reports validate for every status", () => {
  for (const [c, want, extra] of [["c1", "FAIL", []], ["c2", "INCONCLUSIVE", []], ["c3", "PASS", []], ["c9", "FAIL", ["--direction", "higher"]], ["c8", "FAIL", []]]) {
    const r = report(c, ...extra);
    assert.equal(r.status, want, c);
    assert.deepEqual(validate(r), [], c);
  }
});
test("the environment block, tool and both sides are mandatory", () => {
  const a = report("c1"); delete a.environment; has(validate(a), "environment block is mandatory");
  const b = report("c1"); delete b.environment.load_avg_before; b.environment.order = "base-then-change"; has(validate(b), "load_avg_before"); has(validate(b), "interleaved");
  const c = report("c1"); c.tool.source = null; has(validate(c), "tool.source");
  const d = report("c1"); delete d.measurements[0].change; has(validate(d), "change samples are required");
  const e = report("c1"); e.measurements = []; has(validate(e), "at least one measurement");
});
test("status must follow from the samples: no PASS on noise, tiny samples or a tampered median", () => {
  const a = report("c2"); a.status = "PASS"; a.measurements[0].status = "PASS"; has(validate(a), "the samples and thresholds give INCONCLUSIVE");
  const b = report("c1"); b.measurements[0].change.median = 100; has(validate(b), "change.median");
  const c = report("c1"); c.measurements[0].change.samples = c.measurements[0].change.samples.slice(0, 3); has(validate(c), "give INCONCLUSIVE");
  const d = report("c1"); d.status = "INCONCLUSIVE"; has(validate(d), "give FAIL");
  const e = report("c3"); e.thresholds.min_runs = 2; has(validate(e), "min_runs >= 5");
  const f = report("c1"); f.measurements[0].change.unit = "s"; has(validate(f), "unit mismatch");
});
test("INCONCLUSIVE says it is not a FAIL and names the next step", () => {
  const a = report("c2"); a.summary = "M1 is INCONCLUSIVE."; has(validate(a), "not a FAIL");
  const b = report("c2"); delete b.next_step; has(validate(b), "next step");
});
test("no performance claim without a measurement", () => {
  const a = report("c3"); a.summary += " The change is 20% faster overall."; has(validate(a), "claim without a measurement");
  const b = report("c3"); b.summary += " M2 shows lower latency."; has(validate(b), "M2, which is not a measurement");
  const c = report("c3"); c.summary += " Nothing else was checked."; assert.deepEqual(validate(c), []);
});
test("judged findings: no numbers, and they fail only by a written criterion", () => {
  const j = { id: "J1", text: "N+1 query: listOrders loads each order's items in a loop (src/orders.js:42)", path: "src/orders.js", criterion: null, violates_criterion: false };
  const a = report("c3"); a.judged = [j]; assert.deepEqual(validate(a), [], "a judged N+1 alone does not change PASS");
  const b = report("c3"); b.judged = [{ ...j, text: "listOrders is 3x slower" }]; has(validate(b), "no measured number");
  const c = report("c3"); c.judged = [{ ...j, violates_criterion: true }]; has(validate(c), "quote the written spec or plan criterion");
  const d = report("c3"); d.judged = [{ ...j, violates_criterion: true, criterion: "PLAN.md ## Constraints: one query per page load" }]; has(validate(d), "give FAIL");
  d.status = "FAIL"; assert.deepEqual(validate(d), []);
});
test("UNSUPPORTED: no tool, no measurement, never PASS", () => {
  const u = { schema_version: 1, status: "UNSUPPORTED", unsupported_reason: "no benchmark command in package.json, Makefile or CI config", tool: null, environment: null,
    thresholds: null, measurements: [], judged: [], summary: "No benchmark tool exists in the project; nothing was measured.", next_step: "the user adds a benchmark command or waives the check" };
  assert.deepEqual(validate(u), []);
  has(validate({ ...u, measurements: report("c3").measurements }), "UNSUPPORTED has no measurements");
  has(validate({ ...u, unsupported_reason: "" }), "missing benchmark tool");
  has(validate({ ...u, summary: "Looks about 5% faster by reading the code." }), "claim without a measurement");
  has(validate({ ...u, status: "PASS", unsupported_reason: undefined }), "at least one measurement");
});
test("a REPORT.md is read through its json block", () => {
  const p = join(tmp, "REPORT.md");
  writeFileSync(p, "# Performance\n\n```json\n" + JSON.stringify(report("c3")) + "\n```\n");
  assert.deepEqual(validate(loadDoc(p)), []);
  const v = spawnSync(process.execPath, [join(scripts, "validate-performance.mjs"), p], { encoding: "utf8" });
  assert.equal(v.status, 0, v.stderr); assert.match(v.stdout, /valid: PASS/);
});

// --- run-bench.sh smoke (a trivial command, short N; no timing is asserted) -----------------------------------
test("run-bench.sh: interleaved samples, environment and exit codes", () => {
  const a = join(tmp, "wt-base"), b = join(tmp, "wt-change"), out = join(tmp, "bench");
  mkdirSync(a); mkdirSync(b);
  writeFileSync(join(b, "marker"), "");
  const run = (...args) => spawnSync("sh", [join(scripts, "run-bench.sh"), ...args], { encoding: "utf8", timeout: 60000 });
  const r = run("--base", a, "--change", b, "--runs", "2", "--warmup", "1", "--timeout", "30", "--out", out, "--", "sh", "-c", "test -d .");
  assert.equal(r.status, 0, r.stderr);
  for (const side of ["base", "change"]) {
    const rows = readFileSync(join(out, `${side}.csv`), "utf8").trim().split("\n");
    assert.equal(rows[0], "run,side,value,unit,exit,started_at");
    assert.equal(rows.length, 3);
    for (const row of rows.slice(1)) assert.match(row, new RegExp(`^\\d,${side},\\d+\\.\\d{3},ms,0,\\d{4}-`));
    assert.equal(readSamples(join(out, `${side}.csv`)).samples.length, 2);
  }
  const env = readEnv(readFileSync(join(out, "environment.txt"), "utf8"));
  for (const k of ["os", "load_avg_before", "load_avg_after", "command", "started_at", "finished_at", "timer"]) assert.ok(env[k], k);
  assert.equal(env.runs, 2); assert.equal(env.warmup_runs, 1); assert.equal(env.order, "interleaved"); assert.ok(env.cpu_count >= 1);
  // The command really ran in each directory: a command that only passes in the change directory fails on base.
  const f = run("--base", a, "--change", b, "--runs", "1", "--warmup", "0", "--timeout", "30", "--out", join(tmp, "bench2"), "--", "test", "-f", "marker");
  assert.equal(f.status, 1);
  assert.match(readFileSync(join(tmp, "bench2/base.csv"), "utf8"), /^1,base,[\d.]+,ms,1,/m);
  assert.match(readFileSync(join(tmp, "bench2/change.csv"), "utf8"), /^1,change,[\d.]+,ms,0,/m);
  assert.throws(() => readSamples(join(tmp, "bench2/base.csv")), /not a sample/);
  assert.equal(run("--base", a, "--change", b, "--runs", "1", "--timeout", "5", "--out", out, "--", "true").status, 2);
  assert.equal(run("--base", a, "--change", join(tmp, "missing"), "--runs", "1", "--out", out, "--", "true").status, 2);
  assert.equal(run("--base", a, "--change", b, "--runs", "1", "--out", out).status, 2);
});

// --- review round: verified thresholds, plan budget, direction of claims, copied data, submission text ------
const { planBudget } = await import(join(scripts, "compare-bench.mjs"));
const { submission } = await import(join(scripts, "validate-performance.mjs"));
const vcli = (...args) => spawnSync(process.execPath, [join(scripts, "validate-performance.mjs"), ...args], { encoding: "utf8" });
const save = (name, doc) => { const p = join(tmp, name); writeFileSync(p, JSON.stringify(doc)); return p; };

test("plan budget: read from the performance_critical flag line in ## Risk only, bounded to (0, 100]", () => {
  const b = (t) => planBudget(t).budget;
  assert.equal(b("# Plan\n\n## Risk\n\nperformance_critical: yes budget_pct=5\nconcurrency: no\n"), 5);
  assert.equal(b("## Risk\n- performance_critical: yes (p50) budget_pct=7.5\n"), 7.5);
  assert.equal(b("## Risk\nperformance_critical: yes budget_pct=100\n"), 100);
  assert.equal(b("## Risk\nperformance_critical: no budget_pct=5\n"), null);
  assert.equal(b("## Notes\nperformance_critical: yes budget_pct=5\n"), null);
  assert.deepEqual(planBudget("## Risk\nperformance_critical: yes\n"), { budget: null, note: null });
  for (const v of ["0", "150", "abc", "-5", ""]) {
    const r = planBudget(`## Risk\nperformance_critical: yes budget_pct=${v}\n`);
    assert.equal(r.budget, null, v); assert.match(r.note, /not a number in \(0, 100\]/, v);
  }
});
test("--budget-pct is a what-if: source cli (unverified), refused by the validator, which has no such option", () => {
  const r = report("c8", "--budget-pct", "20");
  assert.equal(r.status, "PASS"); assert.equal(r.thresholds.source, "cli (unverified)");
  has(validate(r), "source default|config|plan");
  assert.equal(cli("--base", join(samples, "c8-base.json"), "--change", join(samples, "c8-change.json"), "--budget-pct", "150").status, 2);
  assert.equal(vcli(save("c8cli.json", r), "--budget-pct", "20").status, 2);
});
test("an unparseable plan budget is a note in the report and the validator refuses that plan", () => {
  const plan = join(tmp, "PLAN-bad.md"); writeFileSync(plan, "## Risk\n\nperformance_critical: yes budget_pct=lots\n");
  const r = report("c8", "--plan", plan);
  assert.equal(r.thresholds.source, "default"); assert.match(r.thresholds.notes[0], /budget_pct=lots is not a number/);
  assert.deepEqual(validate(r), []);
  const v = vcli(save("c8bad.json", r), "--plan", plan);
  assert.equal(v.status, 1); assert.match(v.stderr, /budget_pct=lots is not a number/);
});
test("self-declared thresholds are caught when the config or plan is given", () => {
  const a = report("c1"); a.thresholds.regression_pct = 50; a.measurements[0].status = "PASS"; a.status = "PASS";
  // recomputed with its own (forged) threshold the report is consistent, so only the project's config exposes it
  assert.equal(validate(a).length, 0);
  has(validate(a, { expected: thresholds("") }), "the project's config and plan give 10");
  const cfg = join(tmp, "config.yaml"); writeFileSync(cfg, "performance:\n  regression_pct: 20\n");
  const plan = join(tmp, "PLAN.md"); writeFileSync(plan, "## Risk\n\nperformance_critical: yes budget_pct=20\n");
  const forged = save("forged.json", a);
  assert.equal(vcli(forged, "--config", cfg).status, 1);
  assert.match(vcli(forged).stdout, /thresholds unverified/);
  const b = report("c8", "--plan", plan); assert.equal(b.thresholds.source, "plan"); assert.equal(b.status, "PASS");
  const ok = vcli(save("c8plan.json", b), "--config", cfg, "--plan", plan);
  assert.equal(ok.status, 0, ok.stderr); assert.doesNotMatch(ok.stdout, /unverified/);
  const wrong = vcli(save("c8plan2.json", b), "--config", cfg);
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /source: is plan, the project's config and plan give config/);
  assert.equal(cli("--base", join(samples, "c8-base.json"), "--change", join(samples, "c8-change.json"), "--plan", plan, "--budget-pct", "5").status, 2);
});
test("environment runs must match the samples; identical sides are copied data", () => {
  const a = report("c1"); a.environment.runs = 20; has(validate(a), "environment.runs is 20");
  const b = report("c3"); b.measurements[0].change.samples = [...b.measurements[0].base.samples]; has(validate(b), "copied data");
});
test("a cited claim must agree in direction with its measurement", () => {
  const a = report("c1"); a.summary += " M1 shows the change is faster."; has(validate(a), "claims an improvement, but M1");
  const b = report("c4"); b.summary += " M1 is a slowdown."; has(validate(b), "claims a regression, but M1");
  const c = report("c4"); c.summary += " M1 shows no regression."; assert.deepEqual(validate(c), []);
  const d = report("c4"); d.summary += " M1: the change is faster."; assert.deepEqual(validate(d), []);
  const e = report("c1"); e.summary += " M1 and again M1 say faster."; assert.equal(validate(e).filter((x) => x.includes("claims an improvement")).length, 1);
});
test("--rows: INCONCLUSIVE and UNSUPPORTED reasons carry their prefix, FAIL gives blocking rows", () => {
  const i = submission(report("c2")); assert.equal(i.result, "UNSUPPORTED"); assert.match(i.reason, /^performance INCONCLUSIVE: M1 noise .*; not a FAIL; /);
  const f = submission(report("c1")); assert.equal(f.result, "FAIL"); assert.match(f.rows[0], /^blocking\|-\|M1 wall_time: median regression 30 % > threshold 10 %/);
  const r = vcli(save("c2.json", report("c2")), "--config", join(tmp, "none.yaml"), "--rows");
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^result: UNSUPPORTED\nreason: performance INCONCLUSIVE: /m);
});
test("calibration: deterministic, and no PASS or FAIL against the truth on clean data", async () => {
  const { calibrate } = await import(join(scripts, "calibrate.mjs"));
  const o = { trials: 30, noise: [3], effects: [0, 15], runs: [10], resamples: 300 };
  const a = calibrate(o);
  assert.deepEqual(a, calibrate(o));
  assert.equal(a[0].FAIL, 0); assert.equal(a[1].PASS, 0);
});

// --- review round 2 (A93): pinned bootstrap, direction from the unit, unverified thresholds never PASS ---------
const reshop = (doc, opts) => {
  // a tamperer recomputes everything consistently with the chosen constants, so only the pinning catches it
  const m = doc.measurements[0];
  const r = compare(m.base.samples, m.change.samples, { th: doc.thresholds, direction: m.direction, ...opts });
  Object.assign(m, { delta: r.delta, status: r.status, reason: r.reason, direction: opts.direction ?? m.direction });
  doc.status = r.status;
  return doc;
};
test("H1: the bootstrap seed, resamples and confidence are pinned; any other value is invalid", () => {
  assert.deepEqual(validate(report("c3")), []);
  has(validate(reshop(report("c2"), { seed: 19 })), "needs seed 1, resamples 2000 and confidence 0.95");
  has(validate(reshop(report("c2"), { resamples: 5000 })), "needs seed 1");
  const c = report("c3"); c.measurements[0].delta.confidence = 0.9; has(validate(c), "needs seed 1");
  const d = report("c3"); d.thresholds.confidence = 0.9; has(validate(d), "confidence 0.95 (pinned)");
  const e = report("c3"); delete e.measurements[0].delta.seed; has(validate(e), "needs seed 1");
  const f = cli("--base", join(samples, "c3-base.csv"), "--change", join(samples, "c3-change.csv"), "--seed", "19");
  assert.equal(f.status, 2, "compare-bench has no --seed");
});
test("H2: direction follows the unit; higher on a time and lower on a rate are refused", () => {
  const r = cli("--base", join(samples, "c1-base.json"), "--change", join(samples, "c1-change.json"), "--direction", "higher");
  assert.equal(r.status, 2); assert.match(r.stderr, /contradicts unit ms/);
  const l = cli("--base", join(samples, "c9-base.json"), "--change", join(samples, "c9-change.json"), "--direction", "lower");
  assert.equal(l.status, 2); assert.match(l.stderr, /contradicts unit ops\/s/);
  assert.equal(report("c9").status, "FAIL", "a rate without --direction is higher-is-better");
  assert.equal(report("c9").measurements[0].direction, "higher");
  // a +30 % time regression recomputed as higher-is-better becomes PASS; the validator refuses the direction
  const t = reshop(report("c1"), { direction: "higher" }); assert.equal(t.status, "PASS");
  has(validate(t), "unit ms (metric wall_time) is lower-is-better");
  const u = reshop(report("c1"), { direction: "higher" }); u.measurements[0].unit = "points"; has(validate(u), "metric wall_time) is lower-is-better");
  for (const [unit, want] of [["ms", "lower"], ["ns/op", "lower"], ["s", "lower"], ["µs", "lower"], ["ops/s", "higher"], ["req/s", "higher"], ["MB/s", "higher"], ["score", null]])
    assert.equal(cbUnitDirection(unit), want, unit);
});
const { unitDirection: cbUnitDirection } = await import(join(scripts, "compare-bench.mjs"));
test("M1: an unverified PASS is submitted as UNSUPPORTED with a blocking INCONCLUSIVE reason; only verified thresholds can PASS", () => {
  const cfg = join(tmp, "cfg-m1.yaml"); writeFileSync(cfg, "");
  const plan = join(tmp, "PLAN-m1.md"); writeFileSync(plan, "## Risk\n\nperformance_critical: yes\n");
  const f = save("c3-m1.json", report("c3"));
  const bare = vcli(f, "--rows");
  assert.equal(bare.status, 0, bare.stderr); assert.match(bare.stdout, /thresholds unverified/);
  assert.match(bare.stdout, /^result: UNSUPPORTED\nreason: performance INCONCLUSIVE: thresholds unverified/m);
  const half = vcli(f, "--config", cfg, "--rows");
  assert.match(half.stdout, /^result: UNSUPPORTED$/m, "--config without --plan is not verified");
  const both = vcli(f, "--config", cfg, "--plan", plan, "--rows");
  assert.equal(both.status, 0, both.stderr); assert.match(both.stdout, /^result: PASS$/m); assert.doesNotMatch(both.stdout, /unverified/);
  assert.equal(submission(report("c1"), undefined, { verified: false }).result, "FAIL", "a FAIL stays blocking");
});
test("L2: percent thresholds are bounded to (0, 100] in config and report", () => {
  const t = thresholds("performance:\n  regression_pct: 1000\n  noise_pct: 101\n");
  assert.equal(t.regression_pct, 10); assert.equal(t.noise_pct, 5); assert.equal(t.source, "default"); assert.equal(t.notes.length, 2);
  assert.equal(thresholds("performance:\n  regression_pct: 100\n").regression_pct, 100);
  const r = report("c3"); r.thresholds.noise_pct = 1000; has(validate(r), "in (0, 100]");
});

// --- re-review (A93): unit aliases; a unit without a known direction needs the plan's direction ---------------
const { planDirection } = await import(join(scripts, "compare-bench.mjs"));
test("unit aliases are times or rates in any case; µ/μ read as u", () => {
  for (const u of ["milliseconds", "msec", "MS", "Ms", "seconds", "sec", "usec", "nsec", "μs", "µs", "ns/op", "ms per op", "Minutes"]) assert.equal(cbUnitDirection(u), "lower", u);
  for (const u of ["ops/sec", "req/s", "fps", "Hz", "MB/s", "ops per second"]) assert.equal(cbUnitDirection(u), "higher", u);
  for (const u of ["score", "points", "bytes", "custom"]) assert.equal(cbUnitDirection(u), null, u);
  // an alias with --direction higher is refused like ms
  const w = (n, unit, xs) => { const p = join(tmp, n); writeFileSync(p, JSON.stringify({ unit, samples: xs })); return p; };
  const base = readSamples(join(samples, "c1-base.json")).samples, change = readSamples(join(samples, "c1-change.json")).samples;
  for (const unit of ["milliseconds", "MS", "μs"]) {
    const r = cli("--base", w(`b-${unit}.json`, unit, base), "--change", w(`c-${unit}.json`, unit, change), "--metric", "value", "--direction", "higher");
    assert.equal(r.status, 2, unit); assert.match(r.stderr, /contradicts unit/, unit);
  }
  const t = reshop(report("c1"), { direction: "higher" }); t.measurements[0].unit = "MSEC"; t.measurements[0].metric = "value";
  has(validate(t), "unit MSEC (metric value) is lower-is-better");
});
test("a unit without a known direction needs direction= on the plan's flag line, in compare-bench and the validator", () => {
  assert.equal(planDirection("## Risk\n\nperformance_critical: yes budget_pct=5 direction=higher\n"), "higher");
  assert.equal(planDirection("## Notes\nperformance_critical: yes direction=higher\n"), null);
  const w = (n, xs) => { const p = join(tmp, n); writeFileSync(p, JSON.stringify({ unit: "score", samples: xs })); return p; };
  const base = readSamples(join(samples, "c9-base.json")).samples, change = readSamples(join(samples, "c9-change.json")).samples;
  const b = w("score-b.json", base), c = w("score-c.json", change);
  for (const d of [[], ["--direction", "lower"], ["--direction", "higher"]]) {
    const r = cli("--base", b, "--change", c, ...d); assert.equal(r.status, 2, d.join(" ")); assert.match(r.stderr, /has no known direction/);
  }
  const plan = join(tmp, "PLAN-dir.md"); writeFileSync(plan, "## Risk\n\nperformance_critical: yes direction=higher\n");
  const r = cli("--base", b, "--change", c, "--plan", plan, "--env", join(tmp, "env.txt"), "--tool-source", "package.json");
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout); assert.equal(doc.measurements[0].direction, "higher"); assert.equal(doc.status, "FAIL");
  assert.equal(cli("--base", b, "--change", c, "--plan", plan, "--direction", "lower").status, 2);
  has(validate(doc), "unit score has no known direction");
  assert.deepEqual(validate(doc, { planDir: "higher" }), []);
  has(validate(doc, { planDir: "lower" }), "PLAN.md declares direction=lower");
  const cfg = join(tmp, "cfg-dir.yaml"); writeFileSync(cfg, "");
  const v = vcli(save("score.json", doc), "--config", cfg, "--plan", plan);
  assert.equal(v.status, 0, v.stderr);
  const bad = join(tmp, "PLAN-ms-higher.md"); writeFileSync(bad, "## Risk\n\nperformance_critical: yes direction=higher\n");
  assert.match(cli("--base", join(samples, "c1-base.json"), "--change", join(samples, "c1-change.json"), "--plan", bad).stderr, /contradicts unit ms/);
});
