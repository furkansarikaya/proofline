// A94 follow-up: hyphenated names vs negation words, heredoc and paren-less SQL, up/down path, manual review row.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { named, buildDocument, manifestDiffSha } from "../../skills/exploit-proof/scripts/diff-manifests.mjs";
import { gate, validate, tableRows } from "../../skills/exploit-proof/scripts/validate-dependencies.mjs";
import { coverage, planBullets } from "../../skills/contract-proof/scripts/diff-contract.mjs";
import { classifyFiles, unanalyzedReason, scanNonSql } from "../../skills/data-design/scripts/classify-migration.mjs";
import { scanMigrations } from "../../skills/data-design/scripts/migration-check.mjs";

const dirs = [];
const mktmp = () => { const d = mkdtempSync(join(tmpdir(), "a94b-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// ---- 1. a negation word inside a hyphenated name is not a negation -----------------------------------
test("declared dependencies with no/not/skip/drop inside their names stay declared", () => {
  for (const n of ["no-case", "is-not-empty", "skip-list", "drop-zone", "@scope/never-throw", "not.js"]) {
    assert.equal(named(`- ${n}: used for the report`, n), true, n);
    assert.equal(named(`- Do not add ${n}`, n), false, `${n} negated`);
  }
  assert.equal(named("- is-not-empty and left-pad for padding", "left-pad"), true, "another package's hyphenated name is not a negation");
});
test("contract coverage: an element named skip-list or no-case is not negated by its own name", () => {
  const ch = { element: "`skip-list`", classification: "breaking" };
  const b = planBullets("## Contracts\n- `o.yaml` `skip-list` removed: migration in place\n");
  assert.equal(coverage("o.yaml", { element: "skip-list", classification: "breaking" }, b).covered, true);
  void ch;
  const b2 = planBullets("## Contracts\n- `o.yaml` `Order.no-case` removed: migration in place\n");
  assert.equal(coverage("o.yaml", { element: "Order.no-case", classification: "breaking" }, b2).covered, true);
  const b3 = planBullets("## Contracts\n- `o.yaml` `skip-list` removed: no migration\n");
  assert.equal(coverage("o.yaml", { element: "skip-list", classification: "breaking" }, b3).covered, false);
});

// ---- 2. heredocs, paren-less execute, text(), raw ------------------------------------------------------
test("rails heredoc SQL is scanned as SQL even next to known operations", () => {
  const src = "class M < ActiveRecord::Migration[7.0]\n  def up\n    add_column :users, :x, :string\n    execute <<~SQL\n      DROP TABLE legacy_users;\n    SQL\n  end\nend\n";
  const acts = scanNonSql(src);
  assert.ok(acts.some((a) => a.kind === "drop_table" && a.class === "destructive"));
  assert.equal(unanalyzedReason(src, acts), null);
});
test("paren-less or computed execute arguments are unanalyzed even with a known operation present", () => {
  const rb = "def up\n  add_column :users, :x, :string\n  execute drop_sql\nend\n";
  assert.match(unanalyzedReason(rb, scanNonSql(rb)), /built at run time/);
  const py = "def upgrade():\n    op.add_column('t', sa.Column('x', sa.String()))\n    op.execute(text(build_sql()))\n";
  assert.match(unanalyzedReason(py, scanNonSql(py)), /run time/);
  const knex = "exports.up = (knex) => knex.schema.createTable('t', () => {}).then(() => knex.raw(sqlText));\n";
  assert.match(unanalyzedReason(knex, scanNonSql(knex)), /run time/);
  const odd = "def up\n  add_column :users, :x, :string\n  execute 'reticulate splines'\nend\n";
  assert.match(unanalyzedReason(odd, scanNonSql(odd)), /not a recognised SQL/);
  const ok = "def upgrade():\n    op.add_column('t', sa.Column('x', sa.String()))\n    op.execute(text(\"UPDATE t SET x = 'a' WHERE id < 10\"))\n";
  assert.equal(unanalyzedReason(ok, scanNonSql(ok)), null);
});
test("python triple-quoted SQL with a drop is classified", () => {
  const py = 'def upgrade():\n    op.execute("""\n        ALTER TABLE users DROP COLUMN phone\n    """)\n';
  assert.ok(scanNonSql(py).some((a) => a.kind === "drop_column"));
});

// ---- 3. up and down paths --------------------------------------------------------------------------------
test("a reversible additive alembic migration is not destructive; its down-path drop is down_destructive", () => {
  const files = {
    "r.py": "def upgrade():\n    op.add_column('users', sa.Column('x', sa.String()))\n\ndef downgrade():\n    op.drop_column('users', 'x')\n",
    "r.js": "exports.up = (knex) => knex.schema.table('t', (t) => { t.string('x'); t.index('x'); });\nexports.down = (knex) => {\n  return knex.schema.table('t', (t) => { t.dropColumn('x'); });\n};\n",
    "r.rb": "class R < ActiveRecord::Migration[7.0]\n  def up\n    add_column :users, :x, :string\n  end\n  def down\n    remove_column :users, :x\n  end\nend\n",
    "d.sql": "-- +goose Up\nALTER TABLE t ADD COLUMN x int;\n-- +goose Down\nALTER TABLE t DROP COLUMN x;\n",
  };
  const dir = mktmp();
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  const r = classifyFiles(Object.keys(files).map((p) => join(dir, p)));
  assert.equal(r.destructive, "no");
  assert.equal(r.down_destructive, "yes");
  assert.ok(r.actions.filter((a) => a.class === "destructive").every((a) => a.path === "down"));
  const s = scanMigrations(Object.keys(files), { read: (f) => files[f] });
  assert.deepEqual(s.not_executable, []);
  assert.equal(s.down_destructive.length, 4);
  assert.deepEqual(s.hazards.filter((h) => h.code === "H05"), []);
  // a drop on the up path still counts
  const upFile = join(dir, "u.py");
  writeFileSync(upFile, "def upgrade():\n    op.drop_column('users', 'x')\n");
  const up = classifyFiles([upFile]);
  assert.equal(up.destructive, "yes");
});

// ---- 4. a by-hand review row for an unparsed manifest ----------------------------------------------------
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.invalid" } });
test("manual_review: a recomputed diff hash lets an unparsed manifest pass at medium; without it, low", () => {
  const r = mktmp();
  git(r, "init", "-q", "-b", "main");
  writeFileSync(join(r, ".pnpmfile.cjs"), "module.exports = {};\n");
  git(r, "add", "-A"); git(r, "commit", "-q", "-m", "base");
  writeFileSync(join(r, ".pnpmfile.cjs"), "module.exports = { hooks: {} };\n");
  const plan = "## Dependencies\n\nnone\n";
  const d = buildDocument({ repo: r, base: "HEAD", planText: plan, configText: "", pathLookup: () => false });
  d.audit = { status: "none_detected" };
  assert.equal(gate(d).confidence, "low");
  const sha = manifestDiffSha(r, "HEAD", ".pnpmfile.cjs");
  d.manual_review = [{ file: ".pnpmfile.cjs", note: "hooks stub only; no dependency touched", diff_sha256: sha }];
  assert.deepEqual(validate(d), []);
  assert.equal(gate(d).confidence, "low", "not recomputed: stays low");
  assert.equal(gate(d, { verified: new Set([".pnpmfile.cjs"]) }).confidence, "medium");
  assert.match(tableRows(d, new Set([".pnpmfile.cjs"])), /reviewed by hand/);
  // the CLI recomputes with --repo/--base
  const f = join(mktmp(), "d.json"); writeFileSync(f, JSON.stringify(d));
  const V = join(process.cwd(), "skills/exploit-proof/scripts/validate-dependencies.mjs");
  const plan_f = join(mktmp(), "PLAN.md"); writeFileSync(plan_f, plan);
  let o = spawnSync("node", [V, f, "--repo", r, "--base", "HEAD", "--plan", plan_f], { encoding: "utf8" });
  assert.equal(o.status, 0, o.stderr + o.stdout);
  assert.match(o.stdout, /RESULT: PASS\nCONFIDENCE: medium/);
  d.manual_review[0].diff_sha256 = "0".repeat(64);
  writeFileSync(f, JSON.stringify(d));
  o = spawnSync("node", [V, f, "--repo", r, "--base", "HEAD", "--plan", plan_f], { encoding: "utf8" });
  assert.equal(o.status, 1);
  assert.match(o.stderr, /diff_sha256 does not match/);
  // a review row for a parsed manifest is refused
  d.manual_review = [{ file: "package.json", note: "x", diff_sha256: sha }];
  assert.ok(validate(d).some((e) => /unparsed manifest/.test(e)));
  o = spawnSync("node", [V, "--diff-sha", ".pnpmfile.cjs", "--base", "HEAD", "--repo", r], { encoding: "utf8" });
  assert.equal(o.stdout.trim(), sha);
});
