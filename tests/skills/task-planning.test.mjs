import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8" });

test("task-planning fixture: tasks validate, ADR linked, team.yaml git-ignored", () => {
  const d = join(mkdtempSync(join(tmpdir(), "tp-")), "repo");
  assert.equal(sh("sh", [join(root, "fixtures/task-planning/setup.sh"), d]).status, 0);
  const r = sh("sh", [join(root, "fixtures/task-planning/selfcheck.sh"), d]);
  assert.equal(r.status, 0, r.stderr);
});

test("task-author SKILL.md: tasks.dir, adr_dir, team.yaml asked once, local .gitignore rule", () => {
  const s = read("skills/task-author/SKILL.md");
  assert.match(s, /write each task to `tasks\.dir`/);
  assert.match(s, /each ADR to `design_docs\.adr_dir`/);
  assert.match(s, /no team info is recorded, ask ONE question/);
  assert.match(s, /\.agents\/local\/team\.yaml/);
  assert.match(s, /Do not ask again in later grills/);
  assert.match(s, /create `\.agents\/local\/\.gitignore` containing `\*`/);
});

test("DESIGN.md default is docs/design/DESIGN.md (config, knowledge scope, CLI fallback)", () => {
  const c = read("control-plane/agents/config.yaml");
  assert.match(c, /^  design: docs\/design\/DESIGN\.md$/m);
  const scope = /^knowledge_scope_root: (.*)$/m.exec(c)[1].split(/\s+/);
  assert.ok(!scope.includes("DESIGN.md"), scope.join(" "));
  assert.match(read("bin/proofline"), /design_docs\.design docs\/design\/DESIGN\.md/);
});

test("upgrade --dry-run offers the DESIGN.md move and moves nothing", () => {
  const d = mkdtempSync(join(tmpdir(), "up-"));
  sh("git", ["init", "-q"], d);
  writeFileSync(join(d, "DESIGN.md"), "# d\n");
  const pl = join(root, "bin/proofline");
  assert.equal(sh("sh", [pl, "init", "--yes", "--runtimes", "claude"], d).status, 0);
  // A pre-0.0.3 install: the old template wrote design_docs.design: DESIGN.md.
  const cfgPath = join(d, ".agents/config.yaml");
  const old = readFileSync(cfgPath, "utf8").replace(/^  design: .*$/m, "  design: DESIGN.md");
  writeFileSync(cfgPath, old);
  const r = sh("sh", [pl, "upgrade", "--dry-run"], d);
  assert.match(r.stdout, /offer: DESIGN\.md sits at the project root/);
  assert.match(r.stdout, /git mv DESIGN\.md docs\/design\/DESIGN\.md/);
  assert.match(r.stdout, /set design_docs\.design: docs\/design\/DESIGN\.md/);
  assert.equal(readFileSync(join(d, "DESIGN.md"), "utf8"), "# d\n");
  assert.equal(readFileSync(cfgPath, "utf8"), old);
});
