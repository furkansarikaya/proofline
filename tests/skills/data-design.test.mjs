import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { maskSql, splitStatements, classifyFiles, isWidening, KINDS } from "../../skills/data-design/scripts/classify-migration.mjs";
import { checkDataDoc, checkPlanDoc } from "../../skills/data-design/scripts/validate-data.mjs";

const SKILL = new URL("../../skills/data-design/", import.meta.url).pathname;
const CLASSIFY = join(SKILL, "scripts/classify-migration.mjs");
const VALIDATE = join(SKILL, "scripts/validate-data.mjs");
const FIXTURE = new URL("../../fixtures/data-design/setup.sh", import.meta.url).pathname;
const SCHEMA = JSON.parse(readFileSync(join(SKILL, "schema/classification.schema.json"), "utf8"));

const dirs = [];
const mktmp = () => { const d = mkdtempSync(join(tmpdir(), "dd-test-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sql = (text, context = "") => {
  const files = { "m.sql": text, "ctx.sql": context };
  return classifyFiles(["m.sql"], context ? ["ctx.sql"] : [], (f) => files[f]);
};
const one = (text, context) => { const r = sql(text, context); assert.equal(r.actions.length, 1, JSON.stringify(r.actions)); return r.actions[0]; };

// ---------- lexer ----------

test("masking hides comments, strings and dollar bodies, keeps offsets and lines", () => {
  const src = "-- DROP TABLE a;\nSELECT 'DROP TABLE b; x' /* TRUNCATE c; */, $$DELETE FROM d;$$;\nDROP TABLE e;";
  const m = maskSql(src);
  assert.equal(m.length, src.length);
  assert.equal(m.split("\n").length, 3);
  assert.doesNotMatch(m, /DROP TABLE a|DROP TABLE b|TRUNCATE|DELETE/);
  const st = splitStatements(src);
  assert.equal(st.length, 2);
  assert.equal(st[1].line, 3);
  assert.match(st[1].text, /^DROP TABLE e/);
});

test("escaped quotes and SQL Server GO separators", () => {
  assert.equal(splitStatements("INSERT INTO t VALUES ('it''s; fine');").length, 1);
  assert.equal(splitStatements("INSERT INTO t VALUES (E'a\\'; b');").length, 1);
  assert.equal(splitStatements("CREATE TABLE a (id int)\nGO\nDROP TABLE a\nGO\n").length, 2);
});

// ---------- classification ----------

const CASES = [
  ["DROP TABLE IF EXISTS users CASCADE", "drop_table", "users", "destructive"],
  ["DROP SCHEMA billing CASCADE", "drop_schema", "billing", "destructive"],
  ["TRUNCATE TABLE sessions", "truncate", "sessions", "destructive"],
  ["DELETE FROM sessions WHERE expires_at < now()", "delete", "sessions", "destructive"],
  ["ALTER TABLE public.\"Users\" DROP COLUMN first_name", "drop_column", "users.first_name", "destructive"],
  ["ALTER TABLE `users` DROP `nick`", "drop_column", "users.nick", "destructive"],
  ["ALTER TABLE users ADD COLUMN full_name text", "add_column", "users.full_name", "safe"],
  ["ALTER TABLE users ADD COLUMN status text NOT NULL", "add_column", "users.status", "destructive"],
  ["ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'new'", "add_column", "users.status", "safe"],
  ["ALTER TABLE users ALTER COLUMN full_name SET NOT NULL", "set_not_null", "users.full_name", "destructive"],
  ["ALTER TABLE users ALTER COLUMN first_name DROP NOT NULL", "drop_not_null", "users.first_name", "safe"],
  ["ALTER TABLE users ALTER COLUMN total TYPE numeric(10,2)", "alter_column_type", "users.total", "destructive"],
  ["ALTER TABLE users MODIFY COLUMN name varchar(10) NOT NULL", "alter_column_type", "users.name", "destructive"],
  ["ALTER TABLE users ALTER COLUMN name TYPE int USING name::int", "alter_column_type", "users.name", "destructive"],
  ["ALTER TABLE users RENAME COLUMN name TO full_name", "rename_column", "users.name", "breaking"],
  ["ALTER TABLE users RENAME TO people", "rename_table", "users", "breaking"],
  ["ALTER TABLE users DROP CONSTRAINT users_email_key", "drop_constraint", "users.users_email_key", "breaking"],
  ["ALTER TABLE users ADD CONSTRAINT c CHECK (full_name IS NOT NULL) NOT VALID", "add_constraint", "users", "safe"],
  ["ALTER TABLE users VALIDATE CONSTRAINT c", "alter_other", "users", "safe"],
  ["CREATE INDEX CONCURRENTLY users_email_lower_idx ON users (lower(email))", "create_index", "users", "safe"],
  ["DROP INDEX CONCURRENTLY users_email_lower_idx", "drop_index", "users_email_lower_idx", "breaking"],
  ["UPDATE users SET full_name = concat_ws(' ', first_name, last_name) WHERE full_name IS NULL AND id BETWEEN 1 AND 5000", "update", "users", "safe"],
  ["UPDATE users SET full_name = 'x' WHERE full_name IS NULL OR id = 1", "update", "users", "destructive"],
  ["UPDATE users SET first_name = NULL", "update", "users", "destructive"],
  ["INSERT INTO users (email) VALUES ('a@example.com')", "insert", "users", "safe"],
  ["INSERT INTO users (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1", "insert", "users", "destructive"],
  ["REPLACE INTO users (id) VALUES (1)", "replace", "users", "destructive"],
  ["COMMENT ON COLUMN users.nickname IS 'never TRUNCATE'", "other", "", "safe"],
  ["DO $$ BEGIN DELETE FROM users; END $$", "unknown", "", "unknown"],
];

for (const [stmt, kind, object, cls] of CASES) {
  test(`classify: ${stmt.slice(0, 60)}`, () => {
    const a = one(stmt + ";");
    assert.deepEqual([a.kind, a.object, a.class], [kind, object, cls], a.reason);
  });
}

test("NOT NULL on a table created in the same change is safe", () => {
  const r = sql("CREATE TABLE t (id int);\nALTER TABLE t ADD COLUMN c text NOT NULL;\nALTER TABLE t ALTER COLUMN c SET NOT NULL;");
  assert.deepEqual(r.actions.map((a) => a.class), ["safe", "safe", "safe"]);
  assert.equal(r.destructive, "no");
});

test("type widening is provable only from a prior definition (--context)", () => {
  const ctx = "CREATE TABLE users (id bigint PRIMARY KEY, name varchar(50) NOT NULL, age smallint);";
  assert.equal(one("ALTER TABLE users ALTER COLUMN name TYPE varchar(100);", ctx).class, "safe");
  assert.equal(one("ALTER TABLE users ALTER COLUMN name TYPE text;", ctx).class, "safe");
  assert.equal(one("ALTER TABLE users ALTER COLUMN age TYPE bigint;", ctx).class, "safe");
  assert.equal(one("ALTER TABLE users ALTER COLUMN name TYPE varchar(10);", ctx).class, "destructive");
  assert.equal(one("ALTER TABLE users ALTER COLUMN name TYPE varchar(100);").class, "destructive");
  assert.equal(isWidening("character varying(20)", "varchar(30)"), true);
  assert.equal(isWidening("bigint", "integer"), false);
});

test("multi-action ALTER yields one action per clause; overall destructive", () => {
  const r = sql("ALTER TABLE users DROP COLUMN a, DROP COLUMN IF EXISTS b, ADD CONSTRAINT u UNIQUE (email);");
  assert.deepEqual(r.actions.map((a) => `${a.kind}:${a.object}`), ["drop_column:users.a", "drop_column:users.b", "add_constraint:users"]);
  assert.equal(r.destructive, "yes");
});

test("non-SQL migrations: token scan, SQL in strings, comments ignored", () => {
  const files = {
    "m1.js": "// dropColumn here is a comment\nexports.up = (knex) => knex.schema.alterTable('users', (t) => {\n  t.dropColumn('first_name');\n});\nawait knex.raw(\"ALTER TABLE users DROP COLUMN last_name\");\nawait db.collection('s').deleteMany({});\n",
    "m2.js": "exports.up = (knex) => knex.schema.alterTable('users', (t) => { t.string('nickname'); });\n",
    "m3.py": "# RemoveField in a comment\nmigrations.RenameField('user', 'name', 'full_name')\n",
  };
  const r = classifyFiles(Object.keys(files), [], (f) => files[f]);
  assert.deepEqual(r.files.map((f) => f.method), ["token-scan", "token-scan", "token-scan"]);
  assert.deepEqual(r.actions.map((a) => `${a.file}:${a.line}:${a.kind}:${a.object}:${a.class}`), [
    "m1.js:3:drop_column:first_name:destructive",
    "m1.js:5:drop_column:users.last_name:destructive",
    "m1.js:6:delete:?:destructive",
    "m3.py:2:rename_column:user:breaking",
  ]);
});

test("output conforms to the schema enums and required keys", () => {
  const r = sql(CASES.map((c) => c[0] + ";").join("\n"));
  const p = SCHEMA.properties;
  assert.deepEqual(Object.keys(r).sort(), [...SCHEMA.required].sort());
  const item = p.actions.items;
  for (const a of r.actions) {
    assert.deepEqual(Object.keys(a).sort(), [...item.required].sort());
    assert.ok(item.properties.kind.enum.includes(a.kind), a.kind);
    assert.ok(item.properties.class.enum.includes(a.class), a.class);
    assert.ok(a.line >= 1 && a.statement.length <= 300);
  }
  assert.deepEqual(item.properties.kind.enum, KINDS);
});

test("CLI: usage error exits 2, JSON on stdout", () => {
  assert.equal(spawnSync(process.execPath, [CLASSIFY]).status, 2);
  assert.equal(spawnSync(process.execPath, [CLASSIFY, "--bogus", "x.sql"]).status, 2);
  const d = mktmp();
  writeFileSync(join(d, "a.sql"), "ALTER TABLE t ADD COLUMN c int;");
  const res = spawnSync(process.execPath, [CLASSIFY, join(d, "a.sql")], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).destructive, "no");
});

// ---------- DATA.md / PLAN.md validation ----------

const PLAN_SECTION = `destructive: yes
Merge first_name and last_name into full_name, then remove the old columns.

| step | phase | operation | object | destructive | reversible | rollback | lock |
|---|---|---|---|---|---|---|---|
| S1 | expand | add_column | users.full_name | no | yes | ALTER TABLE users DROP COLUMN full_name (before S6 only) | ACCESS EXCLUSIVE, metadata only; lock_timeout 5s |
| S2 | expand | drop_not_null | users.first_name | no | yes | ALTER TABLE users ALTER COLUMN first_name SET NOT NULL | ACCESS EXCLUSIVE, metadata only |
| S3 | expand | create_index | users | no | yes | DROP INDEX CONCURRENTLY users_email_lower_idx | SHARE UPDATE EXCLUSIVE, writes continue; own file, no transaction |
| S4 | expand | dual_write | users | no | yes | redeploy the previous release | no lock |
| S5 | backfill | update | users.full_name | no | yes | none needed: only fills NULL full_name; S1 rollback drops it | row locks per batch of 5000, under 1 s |
| S6 | switch | add_constraint | users | no | yes | ALTER TABLE users DROP CONSTRAINT users_full_name_present | brief ACCESS EXCLUSIVE, NOT VALID skips the scan |
| S7 | switch | alter_other | users | no | yes | no-op (validation only) | SHARE UPDATE EXCLUSIVE, scans, reads and writes continue |
| S8 | switch | switch_reads | users | no | yes | redeploy the previous release | no lock |
| S9 | contract | backup | users | no | yes | delete the snapshot | no lock (MVCC read) |
| S10 | contract | drop_column | users.first_name | yes | no | restore from the S9 snapshot: add the column, update from the snapshot | ACCESS EXCLUSIVE, metadata only; lock_timeout 5s |
| S11 | contract | drop_column | users.last_name | yes | no | restore from the S9 snapshot: add the column, update from the snapshot | ACCESS EXCLUSIVE, metadata only; lock_timeout 5s |
`;

const DRAFT = `\`\`\`sql
-- S1
ALTER TABLE users ADD COLUMN full_name varchar(201);
-- S2
ALTER TABLE users ALTER COLUMN first_name DROP NOT NULL;
\`\`\`

\`\`\`sql
-- S3 (own file: CONCURRENTLY cannot run in a transaction)
CREATE INDEX CONCURRENTLY users_email_lower_idx ON users (lower(email));
\`\`\`

\`\`\`sql
-- S5, per batch
UPDATE users SET full_name = concat_ws(' ', first_name, last_name)
WHERE full_name IS NULL AND id > :last_id AND id <= :last_id + 5000;
-- S6, S7
ALTER TABLE users ADD CONSTRAINT users_full_name_present CHECK (full_name IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_full_name_present;
-- S10, S11
ALTER TABLE users DROP COLUMN first_name;
ALTER TABLE users DROP COLUMN last_name;
\`\`\`
`;

const dataDoc = ({ plan = PLAN_SECTION, draft = DRAFT, engine, model, inv, backfill, loss } = {}) => `# Data design: DATA-1 — Single full name for users

## Plan section

${plan}
## Engine

${engine ?? "engine: postgres\nversion: 16\nevidence: docker-compose.yml:3\nmigrations: migrations/\ntool: psql -f per file (README.md:7)"}

## Model

${model ?? "```mermaid\nerDiagram\n  USERS {\n    bigint id PK\n    varchar email UK\n    varchar full_name\n  }\n```"}

## Invariants

${inv ?? "- INV-1: full_name is never NULL after S5 (enforced by: users_full_name_present)\n- INV-2: a NULL last_name yields full_name = first_name (enforced by: concat_ws in S5)"}

## Draft statements

${draft}
## Backfill

${backfill ?? "batch_size: 5000 rows by id range\nidempotency: WHERE full_name IS NULL\nresume: max(id) WHERE full_name IS NOT NULL"}

## Rollback

Release 1 (S1-S5) and release 2 (S6-S8) are reversible; S10 is the point of no return.

## Data loss

${loss ?? "- S10: first_name values; recoverable only from the S9 snapshot\n- S11: last_name values; splitting full_name back is ambiguous (\"Mary Ann Smith\")"}

## Proposed DATA_MODEL.md changes

Create docs/design/DATA_MODEL.md with users(id, email, full_name, nickname, created_at).
`;

const codes = (res) => res.errors.map((e) => e.split(":")[0]);

test("a complete DATA.md is valid (drafts match the table)", () => {
  assert.deepEqual(checkDataDoc(dataDoc()).errors, []);
});

const BAD = [
  ["D01 missing section", () => dataDoc().replace("## Rollback", "## Undo"), "D01"],
  ["D02 first line", () => dataDoc({ plan: PLAN_SECTION.replace("destructive: yes", "Destructive: maybe") }), "D02"],
  ["D03 header", () => dataDoc({ plan: PLAN_SECTION.replace("| lock |", "| locks |") }), "D03"],
  ["D04 phase", () => dataDoc({ plan: PLAN_SECTION.replace("| S4 | expand |", "| S4 | prepare |") }), "D04"],
  ["D04 operation", () => dataDoc({ plan: PLAN_SECTION.replace("| dual_write |", "| magic |") }), "D04"],
  ["D04 duplicate id", () => dataDoc({ plan: PLAN_SECTION.replace("| S4 |", "| S3 |") }), "D04"],
  ["D05 empty rollback", () => dataDoc({ plan: PLAN_SECTION.replace("| redeploy the previous release | no lock |\n| S5", "| none | no lock |\n| S5") }), "D05"],
  ["D05 empty lock", () => dataDoc({ plan: PLAN_SECTION.replace("| delete the snapshot | no lock (MVCC read) |", "| delete the snapshot | - |") }), "D05"],
  ["D06 drop marked non-destructive", () => dataDoc({ plan: PLAN_SECTION.replace("| users.last_name | yes | no |", "| users.last_name | no | no |") }), "D06"],
  ["D07 destructive reversible", () => dataDoc({ plan: PLAN_SECTION.replace("| users.first_name | yes | no |", "| users.first_name | yes | yes |") }), "D07"],
  ["D08 header mismatch", () => dataDoc({ plan: PLAN_SECTION.replace("destructive: yes", "destructive: no") }), "D08"],
  ["D09 phase order", () => dataDoc({ plan: PLAN_SECTION.replace("| S9 | contract |", "| S9 | expand |") }), "D09"],
  ["D10 data loss", () => dataDoc({ loss: "- S10: first_name values" }), "D10"],
  ["D11 engine", () => dataDoc({ engine: "engine: oracle\nevidence: x:1\nmigrations: m/" }), "D11"],
  ["D11 migrations line", () => dataDoc({ engine: "engine: postgres\nevidence: x:1" }), "D11"],
  ["D12 model", () => dataDoc({ model: "users has columns" }), "D12"],
  ["D13 invariant enforcement", () => dataDoc({ inv: "- INV-1: full_name is never NULL" }), "D13"],
  ["D14 backfill", () => dataDoc({ backfill: "batches of 5000" }), "D14"],
  ["D15 no drafts", () => dataDoc({ draft: "planned statements follow later\n" }), "D15"],
];
for (const [name, make, code] of BAD) {
  test(`DATA.md rejected: ${name}`, () => assert.ok(codes(checkDataDoc(make())).includes(code), JSON.stringify(checkDataDoc(make()).errors)));
}

test("draft statements that disagree with the table fail (undeclared and mis-declared)", () => {
  const extra = DRAFT.replace("ALTER TABLE users DROP COLUMN last_name;", "ALTER TABLE users DROP COLUMN last_name;\nDELETE FROM sessions;");
  assert.ok(checkDataDoc(dataDoc({ draft: extra })).errors.some((e) => e.startsWith("draft M1")));
  const lie = DRAFT.replace("WHERE full_name IS NULL AND", "WHERE");
  assert.ok(checkDataDoc(dataDoc({ draft: lie })).errors.some((e) => e.startsWith("draft M2")));
});

test("deferred destructive steps keep the plan destructive: yes and must not be drafted (A55)", () => {
  const plan = PLAN_SECTION.replace(/\| S(9|10|11) \| contract \|/g, "| S$1 | deferred |");
  const draft = DRAFT.replace("ALTER TABLE users DROP COLUMN first_name;\nALTER TABLE users DROP COLUMN last_name;\n", "");
  assert.deepEqual(checkDataDoc(dataDoc({ plan, draft })).errors, []);
  assert.ok(checkDataDoc(dataDoc({ plan })).errors.some((e) => e.startsWith("draft M4")));
  // a header that says "no" while a deferred step is destructive is refused (D08)
  const lie = plan.replace("destructive: yes", "destructive: no");
  assert.ok(checkDataDoc(dataDoc({ plan: lie, draft })).errors.some((e) => e.includes("D08")), "destructive: no with a deferred destructive step");
});

// ---------- review gate (frozen PLAN.md vs the implemented migrations) ----------

function review(migrations, plan = PLAN_SECTION) {
  const d = mktmp();
  writeFileSync(join(d, "PLAN.md"), `# Plan\n\n## Behavior\n\nx\n\n## Data\n\n${plan}\n## Tests\n\nx\n`);
  const files = Object.entries(migrations).map(([name, body]) => { writeFileSync(join(d, name), body); return join(d, name); });
  writeFileSync(join(d, "001.sql"), "CREATE TABLE users (id bigserial PRIMARY KEY, email varchar(320) NOT NULL, first_name varchar(100) NOT NULL, last_name varchar(100));");
  return spawnSync(process.execPath, [VALIDATE, join(d, "PLAN.md"), "--migrations", ...files, "--context", join(d, "001.sql")], { encoding: "utf8" });
}
const IMPL = {
  "004_expand.sql": "ALTER TABLE users ADD COLUMN full_name varchar(201);\nALTER TABLE users ALTER COLUMN first_name DROP NOT NULL;\n",
  "005_index.sql": "CREATE INDEX CONCURRENTLY users_email_lower_idx ON users (lower(email));\n",
  "006_backfill.sql": "UPDATE users SET full_name = concat_ws(' ', first_name, last_name) WHERE full_name IS NULL AND id <= 5000;\n",
  "007_switch.sql": "ALTER TABLE users ADD CONSTRAINT users_full_name_present CHECK (full_name IS NOT NULL) NOT VALID;\nALTER TABLE users VALIDATE CONSTRAINT users_full_name_present;\n",
  "008_contract.sql": "BEGIN;\nALTER TABLE users DROP COLUMN first_name;\nALTER TABLE users DROP COLUMN last_name;\nCOMMIT;\n",
};

test("review gate: implementation matching the frozen plan passes", () => {
  const r = review(IMPL);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), "OK");
});

