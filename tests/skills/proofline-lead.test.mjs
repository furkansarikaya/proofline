import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const skill = join(repoRoot, "skills/proofline-lead");
const fixture = join(repoRoot, "fixtures/proofline-lead");
const script = join(skill, "scripts/check-result.mjs");
const { check, parseFindings, canonRole } = await import(script);
const SCHEMA = JSON.parse(readFileSync(join(skill, "schema/result-summary.schema.json"), "utf8"));
const SKILL = readFileSync(join(skill, "SKILL.md"), "utf8");

const FP = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const SHA = "a".repeat(64);
const TABLE = ["| id | severity | path:line | finding | evidence |", "|---|---|---|---|---|"];
function result({ role = "reviewer", task = "LK-7", focus = "rules", res = "PASS", conf = "high", fp = FP, art = `reviews/proof-review/rules/REPORT.md ${SHA}`, rows = [], tail = [], extra = [] } = {}) {
  const h = [`ROLE: ${role}`, `TASK: ${task}`];
  if (focus) h.push(`FOCUS: ${focus}`);
  h.push(`RESULT: ${res}`, `CONFIDENCE: ${conf}`, `FINGERPRINT: ${fp}`, `ARTIFACT: ${art}`, ...extra);
  return [...h, "", ...TABLE, ...rows, "", ...tail].join("\n");
}
const ok = (text, o) => { const r = check(text, o); assert.deepEqual(r.errors, []); return r.summary; };
const bad = (text, msg, o) => {
  const r = check(text, o);
  assert.ok(r.errors.some((e) => e.includes(msg)), `expected "${msg}" in ${JSON.stringify(r.errors)}`);
  assert.equal(r.summary, undefined);
};
const ROW_FAIL = "| REVIEW_RULES-1 | blocking | src/lookup.js:4 | empty key returns undefined | traced: lookup('') -> undefined |";
const ROW_INFO = "| REVIEW_RULES-2 | info | src/store.js:1 | naming suspicion | read only |";

// --- check-result: valid results --------------------------------------------------------------
test("a gate PASS is summarised and counts", () => {
  const s = ok(result({ rows: [ROW_INFO] }));
  assert.equal(s.kind, "gate"); assert.equal(s.gate, "REVIEW_RULES"); assert.equal(s.counts, true);
  assert.equal(s.pass_low, false); assert.equal(s.info_count, 1); assert.deepEqual(s.blocking, []);
  assert.deepEqual(s.artifact, { path: "reviews/proof-review/rules/REPORT.md", sha256: SHA });
});

test("a PASS with CONFIDENCE low is pass_low and does not count", () => {
  const s = ok(result({ role: "security_reviewer", focus: "", conf: "low", art: `security/REPORT.md ${SHA}` }));
  assert.equal(s.gate, "SECURITY"); assert.equal(s.pass_low, true); assert.equal(s.counts, false);
});

test("a FAIL yields blocking ids and the fix scope without lines", () => {
  const rows = [ROW_FAIL, "| REVIEW_RULES-3 | blocking | src/lookup.js:9-12 | second | traced |", "| REVIEW_RULES-4 | blocking | - | plan gap | traced |", ROW_INFO];
  const s = ok(result({ res: "FAIL", rows }));
  assert.deepEqual(s.blocking, ["REVIEW_RULES-1", "REVIEW_RULES-3", "REVIEW_RULES-4"]);
  assert.deepEqual(s.fix_scope, ["*", "src/lookup.js"]);
  assert.equal(s.counts, false);
});

test("a path:symbol row scopes to its path; a symbol without a path is not widened", () => {
  const s = ok(result({ res: "FAIL", rows: ["| REVIEW_RULES-1 | blocking | src/lookup.js:setTagFilter | wrong filter | traced |", "| REVIEW_RULES-2 | blocking | :setTagFilter | no path | traced |"] }));
  assert.deepEqual(s.fix_scope, ["src/lookup.js"]);
});

test("reviewer focus rules+tests maps to REVIEW_SMALL; aliases are canonical", () => {
  const s = ok(result({ role: "independent_reviewer", focus: "rules+tests", rows: [] }));
  assert.equal(s.role, "reviewer"); assert.equal(s.gate, "REVIEW_SMALL");
  assert.equal(canonRole("implementation_worker"), "implementer");
});

