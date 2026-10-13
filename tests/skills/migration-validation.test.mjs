import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scanMigrations, parseSchema, diffSchemas, compatibility, diffData, isNarrowing, findReaders } from "../../skills/data-design/scripts/migration-check.mjs";
import { checkReport } from "../../skills/data-design/scripts/validate-migration.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const SETUP = join(ROOT, "fixtures/migration-validation/setup.sh");
const SELFCHECK = join(ROOT, "fixtures/migration-validation/selfcheck.sh");
const CHECK = join(ROOT, "skills/data-design/scripts/migration-check.mjs");
const VALIDATE = join(ROOT, "skills/data-design/scripts/validate-migration.mjs");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scan = (files, ctx = {}, opts = {}) => scanMigrations(Object.keys(files), { context: Object.keys(ctx), read: (f) => ({ ...files, ...ctx })[f], ...opts });
const CTX = { "c.sql": "CREATE TABLE users (id integer PRIMARY KEY, name text, phone varchar(100), n integer, big bigint);" };
const codes = (r) => r.hazards.map((h) => `${h.code}:${h.evidence_class}`).sort();

test("scan: NOT NULL without default is traced only for a declared-populated table", () => {
  const f = { "m.sql": "ALTER TABLE users ADD COLUMN tenant_id integer NOT NULL;" };
  assert.deepEqual(codes(scan(f, CTX, { populated: ["users"] })), ["H01:traced"]);
  assert.deepEqual(codes(scan(f, CTX)), ["H01:judged"]);
  assert.equal(scan(f, CTX).hazards[0].severity, "warn");
  assert.equal(scan(f, CTX, { populated: ["users"] }).hazards[0].severity, "blocking");
  // a table created in the same change is not an existing populated table
  assert.deepEqual(codes(scan({ "m.sql": "CREATE TABLE t (id int);\nALTER TABLE t ADD COLUMN x int NOT NULL;" })), []);
  // with a default it is fine
  assert.deepEqual(codes(scan({ "m.sql": "ALTER TABLE users ADD COLUMN x integer NOT NULL DEFAULT 0;" }, CTX)), []);
});

test("scan: type narrowing is traced from context; unknown prior type is judged; widening is clean", () => {
  assert.deepEqual(codes(scan({ "m.sql": "ALTER TABLE users ALTER COLUMN phone TYPE varchar(10);" }, CTX)), ["H02:traced", "H03:judged"]);
  assert.deepEqual(codes(scan({ "m.sql": "ALTER TABLE users ALTER COLUMN big TYPE integer;" }, CTX)), ["H02:traced", "H03:judged"]);
  assert.deepEqual(codes(scan({ "m.sql": "ALTER TABLE users ALTER COLUMN phone TYPE varchar(10);" })), ["H02:judged", "H03:judged"]);
  assert.deepEqual(codes(scan({ "m.sql": "ALTER TABLE users ALTER COLUMN phone TYPE varchar(200);" }, CTX)), ["H03:judged"]);
  assert.ok(isNarrowing("varchar(100)", "varchar(10)") && !isNarrowing("varchar(10)", "varchar(100)") && !isNarrowing(undefined, "int"));
});

test("scan: index without concurrent option on an existing table only", () => {
  assert.deepEqual(codes(scan({ "m.sql": "CREATE INDEX i ON users (n);" }, CTX, { engine: "postgres" })), ["H04:judged"]);
  assert.deepEqual(codes(scan({ "m.sql": "CREATE INDEX CONCURRENTLY i ON users (n);" }, CTX, { engine: "postgres" })), []);
  assert.deepEqual(codes(scan({ "m.sql": "CREATE TABLE t (a int);\nCREATE INDEX i ON t (a);" })), []);
});

test("scan: drop and rename are traced only when a reader is found; comments and strings are not DDL", () => {
  const readers = { "src/a.js": "const p = row.phone;\n// phone in a comment\n" };
  const r = scan({ "m.sql": "ALTER TABLE users DROP COLUMN phone;" }, CTX, { readerFiles: ["src/a.js"], read: (f) => ({ "m.sql": "ALTER TABLE users DROP COLUMN phone;", ...CTX, ...readers })[f] });
  assert.deepEqual(codes(r), ["H05:traced"]);
  assert.equal(r.hazards[0].readers[0].line, 1);
  assert.equal(r.not_executable.length, 1);
  assert.deepEqual(codes(scan({ "m.sql": "ALTER TABLE users DROP COLUMN phone;" }, CTX)), ["H05:judged"]);
  assert.deepEqual(codes(scan({ "m.sql": "-- DROP COLUMN phone;\nSELECT 'ALTER TABLE users DROP COLUMN phone;';" }, CTX)), []);
  assert.equal(findReaders("phone", ["x"], () => "phonebook = 1\nphone\n").length, 1);
});

