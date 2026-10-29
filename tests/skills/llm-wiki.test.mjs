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

test("log archiving moves the oldest entries to log-archive.md and loses no content", async () => {
  const { archiveLog } = await import(script);
  const root = build(), wiki = join(root, "docs/wiki");
  const entries = Array.from({ length: 25 }, (_, i) => `- 2026-01-${String(i + 1).padStart(2, "0")} - op ${i} ... Source: [[retry-policy]].`);
  const before = "# Log\n\nintro line\n\n" + entries.join("\n") + "\n";
  writeFileSync(join(wiki, "log.md"), before);
  assert.equal(archiveLog(wiki, 10), 15);
  const logNow = readFileSync(join(wiki, "log.md"), "utf8"), arch = readFileSync(join(wiki, "log-archive.md"), "utf8");
  assert.deepEqual(logNow.split("\n").filter((l) => l.startsWith("- ")), entries.slice(15));
  assert.deepEqual(arch.split("\n").filter((l) => l.startsWith("- ")), entries.slice(0, 15));
  assert.ok(logNow.startsWith("# Log\n\nintro line"));
  // every original line is in log.md or the archive; nothing deleted, nothing duplicated
  assert.deepEqual([...logNow.split("\n"), ...arch.split("\n")].filter((l) => l.startsWith("- ")).sort(), [...entries].sort());
  assert.equal(archiveLog(wiki, 10), 0);
  // a second round appends in order to the same archive
  writeFileSync(join(wiki, "log.md"), logNow + "- 2026-02-01 - later ... Source: [[retry-policy]].\n");
  assert.equal(archiveLog(wiki, 10), 1);
  assert.deepEqual(readFileSync(join(wiki, "log-archive.md"), "utf8").split("\n").filter((l) => l.startsWith("- ")), [...entries.slice(0, 15), entries[15]]);
  assert.deepEqual(run(root).errors, []);
  const r = spawnSync("node", [script, wiki, "--archive-log", "--keep", "5", "--root", root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /archived 5 log entries/);
});
test("a log over the limit and near-duplicate pages are proposals (warnings), not errors", () => {
  const root = build(), wiki = join(root, "docs/wiki");
  writeFileSync(join(wiki, "log.md"), "# Log\n\n" + Array.from({ length: 201 }, (_, i) => `- op ${i}`).join("\n") + "\n");
  let r = run(root);
  has(r.warnings, "log.md has 201 entries");
  assert.deepEqual(r.errors, []);
  const src = readFileSync(join(wiki, "concepts/retry-policy.md"), "utf8");
  writeFileSync(join(wiki, "concepts/retry-policy-copy.md"), src.replace(/^title: .*$/m, "title: Retry policy copy"));
  r = run(root);
  has(r.warnings, "merge proposal: docs/wiki/concepts/retry-policy-copy.md and docs/wiki/concepts/retry-policy.md");
  assert.deepEqual(r.errors, []);
  assert.equal(spawnSync("node", [script, wiki, "--root", root]).status, 0);
});
test("--similar lists the closest existing pages for a new title", () => {
  const root = build(), wiki = join(root, "docs/wiki");
  const r = spawnSync("node", [script, wiki, "--similar", "Retry policy", "--root", root], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /concepts\/retry-policy\.md/);
  assert.match(spawnSync("node", [script, wiki, "--similar", "Zebra quokka", "--root", root], { encoding: "utf8" }).stdout, /no similar page/);
});