test("NEEDS_INPUT counts numbered questions; qa BLOCKED is a task result", () => {
  const q = ok(result({ role: "explorer", focus: "", res: "NEEDS_INPUT", conf: "medium", art: `results/001-explorer.md ${SHA}`,
    tail: ["QUESTIONS:", "1. Which value must lookup(\"\") return?", "   options: null | empty string", "   recommended: null", "   why: AC-1", "2. Second?", "   options: a | b", "   recommended: a", "   why: x"] }));
  assert.equal(q.kind, "task"); assert.equal(q.questions, 2);
  const b = ok(result({ role: "qa", focus: "", res: "BLOCKED", art: `QA_PLAN.md ${SHA}`, tail: ["BLOCKED_REASON: no test runner found"] }));
  assert.equal(b.kind, "task"); assert.equal(b.gate, null); assert.equal(b.blocked_reason, "no test runner found");
});

test("leading blank lines before the header are skipped", () => {
  const s = ok("\n\n" + result({ role: "task_author", focus: "", res: "DONE", art: `TASK.md ${SHA}`, rows: ["| task_author-1 | info | - | assumed default | stated in request |"] }));
  assert.equal(s.info_count, 1);
});

test("the summary has exactly the schema's properties", () => {
  const s = ok(result({ res: "FAIL", rows: [ROW_FAIL] }));
  assert.deepEqual(Object.keys(s).sort(), [...SCHEMA.required].sort());
  assert.deepEqual(Object.keys(SCHEMA.properties).sort(), [...SCHEMA.required].sort());
  assert.match(s.fingerprint, new RegExp(SCHEMA.properties.fingerprint.pattern));
});

