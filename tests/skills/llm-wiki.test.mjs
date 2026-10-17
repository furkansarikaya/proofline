import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(repo, "skills/llm-wiki/scripts/validate-wiki.mjs");
const { lint } = await import(script);

const build = () => {
  const dir = join(mkdtempSync(join(tmpdir(), "wiki-")), "x");
  const r = spawnSync("sh", [join(repo, "fixtures/llm-wiki/setup.sh"), dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return dir;
};
const run = (root) => lint(join(root, "docs/wiki"), root);
const edit = (root, f, fn) => { const p = join(root, "docs/wiki", f); writeFileSync(p, fn(readFileSync(p, "utf8"))); };
const has = (list, s) => assert.ok(list.some((x) => x.includes(s)), `expected "${s}" in ${JSON.stringify(list)}`);

test("the fixture wiki lints clean", () => assert.deepEqual(run(build()), { errors: [], warnings: [] }));
test("CLI writes lint-report.md; exit 0 clean, 1 on an error, 2 on usage", () => {
  const root = build(), wiki = join(root, "docs/wiki");
  assert.equal(spawnSync("node", [script, wiki, "--root", root]).status, 0);
  assert.match(readFileSync(join(wiki, "lint-report.md"), "utf8"), /PASS[\s\S]*Errors: 0/);
  edit(root, "concepts/retry-policy.md", (t) => t + "\n[[nope]]\n");
  const r = spawnSync("node", [script, wiki, "--root", root], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(readFileSync(join(wiki, "lint-report.md"), "utf8"), /ERROR broken wikilink: \[\[nope\]\]/);
  assert.equal(spawnSync("node", [script]).status, 2);
  assert.equal(spawnSync("node", [script, join(root, "missing")]).status, 2);
});
test("the report is never read as input (a stale error does not repeat)", () => {
  const root = build();
  edit(root, "concepts/retry-policy.md", (t) => t + "\n[[nope]]\n");
  spawnSync("node", [script, join(root, "docs/wiki"), "--root", root]);
  edit(root, "concepts/retry-policy.md", (t) => t.replace("\n[[nope]]\n", ""));
  assert.deepEqual(run(root), { errors: [], warnings: [] });
});
test("source metadata: missing, dangling", () => {
  const root = build();
  edit(root, "concepts/retry-policy.md", (t) => t.replace(/^source: .*\n/m, ""));
  edit(root, "entities/job-queue.md", (t) => t.replace(/^source: .*$/m, "source: docs/design/GONE.md"));
  const { errors } = run(root);
  has(errors, "missing source metadata: docs/wiki/concepts/retry-policy.md");
  has(errors, "nonexistent provenance source: docs/wiki/entities/job-queue.md -> docs/design/GONE.md");
});
test("source must be a file inside the repository (not '.', a folder, or a path that escapes)", () => {
  for (const bad of [".", "docs/design/", "docs/design", "../x", "docs/../../x"]) {
    const root = build();
    edit(root, "entities/job-queue.md", (t) => t.replace(/^source: .*$/m, `source: ${bad}`));
    has(run(root).errors, "nonexistent provenance source: docs/wiki/entities/job-queue.md");
  }
});
test("special page names are exempt only at the wiki root", () => {
  const root = build();
  for (const f of ["lessons/README.md", "lessons/index.md"]) writeFileSync(join(root, "docs/wiki", f), "# loose\n");
  const { errors } = run(root);
  has(errors, "missing source metadata: docs/wiki/lessons/README.md");
  has(errors, "missing source metadata: docs/wiki/lessons/index.md");
  assert.deepEqual(run(build()).errors, []);
});
test("status: invalid value; contradicted needs contradicts", () => {
  const root = build();
  edit(root, "concepts/retry-policy.md", (t) => t.replace("status: current", "status: done"));
  edit(root, "decisions/use-backoff.md", (t) => t.replace("status: accepted", "status: contradicted"));
  const { errors } = run(root);
  has(errors, "invalid status done");
  has(errors, "contradicted page lacks contradicts metadata");
  edit(root, "decisions/use-backoff.md", (t) => t.replace("status: contradicted", "status: contradicted\ncontradicts: retry-policy"));
  assert.ok(!run(root).errors.some((e) => e.includes("lacks contradicts")));
});
test("duplicate titles and broken wikilinks are errors", () => {
  const root = build();
  edit(root, "lessons/validate-before-enqueue.md", (t) => t.replace(/^title: .*$/m, "title: job-queue"));
  edit(root, "index.md", (t) => t + "\n[[ghost]] [[job-queue|alias]]\n");
  const { errors } = run(root);
  has(errors, "duplicate title: job-queue");
  has(errors, "broken wikilink: [[ghost]]");
});
test("an unlinked page is a warning, not an error; raw/ and non-pages are exempt", () => {
  const root = build();
  writeFileSync(join(root, "docs/wiki/lessons/loose.md"), "---\ntitle: loose\nstatus: current\nsource: docs/design/ARCHITECTURE.md\n---\n\n# loose\n");
  const r = run(root);
  assert.deepEqual(r.errors, []);
  has(r.warnings, "possible orphan page: docs/wiki/lessons/loose.md");
  assert.equal(r.warnings.length, 1);
  assert.ok(existsSync(join(root, "docs/wiki/raw/sessions/2026-01-05-job-1.md")));
});
