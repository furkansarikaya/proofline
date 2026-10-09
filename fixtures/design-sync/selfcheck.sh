#!/bin/sh
# shellcheck disable=SC2016 # backticks are literal markdown
# Proves the planted facts of the design-sync fixture built in $1.
set -eu
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }

# Drift 1: audit_log is documented, no migration creates it.
grep -q '^### `audit_log`' docs/design/DATA_MODEL.md || fail "audit_log not documented"
grep -riq 'create table[^(]*audit_log' migrations && fail "audit_log is created somewhere"
# Decoy: tasks is created by a lower-case statement with a quoted name.
grep -q '^create table if not exists "tasks" (' migrations/002_tasks.sql || fail "tasks decoy missing"
grep -q '^CREATE TABLE users' migrations/001_init.sql || fail "users missing"
grep -q '^CREATE TABLE projects' migrations/001_init.sql || fail "projects missing"

# Drift 2: ARCHITECTURE cites a moved path.
grep -q '`src/jobs/mailer.js`' docs/design/ARCHITECTURE.md || fail "mailer path not cited"
[ ! -e src/jobs/mailer.js ] || fail "old mailer path still exists"
[ -f src/notify/mailer.js ] || fail "mailer not at new path"
# Decoys: ./src/store/ and other cited paths exist.
[ -d ./src/store/ ] && [ -f src/api/routes.js ] && [ -f src/api/handlers.js ] && [ -d migrations ] \
  || fail "decoy architecture paths missing"

# Drift 3: DELETE /projects/{id} documented, no such route.
grep -q '| DELETE | `/projects/{id}`' docs/design/API.md || fail "DELETE not documented"
grep -q "method: 'DELETE'" src/api/routes.js && fail "DELETE route exists"
# Decoys: {id} in docs vs :id in code.
grep -q "method: 'GET', path: '/projects/:id'" src/api/routes.js || fail "GET :id decoy missing"
grep -q "method: 'PATCH', path: '/projects/:id'" src/api/routes.js || fail "PATCH :id decoy missing"

# Drift 4: --color-surface documented, not defined.
grep -q '`--color-surface`' DESIGN.md || fail "surface token not documented"
grep -q -- '--color-surface' src/styles/tokens.css && fail "surface token defined"
# Decoys: hex case differs only.
grep -q -- '--color-primary: #1a73e8;' src/styles/tokens.css || fail "primary decoy missing"
grep -q '`--color-primary` | `#1A73E8`' DESIGN.md || fail "primary doc decoy missing"
grep -q -- '--color-danger: #d93025;' src/styles/tokens.css || fail "danger decoy missing"

# The migrations really create exactly these tables.
node --experimental-sqlite --no-warnings --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const db = new DatabaseSync(':memory:');
db.exec(readFileSync('migrations/001_init.sql', 'utf8'));
db.exec(readFileSync('migrations/002_tasks.sql', 'utf8'));
const names = db.prepare(\"select name from sqlite_master where type = 'table' order by name\").all().map(r => r.name).join(',');
if (names !== 'projects,tasks,users') { console.error(names); process.exit(1); }
" 2>/dev/null || fail "migrations do not create exactly projects, tasks, users"
echo "selfcheck: design-sync ok"
