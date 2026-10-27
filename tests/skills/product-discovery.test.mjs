import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SKILL = fileURLToPath(new URL("../../skills/product-discovery/", import.meta.url));
const run = (script, args) => spawnSync("node", [join(SKILL, "scripts", script), ...args], { encoding: "utf8" });
const json = (script, args) => { const r = run(script, [...args, "--json"]); return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr }; };
const rules = (r) => r.out.findings.map((f) => f.rule);

const INTERVIEWS = [
  "# Interviews: orders export", "", "- INT-1 finance lead, 2026-10-01", "",
  '- C-1 Finance copies about 400 rows each month. [fact: interview INT-1 "I copy around 400 rows every month"]', "",
].join("\n");
// the profile block and the implications that a competitor table needs (all values unknown is an honest profile)
const PROFILE = "\n## Profiles\n\n### Acme\n- sells to: unknown\n- positioning: unknown\n- pricing model: unknown\n- praised: unknown\n- complained: unknown\n- switching cost: unknown\n\n## Implications for us\n\n- Acme's price page sets the number we compare with.\n";
// RESEARCH.md around a list of claim lines: a search plan before, the gaps after
const research = (claims, plan = "- SQ-1 What does Acme charge?; queries: \"acme pricing\" | \"acme per seat\"; sources: pricing, reviews", gaps = "- SQ-1 No second price source found.") =>
  `# R\n\n## Search plan\n\n${plan}\n\n## Claims\n\n${claims}\n\n## Searched, not found\n\n${gaps}\n`;
const RAW = "Interviewer: how do you export?\nFinance:   I copy around\n400 rows every month, by hand.\n";

// a project with docs/product/x/INTERVIEWS.md and the raw text of INT-1 under .agents/local
function project(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "product-discovery-"));
  const dir = join(root, "docs/product/x");
  mkdirSync(dir, { recursive: true });
  for (const [n, t] of Object.entries({ "INTERVIEWS.md": INTERVIEWS, ...files })) writeFileSync(join(dir, n), t);
  mkdirSync(join(root, ".agents/local/product-discovery/x/interviews"), { recursive: true });
  writeFileSync(join(root, ".agents/local/.gitignore"), "*\n");
  writeFileSync(join(root, ".agents/local/product-discovery/x/interviews/INT-1.txt"), RAW);
  return root;
}
const git = (root, ...a) => { const r = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }); return r; };

test("a quote that occurs in the raw text (whitespace-normalised) passes; an absent quote or a missing raw text is rejected", () => {
  const root = project();
  assert.equal(run("check-quotes.mjs", ["x", "--root", root]).status, 0);
  writeFileSync(join(root, "docs/product/x/INTERVIEWS.md"), INTERVIEWS.replace("I copy around 400 rows every month", "I copy nearly 500 rows every month").replace("about 400", "about 500"));
  const bad = json("check-quotes.mjs", ["x", "--root", root]);
  assert.equal(bad.status, 1);
  assert.deepEqual(rules(bad), ["quote-not-in-raw"]);
  rmSync(join(root, ".agents/local/product-discovery/x/interviews/INT-1.txt"));
  const gone = json("check-quotes.mjs", ["x", "--root", root]);
  assert.equal(gone.status, 1);
  assert.deepEqual(rules(gone), ["unverifiable"]);
  rmSync(root, { recursive: true, force: true });
});

test("raw interview text is not tracked by git and is ignored", () => {
  const root = project();
  git(root, "init", "-q", "-b", "main");
  assert.equal(run("check-quotes.mjs", ["x", "--privacy", "--root", root]).status, 0);
  const f = ".agents/local/product-discovery/x/interviews/INT-1.txt";
  git(root, "add", "-f", f);
  const tracked = json("check-quotes.mjs", ["x", "--privacy", "--root", root]);
  assert.equal(tracked.status, 1);
  assert.match(tracked.out.findings[0].message, /tracked by git/);
  git(root, "rm", "-q", "--cached", f);
  rmSync(join(root, ".agents/local/.gitignore"));
  const open = json("check-quotes.mjs", ["x", "--privacy", "--root", root]);
  assert.equal(open.status, 1);
  assert.match(open.out.findings[0].message, /not ignored/);
  rmSync(root, { recursive: true, force: true });
});