// --- check-result: a dispatch in flight (A124) ------------------------------------------------
test("check-result on an empty result says the dispatch is in flight while its marker names a live pid", () => {
  const d = mkdtempSync(join(tmpdir(), "cr-inflight-"));
  try {
    const md = join(d, "003-verifier-claude.md");
    writeFileSync(md, "");
    writeFileSync(join(d, "003-verifier-claude.running"), `pid=${process.pid}\nrole=verifier\n`);
    const live = spawnSync("node", [script, md, "--role", "verifier", "--task", "T-1"], { encoding: "utf8" });
    assert.equal(live.status, 1);
    assert.match(live.stdout, new RegExp(`dispatch in flight \\(pid ${process.pid}\\): wait for the dispatch command to return`));
    writeFileSync(join(d, "003-verifier-claude.running"), "pid=999999999\nrole=verifier\n");
    const dead = spawnSync("node", [script, md, "--role", "verifier", "--task", "T-1"], { encoding: "utf8" });
    assert.match(dead.stdout, /malformed header: missing ROLE/);
    writeFileSync(join(d, "003-verifier-claude.running"), `pid=${process.pid}\nrole=verifier\n`);
    utimesSync(join(d, "003-verifier-claude.running"), 946684800, 946684800);
    const old = spawnSync("node", [script, md, "--role", "verifier", "--task", "T-1"], { encoding: "utf8" });
    assert.match(old.stdout, /malformed header: missing ROLE/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// --- check-result: each malformed class is rejected -------------------------------------------
test("rejects header problems", () => {
  bad(result({ extra: ["VERDICT: PASS"] }), "unknown key VERDICT");
  bad(result({ extra: ["CONFIDENCE: high"] }), "duplicate key CONFIDENCE");
  bad(result().replace(/^FINGERPRINT:.*\n/m, ""), "missing FINGERPRINT");
  bad("No header here\n" + result(), "missing ROLE");
  bad(result({ role: "planner" }), "unknown ROLE");
  bad(result({ conf: "sure" }), "invalid CONFIDENCE");
  bad(result({ fp: "HEAD" }), "not a git tree id");
});

test("rejects role, task and result mismatches", () => {
  bad(result(), "does not match the expected role", { role: "security_reviewer" });
  bad(result(), "TASK LK-7 does not match LK-8", { task: "LK-8" });
  bad(result({ role: "explorer", focus: "", res: "PASS" }), "RESULT PASS is not valid for role explorer");
  bad(result({ role: "lead", focus: "", res: "PASS" }), "RESULT PASS is not valid for role lead");
  bad(result({ role: "reviewer", res: "DONE" }), "RESULT DONE is not valid for role reviewer");
  bad(result({ role: "verifier", focus: "", res: "NEEDS_INPUT", tail: ["QUESTIONS:", "1. q?"] }), "RESULT NEEDS_INPUT is not valid for role verifier");
  bad(result({ focus: "" }), "reviewer results need FOCUS");
  bad(result({ focus: "style" }), "reviewer results need FOCUS");
});

// --- A94: risk-focus and UNSUPPORTED results mirror agent.sh record_validate ----------------------
const EV = `UNSUPPORTED_EVIDENCE: reports/snapshots/abc-reviewer-validator.txt ${"e".repeat(64)}`;
for (const focus of ["contract", "concurrency", "performance", "config"]) {
  test(`reviewer focus ${focus} is a valid gate result on REVIEW_RULES or REVIEW_SMALL`, () => {
    assert.equal(ok(result({ focus })).gate, "REVIEW_RULES");
    ok(result({ focus, res: "FAIL", rows: ["| REVIEW_SMALL-1 | blocking | src/a.js:1 | f | traced |"] }));
  });
}
for (const focus of ["contract", "performance"]) {
  test(`reviewer focus ${focus} may be UNSUPPORTED with a reason and its evidence`, () => {
    const s = ok(result({ focus, res: "UNSUPPORTED", rows: [ROW_INFO], extra: [] , tail: ["UNSUPPORTED_REASON: no compat tool on PATH", EV] }));
    assert.equal(s.result, "UNSUPPORTED"); assert.equal(s.counts, false); assert.equal(s.unsupported_reason, "no compat tool on PATH");
  });
}
test("A102: UNSUPPORTED needs its evidence line; concurrency and config have no UNSUPPORTED", () => {
  bad(result({ focus: "contract", res: "UNSUPPORTED", tail: ["UNSUPPORTED_REASON: no compat tool on PATH"] }), "needs an UNSUPPORTED_EVIDENCE line");
  bad(result({ focus: "contract", res: "UNSUPPORTED", tail: ["UNSUPPORTED_REASON: no compat tool on PATH", "UNSUPPORTED_EVIDENCE: ../x.txt " + "e".repeat(64)] }), "needs an UNSUPPORTED_EVIDENCE line");
  for (const focus of ["concurrency", "config"]) bad(result({ focus, res: "UNSUPPORTED", tail: ["UNSUPPORTED_REASON: no compat tool on PATH", EV] }), "always has a tool-free check");
});
test("reviewer focus migration lands on REVIEW_DATA; visual is qa; dependencies is security_reviewer", () => {
  assert.equal(ok(result({ focus: "migration" })).gate, "REVIEW_DATA");
  assert.equal(ok(result({ role: "qa", focus: "visual", art: `reviews/visual-proof/R.md ${SHA}` })).gate, "QA");
  assert.equal(ok(result({ role: "security_reviewer", focus: "dependencies", art: `security/dependencies/R.md ${SHA}` })).gate, "SECURITY");
  ok(result({ role: "qa", focus: "visual", res: "UNSUPPORTED", art: `reviews/visual-proof/R.md ${SHA}`, tail: ["UNSUPPORTED_REASON: no browser", EV] }));
});
test("UNSUPPORTED is rejected where agent.sh rejects it", () => {
  const T = ["UNSUPPORTED_REASON: x"];
  bad(result({ focus: "rules", res: "UNSUPPORTED", tail: T }), "risk focus only");
  bad(result({ focus: "contract", res: "UNSUPPORTED" }), "needs an UNSUPPORTED_REASON");
  bad(result({ focus: "contract", res: "UNSUPPORTED", rows: [ROW_FAIL], tail: T }), "cannot carry blocking findings");
  bad(result({ role: "security_reviewer", focus: "dependencies", res: "UNSUPPORTED", art: `security/dependencies/R.md ${SHA}`, tail: T }), "dependencies focus always");
  bad(result({ role: "explorer", focus: "", res: "UNSUPPORTED", tail: T }), "risk focus only");
  bad(result({ role: "qa", focus: "contract", art: `QA_REPORT.md ${SHA}` }), "not a focus of role qa");
});

test("rejects artifact problems", () => {
  bad(result({ art: "reviews/proof-review/rules/REPORT.md" }), "ARTIFACT needs");
  bad(result({ art: `/etc/passwd ${SHA}` }), "must be run-relative");
  bad(result({ art: `../x.md ${SHA}` }), "must be run-relative");
  bad(result({ art: "reviews/x.md deadbeef" }), "sha256 is not 64 hex");
});

test("rejects findings problems", () => {
  bad(result({ res: "FAIL", rows: ["| REVIEW_RULES-1 | blocking | src/a.js:1 | short row |"] }), "malformed findings row");
  bad(result({ res: "FAIL", rows: ["| SECURITY-1 | blocking | src/a.js:1 | f | e |"] }), "invalid finding id SECURITY-1 (want REVIEW_RULES-<n>)");
  bad(result({ res: "FAIL", rows: ["| REVIEW_RULES-1 | HIGH | src/a.js:1 | f | e |"] }), "invalid finding severity HIGH");
  bad(result({ res: "FAIL", rows: [ROW_FAIL, ROW_FAIL] }), "duplicate finding ids");
  bad(result({ res: "FAIL", rows: [ROW_INFO] }), "FAIL needs at least one blocking finding");
  bad(result({ res: "PASS", rows: [ROW_FAIL] }), "PASS cannot carry blocking findings");
  bad(result({ role: "explorer", focus: "", res: "DONE", art: `results/001-explorer.md ${SHA}`, rows: ["| E-1 | info | a.js:1 | f | e |"] }), "invalid finding id E-1 (want explorer-<n>)");
});

test("rejects BLOCKED without a reason and NEEDS_INPUT without questions", () => {
  bad(result({ res: "BLOCKED" }), "BLOCKED needs a BLOCKED_REASON line");
  bad(result({ res: "BLOCKED", tail: ["BLOCKED_REASON:   "] }), "BLOCKED needs a BLOCKED_REASON line");
  bad(result({ role: "explorer", focus: "", res: "NEEDS_INPUT", art: `results/001-explorer.md ${SHA}` }), "NEEDS_INPUT needs a QUESTIONS: block");
  bad(result({ role: "explorer", focus: "", res: "NEEDS_INPUT", art: `results/001-explorer.md ${SHA}`, tail: ["QUESTIONS:", "   ", "BLOCKED_REASON: x"] }), "NEEDS_INPUT needs a QUESTIONS: block");
});

test("parseFindings skips header and separator rows only", () => {
  assert.deepEqual(parseFindings([...TABLE, "| x-1 | info | a:1 | f | e |"]), [["x-1", "info", "a:1", "f", "e"]]);
});

test("CLI: exit 0 with JSON, 1 with messages, 2 on usage; reads stdin with -", () => {
  const run = (args, input) => spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8" });
  const good = run(["-", "--role", "reviewer", "--task", "LK-7"], result({ res: "FAIL", rows: [ROW_FAIL] }));
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.equal(JSON.parse(good.stdout).gate, "REVIEW_RULES");
  const malformed = run(["-"], result({ res: "FAIL" }));
  assert.equal(malformed.status, 1); assert.match(malformed.stdout, /FAIL needs at least one blocking finding/);
  assert.equal(run([]).status, 2);
  assert.equal(run(["-", "--role"]).status, 2);
  assert.equal(run([join(tmpdir(), "no-such-proofline-result.md")]).status, 2);
});

// --- SKILL.md and bundle structure ----------------------------------------------------------
test("SKILL.md frontmatter and size follow the skill spec", () => {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(SKILL)[1];
  assert.match(fm, /^name: proofline-lead$/m);
  assert.match(fm, /^license: MIT$/m);
  assert.match(fm, /^disable-model-invocation: true$/m);
  assert.match(fm, /^ {2}version: "0\.0\.13"$/m);
  const desc = /^description: (.*)$/m.exec(fm)[1];
  assert.ok(desc.length <= 900, `description is ${desc.length} chars`);
  assert.ok(SKILL.split("\n").length < 500);
});

test("every relative link in the skill bundle resolves", () => {
  const files = ["SKILL.md", ...readdirSync(join(skill, "references")).map((f) => `references/${f}`)];
  for (const f of files) {
    const text = readFileSync(join(skill, f), "utf8");
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(join(skill, f)), target)), `${f}: broken link ${target}`);
    }
  }
  for (const r of ["LIFECYCLE", "DISPATCH", "HANDOFF", "GATES-AND-FIXES", "DELIVERY", "FAILOVER", "REPORT"]) {
    assert.ok(SKILL.includes(`(references/${r}.md`), `SKILL.md does not link ${r}.md`);
  }
});