test("scan: expand/contract rename (add + bounded NULL-only backfill) raises nothing; unbounded backfill is judged", () => {
  const ok = "ALTER TABLE users ADD COLUMN display_name text;\nUPDATE users SET display_name = name WHERE display_name IS NULL AND id BETWEEN 1 AND 1000;";
  assert.deepEqual(codes(scan({ "m.sql": ok }, CTX)), []);
  assert.deepEqual(codes(scan({ "m.sql": "UPDATE users SET n = 1 WHERE n IS NULL;" }, CTX)), ["H06:judged"]);
  assert.deepEqual(codes(scan({ "m.sql": "UPDATE users SET n = 1;" }, CTX)), ["H06:judged"]);
});

test("diff: DDL and JSON dumps, rollback equality, mixed-version lists", () => {
  const before = parseSchema("CREATE TABLE u (id integer PRIMARY KEY, name text, e varchar(10) NOT NULL);\nCREATE UNIQUE INDEX u_e ON u (e);");
  const after = parseSchema("CREATE TABLE u (id integer PRIMARY KEY, e varchar(5) NOT NULL, t integer NOT NULL, d text);\nCREATE TABLE a (id integer);\nCREATE UNIQUE INDEX u_t ON u (t);\nCREATE UNIQUE INDEX u_e ON u (e);");
  const d = diffSchemas(before, after);
  assert.deepEqual(d.tables_added, ["a"]);
  assert.deepEqual(d.columns_removed.map((c) => c.column), ["name"]);
  assert.deepEqual(d.columns_added.map((c) => c.column).sort(), ["d", "t"]);
  assert.deepEqual(d.columns_changed.map((c) => `${c.column}.${c.field}`), ["e.type"]);
  assert.deepEqual(d.indexes_added, ["u_t"]);
  assert.equal(d.identical, false);
  assert.equal(diffSchemas(before, parseSchema(JSON.stringify(before))).identical, true);
  const c = compatibility(d);
  const old = c.old_app_on_new_schema.map((x) => x.object);
  assert.ok(old.includes("u.name") && old.includes("u.t") && old.includes("u.e") && old.includes("u_t"));
  assert.ok(!old.includes("u.d")); // nullable new column does not break old inserts
  assert.ok(c.new_app_on_old_schema.some((x) => x.object === "a"));
  assert.equal(c.evidence_class, "judged");
});

test("data: counts, missing rows, changed values, dropped and renamed columns", () => {
  const b = { tables: { u: [{ id: 1, a: "x", n: 1 }, { id: 2, a: "y", n: 2 }] } };
  assert.equal(diffData(b, { tables: { u: [{ id: 1, a: "x", n: 1, z: null }, { id: 2, a: "y", n: 2 }] } }).preserved, true);
  const lost = diffData(b, { tables: { u: [{ id: 1, a: "x", n: 1 }] } });
  assert.equal(lost.preserved, false);
  assert.deepEqual(lost.tables.u.missing, [2]);
  const chg = diffData(b, { tables: { u: [{ id: 1, a: "x", n: 9 }, { id: 2, a: "y", n: 2 }] } });
  assert.equal(chg.tables.u.changed[0].column, "n");
  const ren = diffData(b, { tables: { u: [{ id: 1, b: "x", n: 1 }, { id: 2, b: "y", n: 2 }] } });
  assert.deepEqual(ren.tables.u.renamed_columns, [{ from: "a", to: "b" }]);
  assert.equal(ren.preserved, true);
  assert.equal(diffData(b, { tables: {} }).preserved, false);
});

// ---------- report validator ----------

const report = ({ status = "PASS", db = "yes", down = "yes", applied = "yes", destructive = "no", harness = "test/helpers/temp-db.mjs:8", extra = "", over = {} } = {}) => {
  const rows = {
    schema_diff: ["measured", "pass", "diff equals the plan"],
    rollback: ["measured", "pass", "restores_schema true"],
    data_preservation: ["measured", "pass", "3 rows before, 3 after"],
    lock_risk: ["judged", "pass", "no blocking statement"],
    long_running: ["judged", "pass", "no full-table statement"],
    patterns: ["traced", "pass", "scan: no hazard"],
    mixed_version: ["judged", "pass", "additive only"],
    ...over,
  };
  return `# Migration validation: T-1

status: ${status}

## Capability
throwaway_db: ${db}
${db === "yes" ? `harness: ${harness}` : "reason: no test helper creates a temporary database"}
engine: postgres (README.md)
down_migration: ${down}
${extra}

## Migrations
| file | applied | destructive | note |
|---|---|---|---|
| migrations/003_x.sql | ${applied} | ${destructive} | note |

## Checks
| id | check | class | result | evidence |
|---|---|---|---|---|
${Object.entries(rows).map(([id, [c, r, e]]) => `| ${id} | ${id} | ${c} | ${r} | ${e} |`).join("\n")}
`;
};
const codesOf = (md) => checkReport(md).map((e) => e.split(":")[0]);

