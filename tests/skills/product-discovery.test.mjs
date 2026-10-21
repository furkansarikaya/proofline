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
  const root = project({ "COMPETITORS.md": head + row("2026-10-01") + "| Acme | Formats | | | | |\n" });
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
  writeFileSync(join(root, "docs/product/x/COMPETITORS.md"), head + "| Acme | Price | 10 USD per month | | | |\n");
  const unverifiable = json("check-competitors.mjs", ["x", "--root", root, "--today", "2026-10-20"]);
  assert.equal(unverifiable.status, 1);
  assert.deepEqual(rules(unverifiable), ["unverifiable-value"]);
  rmSync(root, { recursive: true, force: true });
});

test("a number is accepted only as a sourced fact whose quote holds it", () => {
  const ok = '- C-5 The market is worth 2.4 billion USD. [fact: web https://r.example/m accessed 2026-10-01 "worth 2.4 billion USD in 2025"]';
  const root = project({ "RESEARCH.md": `# R\n\n${ok}\n- C-2 Teams export weekly. [assumption: value]\n` });
  assert.equal(run("check-research.mjs", ["x", "--root", root]).status, 0);
  const w = (t) => { writeFileSync(join(root, "docs/product/x/RESEARCH.md"), `# R\n\n${t}\n`); return json("check-research.mjs", ["x", "--root", root]); };
  const a = w("- C-2 The market is worth 2.4 billion USD. [assumption: viability]");
  assert.equal(a.status, 1);
  assert.deepEqual(rules(a), ["unsourced-number"]);
  assert.deepEqual(rules(w("- C-2 Churn is 40% a year.")), ["unmarked", "unsourced-number"]);
  assert.deepEqual(rules(w(ok.replace("2.4 billion", "3.1 billion"))), ["number-not-in-quote"]);
  assert.deepEqual(rules(w("- Persona: Anna, an accountant [assumption: value]")), ["persona-without-source"]);
  rmSync(root, { recursive: true, force: true });
});

test("an opportunity needs existing evidence and a place in the Mermaid tree", () => {
  const good = "# O\n\n- OP-1 Export is manual. C-1, INT-1\n- OP-2 A summary may help. [assumption: value]\n- S-1 One-click export for OP-1.\n\n```mermaid\ngraph TD\n  G --> OP-1\n  G --> OP-2\n```\n";
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
