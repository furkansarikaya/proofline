import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skill = join(here, "../../skills/evidence-map");
const fixture = join(here, "../../fixtures/impact-map");
const impact = join(skill, "scripts/impact.mjs");
const { analyze, KINDS, ROLES, CHANGES, TEST_RELATIONS, FORMATS, FILE_REASONS, LIMIT_IDS } = await import(impact);
const { validate } = await import(join(skill, "scripts/validate-impact.mjs"));
const { compare } = await import(join(fixture, "compare.mjs"));
const SCHEMA = JSON.parse(readFileSync(join(skill, "schema/impact.schema.json"), "utf8"));
const EXPECTED = JSON.parse(readFileSync(join(fixture, "EXPECTED.json"), "utf8"));

let base, repo, report;
const sh = (cwd, ...args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
function mini(name, files, edit) {
  const dir = join(base, name);
  mkdirSync(dir);
  sh(dir, "init", "-q");
  sh(dir, "config", "user.name", "T"); sh(dir, "config", "user.email", "t@example.invalid"); sh(dir, "config", "commit.gpgsign", "false");
  const put = (m) => { for (const [p, c] of Object.entries(m)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); if (c === null) rmSync(join(dir, p)); else writeFileSync(join(dir, p), c); } };
  put(files);
  sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "base");
  if (edit) { put(edit); sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "change"); }
  return dir;
}