test("report: a clean measured PASS validates", () => {
  assert.deepEqual(checkReport(report()), []);
});

test("report: no throwaway database is UNSUPPORTED and never PASS", () => {
  const unsupported = { schema_diff: ["judged", "unsupported", "no throwaway database"], rollback: ["judged", "unsupported", "no throwaway database"], data_preservation: ["judged", "unsupported", "no throwaway database"] };
  assert.deepEqual(checkReport(report({ status: "UNSUPPORTED", db: "no", applied: "no", over: unsupported })), []);
  assert.ok(codesOf(report({ status: "PASS", db: "no", applied: "no", over: unsupported })).includes("V14"));
  assert.ok(codesOf(report({ status: "PASS", db: "no" })).includes("V05")); // measured pass without a database
});

test("report: a destructive migration is never applied; measured classes are required; connection strings refused", () => {
  assert.ok(codesOf(report({ destructive: "yes" })).includes("V10"));
  assert.ok(codesOf(report({ over: { schema_diff: ["judged", "pass", "looked fine"] } })).includes("V09"));
  assert.ok(codesOf(report({ over: { lock_risk: ["measured", "pass", "estimated fast"] } })).includes("V09"));
  assert.deepEqual(checkReport(report({ over: { lock_risk: ["measured", "pass", "build took 3.2 s"] } })), []);
  assert.ok(codesOf(report({ over: { patterns: ["traced", "pass", "see postgres://u:p@host/db"] } })).includes("V13"));
});

test("report: judged fails only with a cited criterion; any fail makes FAIL; na rollback needs no down migration", () => {
  assert.ok(codesOf(report({ status: "FAIL", over: { lock_risk: ["judged", "fail", "rewrite"] } })).includes("V08"));
  assert.deepEqual(checkReport(report({ status: "FAIL", over: { lock_risk: ["judged", "fail", "criterion: AC-2 no write lock over 1 s; rewrite"] } })), []);
  assert.deepEqual(checkReport(report({ status: "FAIL", over: { patterns: ["traced", "fail", "H05 src/users.js:3"] } })), []);
  assert.ok(codesOf(report({ status: "PASS", over: { patterns: ["traced", "fail", "H05 src/users.js:3"] } })).includes("V14"));
  assert.ok(codesOf(report({ down: "yes", over: { rollback: ["measured", "na", "no down file"] } })).includes("V11"));
  assert.deepEqual(checkReport(report({ down: "no", over: { rollback: ["measured", "na", "no down migration: rollback is a new forward migration"] } })), []);
  assert.ok(codesOf(report({ status: "PASS", applied: "no" })).includes("V14"));
  assert.ok(codesOf("# x\n").includes("V01"));
});

test("cli: validator exit codes", () => {
  const d = mkdtempSync(join(tmpdir(), "mv-test-"));
  dirs.push(d);
  const ok = join(d, "ok.md");
  const bad = join(d, "bad.md");
  spawnSync("node", ["-e", `require("fs").writeFileSync(${JSON.stringify(ok)}, ${JSON.stringify(report())});require("fs").writeFileSync(${JSON.stringify(bad)}, ${JSON.stringify(report({ status: "UNSUPPORTED" }))})`]);
  assert.match(spawnSync("node", [VALIDATE, ok], { encoding: "utf8" }).stdout, /^OK\nWARN no --repo: .*self-attested.*\nCONFIDENCE: medium\n$/);
  const b = spawnSync("node", [VALIDATE, bad], { encoding: "utf8" });
  assert.equal(b.status, 1);
  assert.match(b.stdout, /FAIL V14/);
  assert.equal(spawnSync("node", [VALIDATE], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("node", [CHECK, "bogus"], { encoding: "utf8" }).status, 2);
});

// ---------- fixture ----------

test("fixture: builds with and without the harness, planted facts hold (selfcheck)", () => {
  const d = mkdtempSync(join(tmpdir(), "mv-fix-"));
  dirs.push(d);
  const s = spawnSync("sh", [SETUP, join(d, "acc")], { encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  const c = spawnSync("sh", [SELFCHECK, join(d, "acc")], { encoding: "utf8" });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /selfcheck ok/);
  const t = spawnSync(process.execPath, ["--test", "test/"], { cwd: join(d, "acc"), encoding: "utf8" });
  assert.equal(t.status, 0, t.stdout + t.stderr);
  const n = spawnSync("sh", [SETUP, join(d, "nohar"), "no-harness"], { encoding: "utf8" });
  assert.equal(n.status, 0, n.stderr);
  assert.throws(() => readFileSync(join(d, "nohar/test/helpers/temp-db.mjs")));
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: join(d, "acc"), encoding: "utf8" }).stdout, "");
});