test("a competitor cell older than product.stale_days is flagged stale; a value without its source is rejected", () => {
  const head = "| Competitor | Attribute | Value | Source | Observed | Quote |\n|---|---|---|---|---|---|\n";
  const row = (date) => `| Acme | Price | 10 USD per month | https://acme.example/pricing | ${date} | "From 10 USD per month" |\n`;
  const root = project({ "COMPETITORS.md": head + row("2026-10-01") + "| Acme | Formats | | | | |\n" + PROFILE });
  const fresh = json("check-competitors.mjs", ["x", "--root", root, "--today", "2026-10-20"]);
  assert.equal(fresh.status, 0);
  assert.deepEqual(fresh.out.stale, []);
  const old = json("check-competitors.mjs", ["x", "--root", root, "--today", "2027-01-20"]);
  assert.equal(old.status, 0);
  assert.equal(old.out.stale.length, 1);
  assert.equal(old.out.stale[0].ageDays, 111);
  assert.match(run("check-competitors.mjs", ["x", "--root", root, "--today", "2027-01-20"]).stderr, /stale: .*Acme \/ Price/);
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents/config.yaml"), "product:\n  stale_days: 200\n");
  assert.equal(json("check-competitors.mjs", ["x", "--root", root, "--today", "2027-01-20"]).out.stale.length, 0);
  writeFileSync(join(root, "docs/product/x/COMPETITORS.md"), head + "| Acme | Price | 10 USD per month | | | |\n" + PROFILE);
  const unverifiable = json("check-competitors.mjs", ["x", "--root", root, "--today", "2026-10-20"]);
  assert.equal(unverifiable.status, 1);
  assert.deepEqual(rules(unverifiable), ["unverifiable-value"]);
  rmSync(root, { recursive: true, force: true });
});

test("a number is accepted only as a sourced fact whose quote holds it", () => {
  const ok = '- C-5 The market is worth 2.4 billion USD. [fact: web https://r.example/m accessed 2026-10-01 "worth 2.4 billion USD in 2025"]';
  const root = project({ "RESEARCH.md": research(`${ok}\n- C-2 Teams export weekly. [assumption: value]`) });
  assert.equal(run("check-research.mjs", ["x", "--root", root]).status, 0);
  const w = (t) => { writeFileSync(join(root, "docs/product/x/RESEARCH.md"), research(t)); return json("check-research.mjs", ["x", "--root", root]); };
  const a = w("- C-2 The market is worth 2.4 billion USD. [assumption: viability]");
  assert.equal(a.status, 1);
  assert.deepEqual(rules(a), ["unsourced-number"]);
  assert.deepEqual(rules(w("- C-2 Churn is 40% a year.")), ["unmarked", "unsourced-number"]);
  assert.deepEqual(rules(w(ok.replace("2.4 billion", "3.1 billion"))), ["number-not-in-quote"]);
  assert.deepEqual(rules(w("- Persona: Anna, an accountant [assumption: value]")), ["persona-without-source"]);
  rmSync(root, { recursive: true, force: true });
});

test("an opportunity needs existing evidence and a place in the Mermaid tree", () => {
  const good = "# O\n\n- OP-1 Export is manual. C-1, INT-1\n- OP-2 A summary may help. [assumption: value]\n- S-1 One-click export for OP-1.\n\n```mermaid\ngraph TD\n  G --> OP-1\n  G --> OP-2\n```\n\n## Ranking\n\n- R-1 OP-1 evidence: strong; users: C-1; fit: removes the copying; effort: small; reason: two sources agree\n- R-2 OP-2 evidence: weak; users: estimate \"one interview and a guess\"; fit: indirect; effort: medium; reason: nobody asked for it\n";
  const root = project({ "OPPORTUNITIES.md": good });
  assert.equal(run("check-opportunities.mjs", ["x", "--root", root]).status, 0);
  const w = (t) => { writeFileSync(join(root, "docs/product/x/OPPORTUNITIES.md"), t); return json("check-opportunities.mjs", ["x", "--root", root]); };
  assert.deepEqual(rules(w(good.replace("C-1, INT-1", "and so on"))), ["no-evidence"]);
  assert.deepEqual(rules(w(good.replace("C-1, INT-1", "C-9"))), ["dangling-evidence"]);
  assert.deepEqual(rules(w(good.replace("  G --> OP-2\n", ""))), ["not-in-diagram"]);
  rmSync(root, { recursive: true, force: true });
});

