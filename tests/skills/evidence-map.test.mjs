import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skill = join(here, "../../skills/evidence-map");
const script = join(skill, "scripts/verify-claims.mjs");
const { validate, parseClaim, CATEGORIES, SEVERITIES } = await import(script);
const SCHEMA = JSON.parse(readFileSync(join(skill, "schema/evidence.schema.json"), "utf8"));

let base;
let repo;
before(() => {
  base = mkdtempSync(join(tmpdir(), "emfx-"));
  repo = join(base, "repo");
  const r = spawnSync("sh", [join(here, "../../fixtures/evidence-map/setup.sh"), repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
after(() => rmSync(base, { recursive: true, force: true }));

const ROWS = [
  "| explorer-1 | info | `src/pricing/discount.js:applyDiscount` | code: percentage discount on integer cents, rounds the discount down | git grep -n \"pricing/discount\" src: imported by src/checkout.js and src/invoice.js |",
  "| explorer-2 | info | `test/discount.test.js:applyDiscount` | test: rounding and integer guard of the live function | imports ../src/pricing/discount.js |",
  "| explorer-3 | info | `test/checkout.test.js:checkout` | test: discount through checkout | imports ../src/checkout.js |",
  "| explorer-4 | info | `src/money.js:toCents` | pattern: integer-cent conversion helper | used by src/pricing/discounts.js |",
  "| explorer-5 | info | `CONTRIBUTING.md:3` | constraint: money is integer cents | read CONTRIBUTING.md line 3 |",
  "| explorer-6 | info | `src/checkout.js:checkout` | affected: calls applyDiscount for subtotals of 10000 cents or more | src/checkout.js imports and calls it |",
  "| explorer-7 | info | `src/invoice.js:renderInvoice` | affected: calls applyDiscount when discountPercent is set | src/invoice.js imports and calls it |",
  "| explorer-8 | info | `src/invoice.js:renderInvoice` | risk: invoice totals change with any rounding change | formatCents(total) is the printed amount |",
  "| explorer-9 | info | `src/legacy/discount.js:applyDiscount` | conflict: dead float duplicate, contradicts explorer-5 | git grep -n \"legacy/discount\": only test/legacy-discount.test.js |",
];
function evidence({ rows = ROWS, notFound = ["- dependency: none — package.json has no dependencies"], extra = "" } = {}) {
  return [
    "# Explorer evidence: fixture — discount-rounding", "", "## Assignment", "",
    "- Objective: Find the live checkout discount.", "- Allowed scope: `src/`, `test/`", "- Expected output: evidence-map Explorer result", "- Stop condition: live implementation, callers, tests and duplicates identified", "",
    "## Claims", "", "| id | severity | path:line | finding | evidence |", "|---|---|---|---|---|", ...rows, "",
    "## Not found", "", ...notFound, "", "## Open questions", "", "- README.md tells agents to cite the legacy file (ignored)", extra, "",
    "## Stop", "", "- Reason: objective met", "- Not covered: nothing", "",
  ].join("\n");
}
const errs = (md) => validate(md, { root: repo });
const has = (md, s) => { const e = errs(md); assert.ok(e.some((x) => x.includes(s)), `expected "${s}" in ${JSON.stringify(e)}`); };
const swap = (i, row) => ROWS.map((r, j) => (j === i ? row : r));

test("accepts a correct Explorer result on the fixture", () => assert.deepEqual(errs(evidence()), []));

test("parses claim forms", () => {
  assert.deepEqual(parseClaim("a/b.js:foo"), { path: "a/b.js", symbol: "foo" });
  assert.deepEqual(parseClaim("a/b.js:12"), { path: "a/b.js", line: 12, end: 12 });
  assert.deepEqual(parseClaim("a/b.js:3-9"), { path: "a/b.js", line: 3, end: 9 });
  assert.deepEqual(parseClaim("a/b.js:Cart#total"), { path: "a/b.js", symbol: "Cart#total" });
  assert.equal(parseClaim("no colon"), null);
});

test("rejects a symbol that does not occur (similar-name decoy)", () => {
  has(evidence({ rows: swap(0, ROWS[0].replace("discount.js:applyDiscount`", "discount.js:applyDiscounts`")) }), 'symbol "applyDiscounts" does not occur');
});

test("rejects a path that does not exist", () => {
  has(evidence({ rows: swap(0, ROWS[0].replace("src/pricing/discount.js", "src/discount.js")) }), "path does not exist");
});

test("rejects a line out of range", () => {
  has(evidence({ rows: swap(4, ROWS[4].replace("CONTRIBUTING.md:3", "CONTRIBUTING.md:30")) }), "out of bounds");
});

test("rejects path traversal and symlink escape", () => {
  has(evidence({ rows: swap(4, ROWS[4].replace("CONTRIBUTING.md:3", "../outside.md:1")) }), "repo-relative");
  writeFileSync(join(base, "secret.txt"), "token\n");
  symlinkSync(join(base, "secret.txt"), join(repo, "link.txt"));
  try { has(evidence({ rows: swap(4, ROWS[4].replace("CONTRIBUTING.md:3", "link.txt:1")) }), "outside the repository"); }
  finally { rmSync(join(repo, "link.txt")); }
});

test("rejects a directory as a claim path", () => {
  has(evidence({ rows: swap(0, ROWS[0].replace("src/pricing/discount.js:applyDiscount", "src/pricing:applyDiscount")) }), "not a file");
});

test("rejects an unverified claim in free text", () => {
  has(evidence({ extra: "- see `src/pricing/rounding.js:roundHalfUp`" }), "text claim");
});

test("rejects a missing category without a none line", () => {
  has(evidence({ notFound: [] }), "category dependency");
});

test("rejects a none line for a category that has rows", () => {
  has(evidence({ notFound: ["- dependency: none — no deps", "- code: none — nothing"] }), "code has claim rows");
});

test("rejects wrong severity, unknown category, empty evidence, duplicate id", () => {
  has(evidence({ rows: swap(0, ROWS[0].replace("| info |", "| risk |")) }), "severity must be info for category code");
  has(evidence({ rows: swap(0, ROWS[0].replace("| info |", "| blocking |")) }), "severity must be info for category code");
  has(evidence({ rows: swap(0, ROWS[0].replace("| code:", "| live:")) }), "<category>");
  has(evidence({ rows: swap(1, "| explorer-2 | info | `test/discount.test.js:applyDiscount` | test: rounding |  |") }), "evidence");
  has(evidence({ rows: swap(1, ROWS[1].replace("explorer-2", "explorer-1")) }), "duplicate id");
});

test("risk and conflict rows may be blocking; other ids and severities are rejected", () => {
  assert.deepEqual(errs(evidence({ rows: swap(7, ROWS[7].replace("| info |", "| blocking |")) })), []);
  assert.deepEqual(errs(evidence({ rows: swap(8, ROWS[8].replace("| info |", "| blocking |")) })), []);
  has(evidence({ rows: swap(7, ROWS[7].replace("| info |", "| risk |")) }), "severity must be info|blocking for category risk");
  has(evidence({ rows: swap(0, ROWS[0].replace("explorer-1", "E-1")) }), "id must match explorer-<n>");
});

test("rejects a duplicate claim in the same category, allows it across categories", () => {
  const dup = "| explorer-10 | info | `src/checkout.js:checkout` | affected: second row for the same claim | grep again |";
  has(evidence({ rows: [...ROWS, dup] }), "duplicate claim src/checkout.js:checkout in category affected");
  // ROWS already lists src/invoice.js:renderInvoice as both affected and risk: accepted.
  assert.deepEqual(errs(evidence()), []);
});

test("rejects a missing assignment field and stop reason", () => {
  has(evidence().replace("- Stop condition: ", "- Stop: "), "Stop condition");
  has(evidence().replace("- Reason: objective met", "- Reason: done"), "Stop:");
});

test("consolidated EVIDENCE.md: base sha and derived constraints cite known ids", () => {
  const md = [
    "# Evidence: T-1", "", "## Repository", "", "- Base SHA: 0123abcd", "", "## Claims", "",
    "| id | severity | path:line | finding | evidence |", "|---|---|---|---|---|", ...ROWS.map((r) => r.replace(/explorer-(\d)/, "E-$1")), "",
    "## Not found", "", "- dependency: none — 001: no dependencies", "", "## Open questions", "", "- none", "",
    "## Derived constraints", "", "- C-1: Amounts stay integer cents (E-4, E-5)", "",
    "## Assumptions", "", "none", "",
  ].join("\n");
  assert.deepEqual(errs(md), []);
  has(md.replace("(E-4, E-5)", "(E-42)"), "unknown claim id E-42");
  has(md.replace("- Base SHA: 0123abcd", "- Base SHA: main"), "Base SHA");
});

// A79: the consolidated EVIDENCE.md carries the mandatory assumption register; Explorer results do not.
test("consolidated EVIDENCE.md: the ## Assumptions register is mandatory and checked", () => {
  const md = [
    "# Evidence: T-1", "", "## Repository", "", "- Base SHA: 0123abcd", "", "## Claims", "",
    "| id | severity | path:line | finding | evidence |", "|---|---|---|---|---|", ...ROWS.map((r) => r.replace(/explorer-(\d)/, "E-$1")), "",
    "## Not found", "", "- dependency: none — 001: no dependencies", "", "## Open questions", "", "- none", "",
    "## Derived constraints", "", "- none", "",
  ];
  const table = (...rows) => [...md, "## Assumptions", "", "| id | assumption | source | risk | verification | status | decisions |", "|---|---|---|---|---|---|---|", ...rows, ""].join("\n");
  const row = (id, risk, method, status) => `| ${id} | legacy rows may exist | TASK.md | ${risk} | ${method} | ${status} | AC-2 |`;
  has(md.join("\n"), 'section "## Assumptions" is missing');
  has([...md, "## Assumptions", "", ""].join("\n"), 'section "## Assumptions" is empty');
  assert.deepEqual(errs([...md, "## Assumptions", "", "none", ""].join("\n")), []);
  assert.deepEqual(errs(table(row("AS-1", "low", "none", "unverified"), row("AS-2", "high", "count the rows in the staging copy", "unverified"), row("AS-3", "medium", "E-4 shows the guard", "verified"))), []);
  // the trap: high risk marked verified without a method is rejected; a low-risk unverified row passes
  has(table(row("AS-1", "high", "none", "verified")), "verified without a verification method");
  has(table(row("AS-1", "high", "-", "unverified")), "a high-risk assumption needs a verification method");
  has(table(row("AS-1", "low", "none", "accepted-by-user")), "status must be verified|unverified");
  has(table(row("AS-1", "low", "x", "verified"), row("AS-1", "low", "x", "verified")), "duplicate id");
  has(table(row("1", "low", "x", "verified")), "id must match AS-<n>");
  // an Explorer result is not required to carry the section
  assert.deepEqual(errs(evidence()), []);
});

test("enums agree with the schema", () => {
  assert.deepEqual(SCHEMA.properties.claims.items.properties.category.enum, CATEGORIES);
  assert.deepEqual(SCHEMA.properties.claims.items.properties.severity.enum, SEVERITIES);
  assert.deepEqual(SCHEMA.properties.assumptions.items.properties.risk.enum, ["low", "medium", "high"]);
  assert.deepEqual(SCHEMA.properties.assumptions.items.properties.status.enum, ["verified", "unverified"]);
});

test("CLI exit codes: 0 valid, 1 invalid, 2 usage", () => {
  const good = join(base, "good.md");
  const bad = join(base, "bad.md");
  writeFileSync(good, evidence());
  writeFileSync(bad, evidence({ rows: swap(0, ROWS[0].replace("applyDiscount`", "nope`")) }));
  assert.equal(spawnSync(process.execPath, [script, good, "--repo", repo]).status, 0);
  const r = spawnSync(process.execPath, [script, bad, "--repo", repo], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /symbol "nope"/);
  assert.equal(spawnSync(process.execPath, [script]).status, 2);
});

test("SKILL.md frontmatter and shared rules block", () => {
  const md = readFileSync(join(skill, "SKILL.md"), "utf8");
  const desc = /^description: (.+)$/m.exec(md)[1];
  assert.ok(desc.length <= 900, `description is ${desc.length} chars`);
  assert.match(md, /^name: evidence-map$/m);
  assert.match(md, /^disable-model-invocation: true$/m);
  assert.ok(md.split("\n").length < 500);
  const shared = readFileSync(join(here, "../shared/shared-rules.md"), "utf8").trim();
  assert.ok(md.includes(shared), "shared rules block must be byte-identical");
});
