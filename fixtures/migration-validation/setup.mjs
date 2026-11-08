// Builds the migration-validation fixture repository in <target-dir> (must be empty or absent).
// Planted SQL files and schema/seed dumps; no database engine is needed or started.
// Optional second argument "no-harness": the same project without a throwaway-database test helper.
// Deterministic, no network, no installs.
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target @param {string} [mode] "no-harness" (or anything but "harness") leaves the throwaway-database helper out */
export function build(target, mode = 'harness') {
  const f = new Fx(target);
  f.init();
  f.git(['config', 'user.name', 'Fixture']);
  f.git(['config', 'user.email', 'fixture@example.invalid']);
  f.git(['config', 'commit.gpgsign', 'false']);
  f.git(['config', 'core.autocrlf', 'false']);
  f.mkdir(`migrations`, `src`, `test`, `scenarios`);
f.w(`package.json`, `{ "name": "accounts-fixture", "private": true, "type": "module", "scripts": { "test": "node --test test/" } }
`);
f.w(`README.md`, `# accounts

User accounts service (Node, no dependencies in this excerpt).

- Production database: PostgreSQL. \`users\` holds millions of rows; the app serves traffic around the clock.
- Migrations: plain SQL in \`migrations/\`, applied in file-name order. \`scenarios/<name>/\` holds one pending
  change each (migration file, before/after/after-rollback schema dumps, seed rows before/after).
`);
f.w(`.gitignore`, `node_modules/
.env
`);
f.w(`src/users.js`, `// The running application: it reads and writes these columns today.
export function displayLabel(row) {
  return row.name || row.email;
}
export function contactPhone(row) {
  return row.phone;
}
export const INSERT_USER = "INSERT INTO users (id, email, name, phone) VALUES ($1, $2, $3, $4)";
`);
f.w(`migrations/001_create_users.sql`, `CREATE TABLE users (
  id integer PRIMARY KEY,
  email varchar(100) NOT NULL,
  name text,
  phone varchar(100),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);
`);
f.w(`migrations/002_create_orders.sql`, `CREATE TABLE orders (
  id integer PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users (id),
  total integer NOT NULL
);
`);
  if (mode === 'harness') {
  f.mkdir(`test/helpers`);
  f.w(`test/helpers/temp-db.mjs`, `// The test suite's own throwaway database: every call creates a fresh, empty database in a new temp
// directory and removes it when the test ends. Tests never receive a connection string from env or config.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "accounts-test-db-"));
  return { path: join(dir, "test.db"), drop: () => rmSync(dir, { recursive: true, force: true }) };
}
`);
  f.w(`test/users.test.mjs`, `import test from "node:test";
import assert from "node:assert/strict";
import { createTempDatabase } from "./helpers/temp-db.mjs";

test("a throwaway database is created and removed", () => {
  const db = createTempDatabase();
  assert.ok(db.path.endsWith("test.db"));
  db.drop();
});
`);
  }
  // ---- scenarios ----
  const BEFORE_SQL = `CREATE TABLE users (
  id integer PRIMARY KEY,
  email varchar(100) NOT NULL,
  name text,
  phone varchar(100),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE TABLE orders (
  id integer PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users (id),
  total integer NOT NULL
);
`;
  const SEED = `{ "tables": {
    "users": [
      { "id": 1, "email": "ada@example.test", "name": "Ada", "phone": "+49 170 1234567" },
      { "id": 2, "email": "bob@example.test", "name": "Bob", "phone": "12345" },
      { "id": 3, "email": "cyd@example.test", "name": null, "phone": null }
    ],
    "orders": [ { "id": 10, "user_id": 1, "total": 500 }, { "id": 11, "user_id": 2, "total": 75 } ]
} }
`;
  // name: directory, shared before dump and seed rows
  const scenario = (/** @type {string} */ name) => {
    f.mkdir(`scenarios/${name}/migration`);
    f.w(`scenarios/${name}/before.sql`, BEFORE_SQL);
    f.w(`scenarios/${name}/seed-before.json`, SEED);
  };
  /** after-rollback is the before dump and seed-after the seed rows rewritten by `fn` (default: the same rows) @param {string} name @param {string} after @param {(seed: string) => string} [fn] */
  const finish = (name, after, fn = (x) => x) => {
    f.w(`scenarios/${name}/after.sql`, after);
    f.w(`scenarios/${name}/after-rollback.sql`, BEFORE_SQL);
    f.w(`scenarios/${name}/seed-after.json`, fn(SEED));
  };
  // 1. clean additive: nullable column + new table; rollback restores the schema; no hazards.
  scenario('clean-additive');
f.w(`scenarios/clean-additive/migration/003_add_notes_and_audit.sql`, `ALTER TABLE users ADD COLUMN notes text;
CREATE TABLE audit_log (
  id integer PRIMARY KEY,
  user_id integer,
  action text
);
`);
  finish('clean-additive', `${BEFORE_SQL.replace(/^  phone varchar\(100\),$/m, '  phone varchar(100),\n  notes text,')}CREATE TABLE audit_log (
  id integer PRIMARY KEY,
  user_id integer,
  action text
);
`,
    (x) => x.replace(/"phone": ("[^"]*"|null) \}/g, '"phone": $1, "notes": null }'));
  // 2. NOT NULL without default on a populated table (trap).
  scenario('notnull-no-default');
f.w(`scenarios/notnull-no-default/migration/003_add_tenant.sql`, `ALTER TABLE users ADD COLUMN tenant_id integer NOT NULL;
`);
  // 3. expand/contract rename (decoy): new column + bounded NULL-only backfill, old column kept.
  scenario('rename-expand-contract');
f.w(`scenarios/rename-expand-contract/migration/003_add_display_name.sql`, `-- expand step of a rename: the old column "name" stays until no reader remains
ALTER TABLE users ADD COLUMN display_name text;
UPDATE users SET display_name = name WHERE display_name IS NULL AND id BETWEEN 1 AND 100000;
`);
  finish('rename-expand-contract', BEFORE_SQL.replace(/^  phone varchar\(100\),$/m, '  phone varchar(100),\n  display_name text,'),
    (x) => x.replace(/"name": ("[^"]*"|null), "phone"/g, '"name": $1, "display_name": $1, "phone"'));
  // 4. in-place rename while the application still reads the old name.
  scenario('rename-in-place');
f.w(`scenarios/rename-in-place/migration/003_rename_name.sql`, `ALTER TABLE users RENAME COLUMN name TO full_name;
`);
  finish('rename-in-place', BEFORE_SQL.replace(/^  name text,$/m, '  full_name text,'), (x) => x.replace(/"name":/g, '"full_name":'));
  // 5. index creation without the concurrent option on an existing table.
  scenario('index-create');
f.w(`scenarios/index-create/migration/003_index_created_at.sql`, `CREATE INDEX idx_users_created_at ON users (created_at);
`);
  finish('index-create', `${BEFORE_SQL}CREATE INDEX idx_users_created_at ON users (created_at);
`);
  // 6. data-losing type narrowing (a seeded value is longer than the new limit).
  scenario('type-narrow');
f.w(`scenarios/type-narrow/migration/003_narrow_phone.sql`, `ALTER TABLE users ALTER COLUMN phone TYPE varchar(10);
`);
  // 7. drop of a column the running application reads.
  scenario('drop-column-read');
f.w(`scenarios/drop-column-read/migration/003_drop_phone.sql`, `ALTER TABLE users DROP COLUMN phone;
`);
  // the shell builder committed at the current time; a fixed date makes the history reproducible
  f.commit('fixture: accounts with planted migration scenarios', '2026-01-01T10:00:00Z');

}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir> [no-harness]', argc: [1, 2] });
