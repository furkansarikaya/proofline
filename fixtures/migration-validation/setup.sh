#!/bin/sh
# Builds the migration-validation fixture repository in $1 (must be empty or absent).
# Planted SQL files and schema/seed dumps; no database engine is needed or started.
# Optional second argument "no-harness": the same project without a throwaway-database test helper.
# Deterministic, no network, no installs.
set -eu

{ [ $# -ge 1 ] && [ $# -le 2 ]; } || { echo "usage: sh setup.sh <target-dir> [no-harness]" >&2; exit 2; }
TARGET=$1
MODE=${2:-harness}
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $TARGET" >&2
  exit 1
fi
mkdir -p "$TARGET"
cd "$TARGET"

git init -q
git symbolic-ref HEAD refs/heads/main
git config user.name Fixture
git config user.email fixture@example.invalid
git config commit.gpgsign false
git config core.autocrlf false

mkdir -p migrations src test scenarios

cat > package.json <<'EOF'
{ "name": "accounts-fixture", "private": true, "type": "module", "scripts": { "test": "node --test test/" } }
EOF

cat > README.md <<'EOF'
# accounts

User accounts service (Node, no dependencies in this excerpt).

- Production database: PostgreSQL. `users` holds millions of rows; the app serves traffic around the clock.
- Migrations: plain SQL in `migrations/`, applied in file-name order. `scenarios/<name>/` holds one pending
  change each (migration file, before/after/after-rollback schema dumps, seed rows before/after).
EOF

cat > .gitignore <<'EOF'
node_modules/
.env
EOF

cat > src/users.js <<'EOF'
// The running application: it reads and writes these columns today.
export function displayLabel(row) {
  return row.name || row.email;
}
export function contactPhone(row) {
  return row.phone;
}
export const INSERT_USER = "INSERT INTO users (id, email, name, phone) VALUES ($1, $2, $3, $4)";
EOF

cat > migrations/001_create_users.sql <<'EOF'
CREATE TABLE users (
  id integer PRIMARY KEY,
  email varchar(100) NOT NULL,
  name text,
  phone varchar(100),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);
EOF

cat > migrations/002_create_orders.sql <<'EOF'
CREATE TABLE orders (
  id integer PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users (id),
  total integer NOT NULL
);
EOF

if [ "$MODE" = harness ]; then
  mkdir -p test/helpers
  cat > test/helpers/temp-db.mjs <<'EOF'
// The test suite's own throwaway database: every call creates a fresh, empty database in a new temp
// directory and removes it when the test ends. Tests never receive a connection string from env or config.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "accounts-test-db-"));
  return { path: join(dir, "test.db"), drop: () => rmSync(dir, { recursive: true, force: true }) };
}
EOF
  cat > test/users.test.mjs <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { createTempDatabase } from "./helpers/temp-db.mjs";

test("a throwaway database is created and removed", () => {
  const db = createTempDatabase();
  assert.ok(db.path.endsWith("test.db"));
  db.drop();
});
EOF
fi

# ---- scenarios ----
BEFORE_SQL='CREATE TABLE users (
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
'

scenario() { # name: directory, shared before dump and seed rows
  mkdir -p "scenarios/$1/migration"
  printf '%s' "$BEFORE_SQL" > "scenarios/$1/before.sql"
  cat > "scenarios/$1/seed-before.json" <<'EOF'
{ "tables": {
    "users": [
      { "id": 1, "email": "ada@example.test", "name": "Ada", "phone": "+49 170 1234567" },
      { "id": 2, "email": "bob@example.test", "name": "Bob", "phone": "12345" },
      { "id": 3, "email": "cyd@example.test", "name": null, "phone": null }
    ],
    "orders": [ { "id": 10, "user_id": 1, "total": 500 }, { "id": 11, "user_id": 2, "total": 75 } ]
} }
EOF
}

# 1. clean additive: nullable column + new table; rollback restores the schema; no hazards.
scenario clean-additive
cat > scenarios/clean-additive/migration/003_add_notes_and_audit.sql <<'EOF'
ALTER TABLE users ADD COLUMN notes text;
CREATE TABLE audit_log (
  id integer PRIMARY KEY,
  user_id integer,
  action text
);
EOF
{ printf '%s' "$BEFORE_SQL" | sed 's/^  phone varchar(100),$/  phone varchar(100),\n  notes text,/'
  printf 'CREATE TABLE audit_log (\n  id integer PRIMARY KEY,\n  user_id integer,\n  action text\n);\n'; } > scenarios/clean-additive/after.sql
cp scenarios/clean-additive/before.sql scenarios/clean-additive/after-rollback.sql
sed 's/"phone": \("[^"]*"\|null\) }/"phone": \1, "notes": null }/' scenarios/clean-additive/seed-before.json > scenarios/clean-additive/seed-after.json

# 2. NOT NULL without default on a populated table (trap).
scenario notnull-no-default
cat > scenarios/notnull-no-default/migration/003_add_tenant.sql <<'EOF'
ALTER TABLE users ADD COLUMN tenant_id integer NOT NULL;
EOF

# 3. expand/contract rename (decoy): new column + bounded NULL-only backfill, old column kept.
scenario rename-expand-contract
cat > scenarios/rename-expand-contract/migration/003_add_display_name.sql <<'EOF'
-- expand step of a rename: the old column "name" stays until no reader remains
ALTER TABLE users ADD COLUMN display_name text;
UPDATE users SET display_name = name WHERE display_name IS NULL AND id BETWEEN 1 AND 100000;
EOF
printf '%s' "$BEFORE_SQL" | sed 's/^  phone varchar(100),$/  phone varchar(100),\n  display_name text,/' > scenarios/rename-expand-contract/after.sql
cp scenarios/rename-expand-contract/before.sql scenarios/rename-expand-contract/after-rollback.sql
sed 's/"name": \("[^"]*"\|null\), "phone"/"name": \1, "display_name": \1, "phone"/' scenarios/rename-expand-contract/seed-before.json > scenarios/rename-expand-contract/seed-after.json

# 4. in-place rename while the application still reads the old name.
scenario rename-in-place
cat > scenarios/rename-in-place/migration/003_rename_name.sql <<'EOF'
ALTER TABLE users RENAME COLUMN name TO full_name;
EOF
printf '%s' "$BEFORE_SQL" | sed 's/^  name text,$/  full_name text,/' > scenarios/rename-in-place/after.sql
cp scenarios/rename-in-place/before.sql scenarios/rename-in-place/after-rollback.sql
sed 's/"name":/"full_name":/' scenarios/rename-in-place/seed-before.json > scenarios/rename-in-place/seed-after.json

# 5. index creation without the concurrent option on an existing table.
scenario index-create
cat > scenarios/index-create/migration/003_index_created_at.sql <<'EOF'
CREATE INDEX idx_users_created_at ON users (created_at);
EOF
{ printf '%s' "$BEFORE_SQL"; printf 'CREATE INDEX idx_users_created_at ON users (created_at);\n'; } > scenarios/index-create/after.sql
cp scenarios/index-create/before.sql scenarios/index-create/after-rollback.sql
cp scenarios/index-create/seed-before.json scenarios/index-create/seed-after.json

# 6. data-losing type narrowing (a seeded value is longer than the new limit).
scenario type-narrow
cat > scenarios/type-narrow/migration/003_narrow_phone.sql <<'EOF'
ALTER TABLE users ALTER COLUMN phone TYPE varchar(10);
EOF

# 7. drop of a column the running application reads.
scenario drop-column-read
cat > scenarios/drop-column-read/migration/003_drop_phone.sql <<'EOF'
ALTER TABLE users DROP COLUMN phone;
EOF

git add -A
git commit -q -m "fixture: accounts with planted migration scenarios"
