import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const skill = join(dirname(fileURLToPath(import.meta.url)), "../../skills/system-design");
const script = join(skill, "scripts/validate-architecture.mjs");
const { validate } = await import(script);

const repo = mkdtempSync(join(tmpdir(), "sd-"));
mkdirSync(join(repo, "src/api"), { recursive: true });
mkdirSync(join(repo, "docs/adr"), { recursive: true });
writeFileSync(join(repo, "src/api/handler.js"), "");
writeFileSync(join(repo, "docs/adr/0001-queue.md"), "# 0001. Use a queue\n\nStatus: proposed\n\n## Context\nx\n\n## Decision\ny\n\n## Consequences\nz\n");
writeFileSync(join(repo, "docs/adr/0002-bad.md"), "# 0002. Bad\n\n## Context\nx\n");

const good = () => ({
  schema_version: 1, mode: "task", levels: ["component"],
  components: [
    { id: "C1", name: "handler", level: "component", path: "src/api/handler.js", change: "modify", responsibility: "Handles requests" },
    { id: "C2", name: "limiter", level: "component", path: "src/api/limiter.js", change: "new", responsibility: "Rate limit", reuse_rejected: "handler has no per-key state" },
  ],
  boundaries: [{ from: "C1", to: "C2", contract: "src/api/limiter.js:check", direction: "from->to" }],
  compatibility: ["none: internal module"], migration: ["none: atomic change"],
  tradeoffs: [{ choice: "in-memory counter", alternatives: ["redis counter"], evidence: "single process (src/api/handler.js)" }],
  adrs: [{ id: "0001", title: "Use a queue", status: "proposed", path: "docs/adr/0001-queue.md", alternatives: ["queue", "cron poll"] }],
});
const errs = (d, o = { root: repo }) => validate(d, o);
const has = (e, s) => assert.ok(e.some((x) => x.includes(s)), `expected "${s}" in ${JSON.stringify(e)}`);

test("accepts a good architecture", () => assert.deepEqual(errs(good()), []));

test("rejects a component path that does not exist", () => {
  const d = good(); d.components[0].path = "src/api/missing.js"; has(errs(d), "does not exist");
});
test("rejects a new component whose parent does not exist", () => {
  const d = good(); d.components[1].path = "nope/dir/x.js"; has(errs(d), "parent directory");
});
test("rejects a new component that already exists", () => {
  const d = good(); d.components[1].path = "src/api/handler.js"; has(errs(d), "already exists");
});
test("rejects path traversal and absolute paths", () => {
  const d = good(); d.components[0].path = "../x"; has(errs(d), "repo-relative");
  const e = good(); e.components[0].path = "/etc/passwd"; has(errs(e), "repo-relative");
});
test("new component requires reuse_rejected", () => {
  const d = good(); delete d.components[1].reuse_rejected; has(errs(d), "reuse_rejected");
});
test("boundary must reference known components", () => {
  const d = good(); d.boundaries[0].to = "C9"; has(errs(d), "unknown component id");
});
test("duplicate component ids rejected", () => {
  const d = good(); d.components[1].id = "C1"; has(errs(d), "duplicate id");
});
test("compatibility and migration are mandatory", () => {
  const d = good(); d.compatibility = []; d.migration = []; const e = errs(d);
  has(e, "$.compatibility"); has(e, "$.migration");
});
test("trade-off needs an alternative", () => {
  const d = good(); d.tradeoffs[0].alternatives = []; has(errs(d), "not a trade-off");
});
test("ADR needs two alternatives", () => {
  const d = good(); d.adrs[0].alternatives = ["only one"]; has(errs(d), "at least 2");
});
test("ADR file must have the four sections", () => {
  const d = good(); d.adrs[0] = { ...d.adrs[0], id: "0002", path: "docs/adr/0002-bad.md" };
  const e = errs(d); has(e, "lacks Status"); has(e, "lacks Decision"); has(e, "lacks Consequences");
});
test("ADR ids unique and 4 digits", () => {
  const d = good(); d.adrs.push({ ...d.adrs[0] }); has(errs(d), "duplicate ADR");
  const e = good(); e.adrs[0].id = "1"; has(errs(e), "4 digits");
});
test("component level must be listed in levels", () => {
  const d = good(); d.levels = ["container"]; has(errs(d), "not listed");
});
test("task mode needs a changed component", () => {
  const d = good(); d.components = [{ ...d.components[0], change: "unchanged" }]; d.boundaries = []; has(errs(d), "at least one new or modify");
});
test("reverse mode: only unchanged, no ADRs", () => {
  const d = good(); d.mode = "reverse"; const e = errs(d); has(e, "must be unchanged"); has(e, "no ADRs");
});
test("unknown keys rejected", () => {
  const d = good(); d.extra = 1; has(errs(d), "unexpected");
});
test("without --root paths are not checked on disk", () => {
  const d = good(); d.components[0].path = "anything.js"; d.adrs = []; assert.deepEqual(errs(d, {}), []);
});
test("CLI exit codes: 0 valid, 1 invalid, 2 usage", () => {
  const f = join(repo, "a.json");
  writeFileSync(f, JSON.stringify(good()));
  assert.equal(spawnSync("node", [script, f, "--root", repo]).status, 0);
  const bad = good(); bad.components[0].path = "zzz"; writeFileSync(f, JSON.stringify(bad));
  assert.equal(spawnSync("node", [script, f, "--root", repo]).status, 1);
  assert.equal(spawnSync("node", [script]).status, 2);
});
test("SKILL.md frontmatter and bundled files", () => {
  const t = readFileSync(join(skill, "SKILL.md"), "utf8");
  assert.match(t, /^---\nname: system-design\n/);
  assert.match(t, /disable-model-invocation: true/);
  assert.ok(t.split("\n").length < 500);
  JSON.parse(readFileSync(join(skill, "schema/architecture.schema.json"), "utf8"));
});