const GATE = [
  ["M1 undeclared destructive statement", { ...IMPL, "009_cleanup.sql": "DELETE FROM sessions;\n" }, PLAN_SECTION, "M1"],
  ["M2 destructive statement declared non-destructive", { ...IMPL, "006_backfill.sql": "UPDATE users SET full_name = first_name;\n" }, PLAN_SECTION, "M2"],
  ["M3 planned step missing", { ...IMPL, "005_index.sql": "SELECT 1;\n" }, PLAN_SECTION, "M3"],
  ["M4 deferred step present", IMPL, PLAN_SECTION.replace(/\| S(9|10|11) \| contract \|/g, "| S$1 | deferred |"), "M4"],
  ["D05 missing rollback for a reversible step", IMPL, PLAN_SECTION.replace("| DROP INDEX CONCURRENTLY users_email_lower_idx |", "|  |"), "D05"],
];
for (const [name, migrations, plan, code] of GATE) {
  test(`review gate FAIL: ${name}`, () => {
    const r = review(migrations, plan);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^FAIL ${code}:`, "m"));
  });
}

test("review gate: M5 when the diff is destructive but the plan says no", () => {
  const plan = `destructive: no\nadd a column\n\n| step | phase | operation | object | destructive | reversible | rollback | lock |\n|---|---|---|---|---|---|---|---|\n| S1 | expand | drop_column | users.nickname | no | yes | re-add | brief |\n`;
  const r = review({ "010.sql": "ALTER TABLE users DROP COLUMN nickname;" }, plan);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL M5:/m);
  assert.match(r.stdout, /^FAIL M2:/m);
});

test("PLAN.md without ## Data and unreadable input", () => {
  assert.ok(codes(checkPlanDoc("# Plan\n\n## Behavior\n")).includes("D01"));
  assert.equal(spawnSync(process.execPath, [VALIDATE]).status, 2);
  assert.equal(spawnSync(process.execPath, [VALIDATE, "/nonexistent/PLAN.md"]).status, 2);
});

// ---------- fixture known answer ----------

test("fixture: builds, its tests pass, existing migrations (with decoys) are non-destructive", () => {
  const d = join(mktmp(), "accounts");
  const s = spawnSync("sh", [FIXTURE, d], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  const t = spawnSync(process.execPath, ["--test", "test/"], { cwd: d, encoding: "utf8" });
  assert.equal(t.status, 0, t.stdout + t.stderr);
  const migs = readdirSync(join(d, "migrations")).sort().map((f) => join(d, "migrations", f));
  const r = classifyFiles(migs);
  assert.equal(r.destructive, "no", JSON.stringify(r.actions.filter((a) => a.class !== "safe")));
  // the known answer: the task's correct implementation is destructive
  const impl = classifyFiles(Object.keys(IMPL), migs, (f) => IMPL[f] ?? readFileSync(f, "utf8"));
  assert.equal(impl.destructive, "yes");
  assert.deepEqual(impl.actions.filter((a) => a.class === "destructive").map((a) => a.object), ["users.first_name", "users.last_name"]);
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: d, encoding: "utf8" }).stdout, "");
});

test("skill files: shared rules block present, SKILL.md under 500 lines, frontmatter", () => {
  const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  const shared = readFileSync(new URL("../shared/shared-rules.md", import.meta.url), "utf8").trim();
  assert.ok(skill.includes(shared), "shared rules block drifted");
  assert.ok(skill.split("\n").length < 500);
  assert.match(skill, /^---\nname: data-design\ndescription: .{1,900}\nlicense: MIT\ndisable-model-invocation: true\nmetadata:\n  version: "0\.0\.12"\n---\n/);
  for (const ref of skill.matchAll(/\]\(((?:references|assets|schema|scripts)\/[^)#]+)/g))
    assert.ok(readFileSync(join(SKILL, ref[1])), ref[1]);
});

test("team-mode paths: design ledger under design/, review artifact and ledger in reviews/data-design/REVIEW.md", () => {
  const skill = readFileSync(SKILL + "SKILL.md", "utf8");
  const review = readFileSync(SKILL + "references/REVIEW.md", "utf8");
  assert.match(skill, /design\/data-ledger\.md/);
  assert.match(skill, /reviews\/data-design\/REVIEW\.md <sha256>/);
  assert.match(skill, /never writes `design\/data-ledger\.md`/);
  assert.match(review, /REVIEW_DATA-<n> \| blocking/);
});