test("skill wiring: SKILL.md and reviewer role point at the migration validation", () => {
  const skill = readFileSync(join(ROOT, "skills/data-design/SKILL.md"), "utf8");
  assert.match(skill, /references\/MIGRATION-VALIDATION\.md/);
  assert.match(skill, /reviews\/data-migration\/REPORT\.md/);
  const role = readFileSync(join(ROOT, "roles/reviewer.md"), "utf8");
  assert.match(role, /MIGRATION-VALIDATION\.md/);
  assert.match(role, /UNSUPPORTED/);
  for (const f of ["claude/agents/proofline-reviewer.md", "codex/agents/proofline-reviewer.toml"])
    assert.match(readFileSync(join(ROOT, "adapters", f), "utf8"), /MIGRATION-VALIDATION\.md/);
});

test("report: PASS with every check na and empty evidence is rejected (F1)", () => {
  const na = Object.fromEntries(["schema_diff", "rollback", "data_preservation", "lock_risk", "long_running", "patterns", "mixed_version"].map((id) => [id, ["judged", "na", ""]]));
  const c = codesOf(report({ status: "PASS", over: na }));
  assert.ok(c.includes("V12"), c.join());
  const withReason = Object.fromEntries(Object.keys(na).map((id) => [id, ["judged", "na", "nothing to check"]]));
  assert.ok(codesOf(report({ status: "PASS", down: "no", over: withReason })).includes("V14"));
  assert.ok(codesOf(report({ status: "PASS", over: { data_preservation: ["measured", "na", "no seed rows"] } })).includes("V14"));
  assert.deepEqual(checkReport(report({ status: "UNSUPPORTED", over: { data_preservation: ["measured", "na", "no seed rows"] } })), []);
});

test("report: a destructive down migration is not executed unless the project's own test runs it (F3)", () => {
  const extra = "down_destructive: yes";
  assert.ok(codesOf(report({ extra })).includes("V15"));
  const over = { rollback: ["measured", "unsupported", "not executed (destructive statement)"] };
  assert.deepEqual(checkReport(report({ status: "UNSUPPORTED", extra, over })), []);
  assert.ok(codesOf(report({ status: "UNSUPPORTED", extra, over: { rollback: ["measured", "unsupported", "skipped"] } })).includes("V15"));
  assert.deepEqual(checkReport(report({ extra: "down_destructive: yes\ndown_run_by: test/migrations.test.mjs:40" })), []);
});

test("report: connection strings and DSN fragments are refused (F4)", () => {
  for (const bad of ["sqlite:///data/app.db", "mssql://sa:x@h/db", "oracle:thin:@h:1521", "amqp://u:p@h", "clickhouse+http://h:8123", "password=hunter2", "user=app dbname=x", "port=5432", "postgresql:host/db", "database=accounts", "host=db.internal", "jdbc:postgresql://h/db"])
    assert.ok(codesOf(report({ over: { patterns: ["traced", "pass", `scan: ${bad}`] } })).includes("V13"), bad);
});

test("report: empty criterion and non-path harness are rejected (F5, F6)", () => {
  assert.ok(codesOf(report({ status: "FAIL", over: { lock_risk: ["judged", "fail", "criterion: ; rewrite"] } })).includes("V08"));
  assert.ok(codesOf(report({ status: "FAIL", over: { lock_risk: ["judged", "fail", "criterion:"] } })).includes("V08"));
  assert.ok(codesOf(report({ status: "FAIL", over: { lock_risk: ["judged", "fail", "criterion: ..."] } })).includes("V08"));
  assert.ok(codesOf(report({ down: "no", extra: "down_destructive: yes", over: { rollback: ["measured", "na", "no down"] } })).includes("V03"));
  assert.ok(codesOf(report({ harness: "createTestDb" })).includes("V03"));
  assert.deepEqual(checkReport(report({ harness: "test/helpers/temp-db.mjs" })), []);
});