before(() => {
  base = mkdtempSync(join(tmpdir(), "impfx-"));
  repo = join(base, "repo");
  const r = spawnSync("sh", [join(fixture, "setup.sh"), repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  report = analyze(repo, { base: "HEAD~1" });
});
after(() => rmSync(base, { recursive: true, force: true }));

test("fixture: the report equals the planted facts (traps included)", () => {
  assert.deepEqual(compare(report, EXPECTED), []);
});

test("fixture: releaseStock is not changed in diff mode, both are public in file mode", () => {
  assert.ok(!report.symbols.some((s) => s.name === EXPECTED.not_symbols[0]));
  const r = analyze(repo, { files: ["src/stock/reserve.js"] });
  assert.deepEqual(r.symbols.map((s) => s.name), EXPECTED.files_mode_symbols);
});

test("fixture: nothing in the not_* lists appears anywhere", () => {
  const all = JSON.stringify([report.files_affected, report.tests, report.contracts]);
  for (const p of [...EXPECTED.not_files, ...EXPECTED.not_tests, ...EXPECTED.not_contracts]) assert.ok(!all.includes(`"${p}"`), p);
});

test("report is valid, deterministic and read-only", () => {
  assert.deepEqual(validate(report, { root: repo }), []);
  assert.equal(JSON.stringify(analyze(repo, { base: "HEAD~1" })), JSON.stringify(report));
  assert.equal(sh(repo, "status", "--porcelain"), "");
});

test("limits and the cross-repo unknown are always stated", () => {
  assert.deepEqual(report.limits.map((l) => l.id), LIMIT_IDS);
  for (const id of ["dynamic-dispatch", "reflection", "string-built-names", "generated-code", "cross-repo-consumers"]) assert.ok(LIMIT_IDS.includes(id));
  const cross = report.unknown.find((u) => u.id === "cross-repo-consumers");
  assert.equal(cross.status, "unknown");
  assert.deepEqual(report.analysis.tools.used, []);
});

test("validator rejects a weakened or tampered report", () => {
  const clone = () => JSON.parse(JSON.stringify(report));
  const has = (r, s, opts) => { const e = validate(r, opts); assert.ok(e.some((x) => x.includes(s)), `expected "${s}" in ${JSON.stringify(e)}`); };
  let r = clone(); r.limits = r.limits.filter((l) => l.id !== "reflection"); has(r, '"reflection" is not stated');
  r = clone(); r.unknown = r.unknown.filter((u) => u.id !== "cross-repo-consumers"); has(r, "cross-repo-consumers");
  r = clone(); r.version = 2; has(r, "version must be 1");
  r = clone(); r.symbols[0].references.find((x) => x.role === "comment").kind = "exact"; has(r, "a comment occurrence must be textual");
  r = clone(); r.symbols[0].references[0].kind = "certain"; has(r, "kind must be exact|textual|heuristic");
  r = clone(); r.symbols[0].references[0].path = "../x.js"; has(r, "bad reference");
  r = clone(); r.summary.references.exact += 1; has(r, "summary.references.exact");
  r = clone(); r.tests = []; has(r, "is not in tests");
  r = clone(); r.symbols[0].references.find((x) => x.path === "src/orders/place.js").text = "forged"; has(r, "text does not match the file", { root: repo });
  r = clone(); r.symbols[0].references.find((x) => x.path === "src/orders/place.js").line = 99; has(r, "out of bounds", { root: repo });
});

test("CLI: exit codes, --out, --select", () => {
  const run = (...a) => spawnSync(process.execPath, [impact, "--repo", repo, ...a], { encoding: "utf8" });
  assert.equal(spawnSync(process.execPath, [impact], { encoding: "utf8" }).status, 2);
  assert.equal(run("--base", "no-such-ref").status, 2);
  assert.equal(run("--symbol", "not valid").status, 2);
  const sel = run("--base", "HEAD~1", "--select", "tests");
  assert.equal(sel.status, 0);
  assert.deepEqual(sel.stdout.trim().split("\n"), ["test/orders.test.js", "test/reserve.test.js", "test/stock-barrel.test.js"]);
  const out = join(base, "r.json");
  assert.equal(run("--base", "HEAD~1", "--out", out).status, 0);
  const v = spawnSync(process.execPath, [join(skill, "scripts/validate-impact.mjs"), out, "--repo", repo], { encoding: "utf8" });
  assert.equal(v.status, 0, v.stdout);
  writeFileSync(out, "{}");
  assert.equal(spawnSync(process.execPath, [join(skill, "scripts/validate-impact.mjs"), out], { encoding: "utf8" }).status, 1);
});

test("removed symbol: its former callers are the impact", () => {
  const dir = mini("removed", {
    "lib/a.js": "export function gone() { return 1; }\nexport function stays() { return 2; }\n",
    "app/use.js": "import { gone } from \"../lib/a.js\";\nexport const x = gone();\n",
  }, { "lib/a.js": "export function stays() { return 2; }\n" });
  const r = analyze(dir, { base: "HEAD~1" });
  const s = r.symbols.find((x) => x.name === "gone");
  assert.equal(s.change, "removed");
  assert.deepEqual(s.references.filter((x) => x.kind === "exact").map((x) => `${x.path}:${x.line}`), ["app/use.js:1", "app/use.js:2"]);
  assert.ok(!r.symbols.some((x) => x.name === "stays"));
});

test("python: aliased from-import, homonym module, relative import", () => {
  const dir = mini("py", {
    "pkg/__init__.py": "from .core import compute\n",
    "pkg/core.py": "def compute(x):\n    return x + 1\n",
    "pkg/other.py": "def compute(x):\n    return x - 1\n",
    "app/a.py": "from pkg.core import compute as calc\n\nprint(calc(1))\n",
    "app/b.py": "from pkg import compute\n\nprint(compute(2))\n",
    "app/c.py": "from pkg.other import compute\n\nprint(compute(3))  # compute\n",
    "tests/test_core.py": "from pkg.core import compute\n\ndef test_compute():\n    assert compute(1) == 2\n",
  });
  const s = analyze(dir, { symbols: ["compute@pkg/core.py"] }).symbols[0];
  const exact = s.references.filter((r) => r.kind === "exact").map((r) => `${r.path}:${r.line}`).sort();
  assert.deepEqual(exact, ["app/a.py:1", "app/a.py:3", "app/b.py:1", "app/b.py:3", "pkg/__init__.py:1", "pkg/core.py:1", "tests/test_core.py:1", "tests/test_core.py:4"]);
  assert.deepEqual(s.excluded_homonyms.map((h) => h.path).sort(), ["app/c.py", "app/c.py", "pkg/other.py"]);
  assert.ok(s.tests.some((t) => t.path === "tests/test_core.py" && t.kind === "exact"));
});

test("go: qualified use and same-package use are exact, a same-named func elsewhere is not", () => {
  const dir = mini("go", {
    "go.mod": "module example.invalid/m\n",
    "billing/tax.go": "package billing\n\nfunc Compute(x int) int { return x }\n\nfunc helper() int { return Compute(1) }\n",
    "cmd/main.go": "package main\n\nimport \"example.invalid/m/billing\"\n\nfunc main() { _ = billing.Compute(2) }\n",
    "other/tax.go": "package other\n\nfunc Compute(x int) int { return x * 2 }\n\nfunc use() int { return Compute(3) }\n",
  });
  const s = analyze(dir, { symbols: ["Compute@billing/tax.go"] }).symbols[0];
  assert.deepEqual(s.references.filter((r) => r.kind === "exact").map((r) => `${r.path}:${r.line}`).sort(), ["billing/tax.go:3", "billing/tax.go:5", "cmd/main.go:5"]);
  assert.deepEqual(s.excluded_homonyms.map((h) => h.path).sort(), ["other/tax.go", "other/tax.go"]);
});

test("unresolved import and unknown language are heuristic, never exact", () => {
  const dir = mini("heur", {
    "src/a.ts": "export function parse() {}\n",
    "src/b.ts": "import { parse } from \"@app/a\";\nparse();\n",
    "svc/Main.java": "class Main { void run() { parse(); } }\n",
  });
  const s = analyze(dir, { symbols: ["parse@src/a.ts"] }).symbols[0];
  const by = Object.fromEntries(s.references.map((r) => [`${r.path}:${r.line}`, r.kind]));
  assert.equal(by["src/a.ts:1"], "exact");
  assert.equal(by["src/b.ts:1"], "heuristic");
  assert.equal(by["src/b.ts:2"], "heuristic");
  assert.equal(by["svc/Main.java:1"], "heuristic");
});

test("enums and limits agree with the schema", () => {
  const sym = SCHEMA.properties.symbols.items.properties;
  assert.deepEqual(sym.references.items.properties.kind.enum, KINDS);
  assert.deepEqual(sym.references.items.properties.role.enum, ROLES);
  assert.deepEqual(sym.change.enum, CHANGES);
  assert.deepEqual(sym.tests.items.properties.relation.enum, TEST_RELATIONS);
  assert.deepEqual(sym.files.items.properties.reasons.items.enum, FILE_REASONS);
  assert.deepEqual(SCHEMA.properties.contracts.items.properties.format.enum, FORMATS);
  assert.equal(SCHEMA.properties.version.const, report.version);
});

test("SKILL.md points at the impact mode and stays within the limits", () => {
  const md = readFileSync(join(skill, "SKILL.md"), "utf8");
  assert.match(md, /scripts\/impact\.mjs/);
  assert.match(md, /references\/IMPACT\.md/);
  assert.ok(/^description: (.+)$/m.exec(md)[1].length <= 900);
  assert.ok(readFileSync(join(skill, "references/IMPACT.md"), "utf8").includes("Consumption interface"));
});