test("a discovery claim is citable from a PRD with ref, and the validator copy is the product-spec one", () => {
  const root = project();
  const prd = join(root, "doc.md");
  writeFileSync(prd, "# P\n\n## Problem\n\nFinance exports by hand. [fact: ref x#C-1]\nAnother. [fact: ref x#C-7]\n");
  const r = spawnSync("node", [join(SKILL, "scripts/validate-product-claims.mjs"), prd, "--json", "--root", root], { encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].message, /x#C-7 not found/);
  assert.equal(readFileSync(join(SKILL, "scripts/validate-product-claims.mjs"), "utf8"), readFileSync(join(SKILL, "../product-spec/scripts/validate-product-claims.mjs"), "utf8"));
  rmSync(root, { recursive: true, force: true });
});

test("a COMPETITORS.md without a table is no-table; a quote of only ellipses is rejected; --privacy without interviews says nothing to check", async () => {
  const root = project({ "COMPETITORS.md": "# Competitors\n\nNothing here yet.\n" });
  const nt = json("check-competitors.mjs", ["x", "--root", root]);
  assert.equal(nt.status, 1);
  assert.deepEqual(rules(nt), ["no-table"]);
  const { occurs } = await import(join(SKILL, "scripts/check-quotes.mjs"));
  assert.equal(occurs(RAW, "..."), false);
  assert.equal(occurs(RAW, "\u2026 ..."), false);
  assert.equal(occurs(RAW, "I copy ... by hand"), true);
  rmSync(join(root, ".agents/local/product-discovery"), { recursive: true });
  const pr = run("check-quotes.mjs", ["x", "--privacy", "--root", root]);
  assert.equal(pr.status, 0);
  assert.match(pr.stdout, /nothing to check/);
  rmSync(root, { recursive: true, force: true });
});

// ---- proposals, estimates, method, profiles, ranking, insights ----

test("a number in an assumption is accepted only as an estimate with a basis; a fact without a source is still rejected", () => {
  const root = project();
  const w = (t) => { writeFileSync(join(root, "docs/product/x/RESEARCH.md"), research(t)); return json("check-research.mjs", ["x", "--root", root]); };
  const est = (b) => `- C-2 About 400 rows are copied each month. [assumption: value estimate "${b}"]`;
  assert.equal(w(est("one interview says 400, the range allows a quiet month")).status, 0);
  assert.deepEqual(rules(w(est("guess"))), ["invalid-marker", "unsourced-number"]);
  assert.deepEqual(rules(w("- C-2 About 400 rows are copied each month. [assumption: value]")), ["unsourced-number"]);
  assert.deepEqual(rules(w("- C-2 The market is 40 percent smaller. [fact]")), ["invalid-marker", "unsourced-number"]);
  assert.deepEqual(rules(w('- C-2 It costs 5 USD. [decision: by owner because the budget is 5 USD]')), ["unsourced-number"]);
  rmSync(root, { recursive: true, force: true });
});

test("a pending proposal is rejected; an accepted agent proposal passes; a rejected one is listed under Rejected proposals", () => {
  const root = project();
  const w = (t, extra = "") => { writeFileSync(join(root, "docs/product/x/RESEARCH.md"), research(t).replace("## Searched, not found", `${extra}## Searched, not found`)); return json("check-research.mjs", ["x", "--root", root]); };
  assert.deepEqual(rules(w("- C-2 Teams may export by hand. [proposal: risk]")), ["pending-proposal"]);
  assert.equal(w("- C-2 Teams may export by hand. [assumption: value source agent accepted by user]").status, 0);
  assert.deepEqual(rules(w("- C-2 Teams may export by hand. [assumption: value source agent]")), ["invalid-marker"]);
  assert.equal(w("- C-2 Teams export weekly. [assumption: value]", "## Rejected proposals\n\n- RP-1 Add a mobile app rejected by user: out of scope\n\n").status, 0);
  assert.deepEqual(rules(w("- C-2 Teams export weekly. [assumption: value]", "## Rejected proposals\n\n- RP-1 Add a mobile app\n\n")), ["rejected-proposal"]);
  rmSync(root, { recursive: true, force: true });
});

test("research method: an unanswered search question, a missing plan or gap list, and a critical fact with one source are rejected", () => {
  const root = project();
  const claim = (id, host, extra = "") => `- C-${id} (SQ-1) ${extra}Acme charges 10 USD per seat. [fact: web https://${host}/p accessed 2026-10-01 "10 USD per seat"]`;
  const w = (text) => { writeFileSync(join(root, "docs/product/x/RESEARCH.md"), text); return json("check-research.mjs", ["x", "--root", root, "--today", "2026-10-20"]); };
  assert.equal(w(research(claim(3, "a.example"), undefined, "- none")).status, 0);
  assert.deepEqual(rules(w(research("- C-3 A claim that names no query. [assumption: value]", undefined, "- none"))), ["query-unanswered"]);
  assert.deepEqual(rules(w("# R\n\n## Claims\n\n- C-3 x. [assumption: value]\n")).sort(), ["no-not-found", "no-search-plan"]);
  assert.deepEqual(rules(w(research(claim(3, "a.example"), "- SQ-1 Price?; queries: acme price; sources: tarot"))), ["plan-field"]);
  const crit = (second, host2) => w(research(`${claim(3, "a.example", `(critical; second source: ${second}) `)}\n${claim(4, host2)}`, undefined, "- none"));
  assert.equal(crit("C-4", "b.example").status, 0);
  assert.deepEqual(rules(crit("C-4", "www.a.example")), ["not-independent"]);
  assert.deepEqual(rules(crit("C-9", "b.example")), ["critical-needs-second-source"]);
  crit("C-4", "b.example");
  const stale = json("check-research.mjs", ["x", "--root", root, "--today", "2027-02-01"]);
  assert.equal(stale.status, 0);
  assert.equal(stale.out.stale.length, 2);
  rmSync(root, { recursive: true, force: true });
});

test("competitor profiles: a missing profile, an unsourced review line and a missing implication are rejected", () => {
  const head = "| Competitor | Attribute | Value | Source | Observed | Quote |\n|---|---|---|---|---|---|\n| Acme | Formats | | | | |\n";
  const prof = (lines, impl = "- Acme's reviewers complain about manual export.") => `\n## Profiles\n\n### Acme\n${lines}\n\n## Implications for us\n\n${impl}\n`;
  const all = (over = {}) => ["sells to", "positioning", "pricing model", "praised", "complained", "switching cost"].map((k) => `- ${k}: ${over[k] ?? "unknown"}`).join("\n");
  const root = project();
  const w = (t) => { writeFileSync(join(root, "docs/product/x/COMPETITORS.md"), t); return json("check-competitors.mjs", ["x", "--root", root, "--today", "2026-10-20"]); };
  const sourced = '"set up in an afternoon" | https://r.example/acme | 2026-10-02 | "set up in an afternoon"';
  assert.equal(w(head + prof(all({ praised: sourced, "switching cost": "one afternoon [assumption: usability]" }))).status, 0);
  assert.deepEqual(rules(w(head)), ["no-profile", "no-implications"]);
  assert.deepEqual(rules(w(head + prof(all({ complained: "export is slow" })))), ["unverifiable-profile"]);
  assert.deepEqual(rules(w(head + prof(all({ positioning: "easy [assumption: value]" })))), ["unverifiable-profile"]);
  assert.deepEqual(rules(w(head + prof(all(), "- We should be faster."))), ["implication-without-competitor"]);
  assert.deepEqual(rules(w(head + prof(all({ "pricing model": '10 USD per seat | https://a.example/p | 2026-10-01 | "per seat"' })))), ["value-not-in-quote"]);
  rmSync(root, { recursive: true, force: true });
});

test("a ranking is a reasoned order: missing, a numeric score and a made-up user count are rejected", () => {
  const base = "# O\n\n- OP-1 Export is manual. C-1, INT-1\n- OP-2 A summary may help. [assumption: value]\n\n```mermaid\ngraph TD\n  G --> OP-1\n  G --> OP-2\n```\n";
  const row = (id, op, over = "") => `- R-${id} OP-${op} evidence: strong; users: C-1; fit: removes the copying; effort: small; reason: two sources agree${over}\n`;
  const root = project();
  const w = (t) => { writeFileSync(join(root, "docs/product/x/OPPORTUNITIES.md"), t); return json("check-opportunities.mjs", ["x", "--root", root]); };
  assert.equal(w(`${base}\n## Ranking\n\n${row(1, 1)}${row(2, 2)}`).status, 0);
  assert.deepEqual(rules(w(base)), ["ranking-missing"]);
  assert.deepEqual(rules(w(`${base}\n## Ranking\n\n${row(1, 1)}`)), ["ranking-size"]);
  assert.deepEqual(rules(w(`${base}\n## Ranking\n\n${row(1, 1).replace("evidence: strong", "evidence: 9")}${row(2, 2)}`)), ["ranking-level"]);
  assert.deepEqual(rules(w(`${base}\n## Ranking\n\n${row(1, 1).replace("users: C-1", "users: about 5000")}${row(2, 2)}`)), ["ranking-users"]);
  assert.deepEqual(rules(w(`${base}\n## Ranking\n\n${row(1, 1)}${row(2, 1)}`)).sort(), ["ranking-duplicate", "ranking-size"]);
  rmSync(root, { recursive: true, force: true });
});

test("a discovery set without insights is rejected; each insight needs evidence ids and an implication", () => {
  const root = project({ "RESEARCH.md": research("- C-2 Teams export weekly. [assumption: value]") });
  const insight = (n, over = "") => `- IN-${n} Finance copies rows by hand every month. evidence: C-1, INT-1; so what: build the export before the summary.${over}\n`;
  const w = (t) => { writeFileSync(join(root, "docs/product/x/INTERVIEWS.md"), `${INTERVIEWS}\n## So what\n\n${t}`); writeFileSync(join(root, "docs/product/x/RESEARCH.md"), research("- C-2 Teams export weekly. [assumption: value]") + `\n## So what\n\n${insight(11)}${insight(12)}${insight(13)}`); return json("check-insights.mjs", ["x", "--root", root]); };
  assert.equal(w(insight(1) + insight(2) + insight(3)).status, 0);
  assert.deepEqual(rules(w("")), ["no-insights"]);
  assert.deepEqual(rules(w(insight(1) + insight(2))), ["too-few-insights"]);
  assert.deepEqual(rules(w([1, 2, 3, 4, 5, 6, 7, 8].map((n) => insight(n)).join(""))), ["too-many-insights"]);
  assert.deepEqual(rules(w(insight(1) + insight(2) + "- IN-3 Finance copies rows by hand every month. so what: build the export first.\n")), ["insight-without-evidence"]);
  assert.deepEqual(rules(w(insight(1) + insight(2) + insight(3).replace("; so what: build the export before the summary.", "; so what: noted."))), ["insight-without-implication"]);
  assert.deepEqual(rules(w(insight(1) + insight(2) + insight(3).replace("C-1,", "C-9,"))), ["dangling-evidence"]);
  rmSync(join(root, "docs/product/x/INTERVIEWS.md"));
  rmSync(join(root, "docs/product/x/RESEARCH.md"));
  assert.deepEqual(rules(json("check-insights.mjs", ["x", "--root", root])), ["no-insights"]);
  rmSync(root, { recursive: true, force: true });
});

test("the examples sit in code fences, so no checker reads them as real claims", () => {
  for (const skill of ["product-discovery", "product-assess", "product-spec"]) {
    const text = readFileSync(join(SKILL, "..", skill, "references/EXAMPLES.md"), "utf8");
    assert.equal(text.replace(/^```[\s\S]*?^```$/gm, "").split("\n").filter((l) => /^(- (C|OP|AS|RK|IN|R|SQ)-\d+|\|)/.test(l)).length, 0, skill);
  }
});
