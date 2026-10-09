import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// tests/shared/check-shared.sh against throwaway roots, plus the real repository.
const REPO = new URL("../../", import.meta.url).pathname;
const SCRIPT = join(REPO, "tests/shared/check-shared.sh");
const CANON = readFileSync(join(REPO, "tests/shared/shared-rules.md"), "utf8");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function root(skills) {
  const dir = mkdtempSync(join(tmpdir(), "check-shared-"));
  dirs.push(dir);
  mkdirSync(join(dir, "tests/shared"), { recursive: true });
  writeFileSync(join(dir, "tests/shared/shared-rules.md"), CANON);
  for (const [name, text] of Object.entries(skills)) {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), text);
  }
  return dir;
}
const skill = (block = CANON) => `---\nname: x\n---\n\n# x\n\nbefore\n\n${block}\nafter\n`;
const run = (dir, ...args) => spawnSync("sh", [SCRIPT, "--root", dir, ...args], { encoding: "utf8" });

test("identical blocks pass for every skill that exists", () => {
  const r = run(root({ alpha: skill(), beta: skill() }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PASS alpha/);
  assert.match(r.stdout, /PASS beta/);
});

test("a single changed byte fails that skill only and exits 1", () => {
  const r = run(root({ alpha: skill(), beta: skill(CANON.replace("Evidence or nothing", "Evidence or nothin")) }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PASS alpha/);
  assert.match(r.stdout, /FAIL beta \(shared-rules block differs/);
});

test("trailing whitespace and a missing final newline inside the block count as drift", () => {
  assert.equal(run(root({ a: skill(CANON.replace("\n## Shared", " \n## Shared")) })).status, 1);
  assert.equal(run(root({ a: skill(CANON.replace("\n<!-- proofline:shared-rules:end -->\n", "\n\n<!-- proofline:shared-rules:end -->\n")) })).status, 1);
});

test("a skill without the block fails; a block without its end marker fails", () => {
  const none = run(root({ a: "# a\nno block here\n" }));
  assert.equal(none.status, 1);
  assert.match(none.stdout, /FAIL a \(shared-rules block missing\)/);
  const open = run(root({ a: skill(CANON.replace("<!-- proofline:shared-rules:end -->\n", "")) }));
  assert.equal(open.status, 1);
  assert.match(open.stdout, /FAIL a/);
});

test("named skills are checked alone; a named skill that does not exist fails", () => {
  const dir = root({ alpha: skill(), beta: "# beta without block\n" });
  const only = run(dir, "alpha");
  assert.equal(only.status, 0);
  assert.doesNotMatch(only.stdout, /beta/);
  const missing = run(dir, "alpha", "ghost");
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /FAIL ghost \(SKILL\.md not found\)/);
});

test("directories without SKILL.md are ignored; no skills at all is a usage error (2)", () => {
  const dir = root({ alpha: skill() });
  mkdirSync(join(dir, "skills", "empty"));
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /empty/);
  const none = run(root({}));
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no skills to check/);
});

test("usage errors exit 2", () => {
  assert.equal(spawnSync("sh", [SCRIPT, "--nope"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("sh", [SCRIPT, "--root"], { encoding: "utf8" }).status, 2);
  assert.equal(run("/nonexistent-dir-for-check-shared").status, 2);
  const noCanon = mkdtempSync(join(tmpdir(), "check-shared-"));
  dirs.push(noCanon);
  assert.equal(run(noCanon).status, 2);
});

test("the ported skills carry the canonical block", () => {
  const r = spawnSync("sh", [SCRIPT, "test-trust", "proof-review"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS test-trust/);
  assert.match(r.stdout, /PASS proof-review/);
});
