// A94: non-SQL migrations are scanned (never skipped) and validate-migration refuses PASS without measurement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { scanMigrations } from "../../skills/data-design/scripts/migration-check.mjs";
import { checkReport } from "../../skills/data-design/scripts/validate-migration.mjs";

const scan = (files, opts = {}) => scanMigrations(Object.keys(files), { read: (f) => files[f], ...opts });

test("scan: alembic-style python, knex-style js and rails-style ruby drops are destructive and not executable", () => {
  const f = {
    "0002_drop.py": "from alembic import op\n\ndef upgrade():\n    op.drop_column('users', 'phone')\n",
    "0003_drop.js": "exports.up = (knex) => knex.schema.dropTable('legacy');\n",
    "0004_drop.rb": "class Drop < ActiveRecord::Migration[7.0]\n  def change\n    remove_column :users, :nickname\n  end\nend\n",
    "0005.sql": "CREATE TABLE ok (id int);",
  };
  const r = scan(f);
  assert.deepEqual(r.not_executable.map((n) => n.file).sort(), ["0002_drop.py", "0003_drop.js", "0004_drop.rb"]);
  const byFile = Object.fromEntries(r.statements.filter((s) => s.method === "token-scan").map((s) => [s.file, s]));
  assert.equal(byFile["0002_drop.py"].kind, "drop_column");
  assert.equal(byFile["0003_drop.js"].kind, "drop_table");
  assert.equal(byFile["0004_drop.rb"].kind, "drop_column");
  assert.deepEqual(r.unanalyzed, []);
  assert.ok(r.hazards.some((h) => h.code === "H05" && h.file === "0002_drop.py"));
});

test("scan: a non-SQL file with run-time built SQL or no recognised operation is listed as unanalyzed", () => {
  const r = scan({
    "dyn.py": "from alembic import op\n\ndef upgrade():\n    op.execute(build_sql(table))\n",
    "empty.js": "module.exports = { up() { doSomethingElse(); } };\n",
    "ok.js": "exports.up = (knex) => knex.schema.createTable('t', (t) => { t.increments('id'); });\n",
  });
  assert.deepEqual(r.unanalyzed.map((u) => u.file).sort(), ["dyn.py", "empty.js"]);
});

test("scan: SQL string literals inside an ORM migration are classified", () => {
  const r = scan({ "m.py": "def upgrade():\n    op.execute(\"ALTER TABLE users DROP COLUMN phone\")\n" });
  assert.equal(r.not_executable.length, 1);
  assert.deepEqual(r.unanalyzed, []);
});

// ---- validate-migration (H8) -------------------------------------------------------------------------
const CHECKS = ["schema_diff", "rollback", "data_preservation", "lock_risk", "long_running", "patterns", "mixed_version"];
function report({ rows = [["db/0001.sql", "yes", "no"]], over = {}, down = "yes", status = "PASS" } = {}) {
  const base = Object.fromEntries(CHECKS.map((c) => [c, ["measured", "pass", "snapshot diff"]]));
  for (const c of ["lock_risk", "long_running", "mixed_version"]) base[c] = ["judged", "pass", "no blocking statement"];
  base.patterns = ["traced", "pass", "scan: no hazard"];
  const chk = { ...base, ...over };
  return [
    `status: ${status}`, "", "## Capability", "throwaway_db: yes", "harness: test/helpers/temp-db.mjs createTestDb", `down_migration: ${down}`, "",
    "## Migrations", "| file | applied | destructive |", "|---|---|---|", ...rows.map((r) => `| ${r.join(" | ")} |`), "",
    "## Checks", "| id | class | result | evidence |", "|---|---|---|---|", ...CHECKS.map((c) => `| ${c} | ${chk[c][0]} | ${chk[c][1]} | ${chk[c][2]} |`), "",
  ].join("\n");
}
const codes = (md, o) => checkReport(md, o).map((e) => e.split(":")[0]);

test("a judged or warn rollback never gives PASS when a down migration exists", () => {
  assert.deepEqual(checkReport(report()), []);
  assert.ok(codes(report({ over: { rollback: ["judged", "warn", "reads fine"] } })).includes("V14"));
  assert.deepEqual(checkReport(report({ status: "UNSUPPORTED", over: { rollback: ["judged", "warn", "reads fine"] } })), []);
});

test("with --repo, a drop marked non-destructive or applied is refused, an unanalyzed file cannot be PASS", () => {
  const dir = mkdtempSync(join(tmpdir(), "mv94-"));
  try {
    const put = (p, c) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); };
    put("db/0001.sql", "ALTER TABLE users DROP COLUMN phone;\n");
    put("db/0002.py", "def upgrade():\n    op.drop_column('users', 'x')\n");
    put("db/0003.js", "module.exports = { up() { go(); } };\n");
    const lie = report({ rows: [["db/0001.sql", "yes", "no"]] });
    assert.ok(codes(lie, { repo: dir }).includes("V16"));
    const py = report({ rows: [["db/0002.py", "no", "no"]], status: "UNSUPPORTED" });
    assert.ok(codes(py, { repo: dir }).includes("V16"), "a python drop marked destructive: no");
    const pyOk = report({ rows: [["db/0002.py", "no", "yes"]], status: "UNSUPPORTED" });
    assert.deepEqual(checkReport(pyOk, { repo: dir }), []);
    const un = report({ rows: [["db/0003.js", "yes", "no"]], status: "UNSUPPORTED" });
    assert.ok(codes(un, { repo: dir }).includes("V17"), "an unanalyzed file cannot be applied");
    const hz = report({ rows: [["db/0004.sql", "yes", "no"]] });
    put("db/0004.sql", "CREATE TABLE t (a int);\nALTER TABLE users ALTER COLUMN phone TYPE varchar(10);\n");
    assert.ok(codes(hz, { repo: dir }).some((c) => c === "V16" || c === "V17"));
    const miss = report({ rows: [["db/none.sql", "no", "no"]], status: "UNSUPPORTED" });
    assert.ok(codes(miss, { repo: dir }).includes("V17"), "a cited migration that does not exist");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