test("the completion report asset has the control-plane template's sections in order", () => {
  const heads = (p) => readFileSync(p, "utf8").split("\n").filter((l) => /^## /.test(l));
  assert.deepEqual(heads(join(skill, "assets/COMPLETION_REPORT.md")), heads(join(repoRoot, "control-plane/agents/templates/COMPLETION_REPORT.md")));
});

test("SKILL.md maps every D23 command and the rules that keep the lead out of verdicts", () => {
  for (const c of ["`/proofline`", "`run <TASK>`", "`resume`", "`queue`", "`task [--grill]`", "`design system\\|data\\|api\\|ui [--check]`", "`review`", "`audit`", "`debug`", "`deliver <TASK>`", "`clean`"]) {
    assert.ok(SKILL.includes(`| ${c} |`), `command ${c} missing from the commands table`);
  }
  for (const s of ["never runs `agent.sh record`", "verbatim", "`A decide` once", "Never both", "max_fix_rounds", "`SECRETS` or `SECURITY`", "hook-captured", "`proofline-security-reviewer`", "never waives on its own"]) {
    assert.ok(SKILL.includes(s), `SKILL.md lacks "${s}"`);
  }
});

test("the shared-rules block is byte-identical", () => {
  const r = spawnSync("sh", [join(repoRoot, "tests/shared/check-shared.sh"), "proofline-lead"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// --- fixture: every state is real and EXPECTED.md names the step agent.sh prints -----------------
// Building the gate-heavy states drives agent.sh for ~1.5 minutes each (~8 minutes in all). The cheap states
// (a pending question, a destructive plan) always run; set PROOFLINE_SLOW_TESTS=1 for every state.
const SLOW = process.env.PROOFLINE_SLOW_TESTS === "1";
const FAST_STATES = ["needs-input", "destructive-approval"];
const SLOW_STATES = ["review-rules-fail", "security-pass-low", "fix-rounds-exhausted"];
const STATES = SLOW ? [...SLOW_STATES, ...FAST_STATES] : FAST_STATES;
let base;
const built = {};
before(async () => {
  base = mkdtempSync(join(tmpdir(), "plfx-"));
  await Promise.all(STATES.map((s) => new Promise((done) => {
    const p = spawn("sh", [join(fixture, "setup.sh"), join(base, s), s], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => { built[s] = { code, err }; done(); });
  })));
}, { timeout: 1800000 });
after(() => rmSync(base, { recursive: true, force: true }));

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
delete env.AGENT_ROLE;
const agent = (s, ...args) => spawnSync("sh", [".agents/scripts/agent.sh", ...args], { cwd: join(base, s), env, encoding: "utf8" });
const EXPECTED = readFileSync(join(fixture, "EXPECTED.md"), "utf8");
function expectedFor(state) {
  const m = new RegExp(`^## ${state}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(EXPECTED);
  assert.ok(m, `EXPECTED.md has no section for ${state}`);
  return m[1];
}

for (const s of STATES) {
  test(`fixture state ${s}: agent.sh next prints the step EXPECTED.md names`, () => {
    assert.equal(built[s].code, 0, built[s].err);
    const sec = expectedFor(s);
    const want = /^- next: `([^`]+)`$/m.exec(sec)[1];
    const got = agent(s, "next", "LK-7").stdout.split("\n").find((l) => l.startsWith("next="));
    assert.equal(got, `next=${want}`);
    assert.match(sec, /^- do: /m); assert.match(sec, /^- must not: /m);
  });
}

test("fixture: selfcheck.sh passes on the built states and the branch is the task branch", { skip: !SLOW && "PROOFLINE_SLOW_TESTS=1" }, () => {
  const r = spawnSync("sh", [join(fixture, "selfcheck.sh"), base], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const br = spawnSync("git", ["-C", join(base, "security-pass-low"), "branch", "--show-current"], { env, encoding: "utf8" });
  assert.equal(br.stdout.trim(), "proofline/LK-7-empty-key-default");
});

test("fixture: the pending question is stored verbatim and the frozen destructive plan is not implemented", () => {
  const q = agent("needs-input", "questions", "LK-7");
  assert.equal(q.status, 0, q.stderr);
  assert.match(q.stdout, /1\. Which value must lookup\(""\) return\?\n {3}options: null \| empty string \| throw\n {3}recommended: null/);
  const p = agent("destructive-approval", "pipeline", "LK-7").stdout;
  assert.match(p, /^classification=CRITICAL$/m);
  const n = agent("destructive-approval", "next", "LK-7").stdout;
  assert.match(n, /^handoff=PLANNED$/m);
  assert.match(n, /^reason=destructive approval required before IMPLEMENT$/m);
  const h = agent("destructive-approval", "handoff", "LK-7", "IMPLEMENTING");
  assert.notEqual(h.status, 0, "IMPLEMENTING must be refused without a destructive approval");
  assert.match(h.stdout + h.stderr, /destructive approval/);
});

// These two change run state: keep them last.
test("fixture: decide escalates the pass_low security re-run on the installed policy", { skip: !SLOW && "PROOFLINE_SLOW_TESTS=1" }, () => {
  const d = agent("security-pass-low", "decide", "LK-7", "security_reviewer");
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /^signals=.*low_confidence_pass/m);
  assert.match(d.stdout, /^escalated=yes$/m);
});

test("fixture: a third fix round is refused when the rounds are exhausted", { skip: !SLOW && "PROOFLINE_SLOW_TESTS=1" }, () => {
  const h = agent("fix-rounds-exhausted", "handoff", "LK-7", "IMPLEMENTING");
  assert.notEqual(h.status, 0);
  assert.match(h.stdout + h.stderr, /fix rounds exhausted/);
});

test("the lead never brackets the implementer and names the final focus mapping and artifacts", () => {
  const dispatch = readFileSync(join(skill, "references/DISPATCH.md"), "utf8");
  const gates = readFileSync(join(skill, "references/GATES-AND-FIXES.md"), "utf8");
  assert.doesNotMatch(dispatch, /W=\$\(A window-open/);
  assert.match(dispatch, /SubagentStart/);
  assert.match(dispatch, /calls neither\s+`window-open` nor `window-close`/);
  for (const s of ["rules+bugs", "reviews/proof-review/plan/REPORT.md", "reviews/proof-review/rules/REPORT.md", "reviews/proof-review/small/REPORT.md", "reviews/test-trust/tests/REPORT.md", "reviews/data-design/REVIEW.md", "security/REPORT.md"]) {
    assert.ok(gates.includes(s), `GATES-AND-FIXES.md lacks ${s}`);
  }
  assert.match(dispatch, /blocking\\\|info/);
});

test("check-result accepts the QA ids: qa-<n> for the plan step, QA-<n> for the gate", () => {
  ok(result({ role: "qa", focus: "", res: "DONE", art: `QA_PLAN.md ${SHA}`, rows: ["| qa-1 | info | a.js:1 | f | e |"] }));
  ok(result({ role: "qa", focus: "", res: "FAIL", art: `QA_REPORT.md ${SHA}`, rows: ["| QA-1 | blocking | a.js:1 | f | e |"] }));
});

test("intake follows the order agent.sh next prints: classify, branch, baseline (no 'known exception')", () => {
  const ref = (f) => readFileSync(join(skill, "references", f), "utf8");
  assert.doesNotMatch(SKILL, /[Kk]nown exception/);
  const intake = SKILL.slice(SKILL.indexOf("## Intake"), SKILL.indexOf("## Flow"));
  const at = (s) => { const i = intake.indexOf(s); assert.ok(i >= 0, `intake lacks ${s}`); return i; };
  assert.ok(at("`A classify <ID>") < at("`A branch <ID>`") && at("`A branch <ID>`") < at("`A baseline <ID>`"));
  assert.match(ref("LIFECYCLE.md"), /intake -> classify -> branch -> baseline/);
  const agentSh = readFileSync(join(repoRoot, "control-plane/agents/scripts/agent.sh"), "utf8");
  assert.ok(agentSh.indexOf('o "agent.sh classify') < agentSh.indexOf('o "agent.sh branch'), "agent.sh next no longer prints classify before branch");
});

test("dispatch assignments and the PR body live in .agents/local/assignments/<ID>/; failover never decides before dispatch.sh", () => {
  const ref = (f) => readFileSync(join(skill, "references", f), "utf8");
  for (const [n, t] of [["SKILL.md", SKILL], ["DISPATCH.md", ref("DISPATCH.md")], ["DELIVERY.md", ref("DELIVERY.md")], ["FAILOVER.md", ref("FAILOVER.md")]]) {
    assert.ok(t.includes(".agents/local/assignments/<ID>/"), `${n} does not name .agents/local/assignments/<ID>/`);
  }
  assert.doesNotMatch(ref("DELIVERY.md"), /<file in \.agents\/local\/>/);
  const fo = ref("FAILOVER.md");
  assert.doesNotMatch(fo, /its decision meets the floor/);
  assert.match(fo, /never calls `A decide`/);
  assert.match(fo, /\| `ask` \| stores the question with `A ask`/);
  assert.match(ref("DISPATCH.md"), /Never call `A decide` before `D` \(also not for a failover/);
});

test("the lead's own questions go through agent.sh ask, which agent.sh and dispatch.sh implement", () => {
  assert.match(SKILL, /`A ask <ID>`/);
  assert.match(readFileSync(join(skill, "references/HANDOFF.md"), "utf8"), /stored with `A ask <ID>`/);
  const agentSh = readFileSync(join(repoRoot, "control-plane/agents/scripts/agent.sh"), "utf8");
  assert.match(agentSh, /^ {2}ask\) require_lead;/m);
  assert.match(readFileSync(join(repoRoot, "control-plane/agents/scripts/dispatch.sh"), "utf8"), /"\$agent" ask "\$id" --file/);
});

// ---- A153: observations become tasks only after the user approves; debt page is a script ----
test("LIFECYCLE section 7: observations are proposed, written by the task author only after approval", () => {
  const life = readFileSync(join(skill, "references/LIFECYCLE.md"), "utf8");
  const s7 = life.slice(life.indexOf("## 7. Knowledge"), life.indexOf("## 8. "));
  const obs = s7.slice(s7.indexOf("**Observations.**")).split("\n\n")[0].replace(/\s+/g, " ");
  assert.match(obs, /Show them to the user as proposed new tasks/);
  assert.match(obs, /ask which to keep/);
  assert.match(obs, /For each the user approves, dispatch the task-author .*writes the task to `tasks\.dir`/);
  assert.match(obs, /Without the user's approval nothing is written/);
  assert.match(obs, /implementer never fixes them and no gate counts them/);
  // the other sources say the same: the knowledge step and the implementer role
  const know = readFileSync(join(repoRoot, "control-plane/agents/KNOWLEDGE.md"), "utf8");
  assert.match(know, /`## Observations`\) are proposed to the user as new tasks and written to `tasks\.dir` by the task author only after the user approves/);
  assert.match(know, /`agent\.sh debt page` rewrites the one wiki page `docs\/wiki\/concepts\/shortcut-debt\.md`/);
  const impl = readFileSync(join(repoRoot, "roles/implementer.md"), "utf8");
  assert.match(impl, /Fix an observation, or write it to the task folder/);
  assert.match(impl, /Nothing in an observation is fixed, tested or written to a task by you/);
});
