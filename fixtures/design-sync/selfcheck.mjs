// Proves the planted facts of the design-sync fixture built in <dir>. usage: node selfcheck.mjs <built-dir>
import { readdirSync } from 'node:fs';
import { enter, fail, has, isDir, isFile, exists, run } from '../selfcheck-lib.mjs';

enter();
/** `grep -ri 'create table[^(]*audit_log' migrations` */
const createsAuditLog = () => readdirSync('migrations').some((n) => has(`migrations/${n}`, /create table[^(]*audit_log/i));

// Drift 1: audit_log is documented, no migration creates it.
if (!has('docs/design/DATA_MODEL.md', /^### `audit_log`/)) fail('audit_log not documented');
if (createsAuditLog()) fail('audit_log is created somewhere');
// Decoy: tasks is created by a lower-case statement with a quoted name.
if (!has('migrations/002_tasks.sql', /^create table if not exists "tasks" \(/)) fail('tasks decoy missing');
if (!has('migrations/001_init.sql', /^CREATE TABLE users/)) fail('users missing');
if (!has('migrations/001_init.sql', /^CREATE TABLE projects/)) fail('projects missing');

// Drift 2: ARCHITECTURE cites a moved path.
if (!has('docs/design/ARCHITECTURE.md', '`src/jobs/mailer.js`')) fail('mailer path not cited');
if (exists('src/jobs/mailer.js')) fail('old mailer path still exists');
if (!isFile('src/notify/mailer.js')) fail('mailer not at new path');
// Decoys: ./src/store/ and other cited paths exist.
if (!(isDir('./src/store/') && isFile('src/api/routes.js') && isFile('src/api/handlers.js') && isDir('migrations'))) fail('decoy architecture paths missing');

// Drift 3: DELETE /projects/{id} documented, no such route.
if (!has('docs/design/API.md', '| DELETE | `/projects/{id}`')) fail('DELETE not documented');
if (has('src/api/routes.js', "method: 'DELETE'")) fail('DELETE route exists');
// Decoys: {id} in docs vs :id in code.
if (!has('src/api/routes.js', "method: 'GET', path: '/projects/:id'")) fail('GET :id decoy missing');
if (!has('src/api/routes.js', "method: 'PATCH', path: '/projects/:id'")) fail('PATCH :id decoy missing');

// Drift 4: --color-surface documented, not defined.
if (!has('docs/design/DESIGN.md', '`--color-surface`')) fail('surface token not documented');
if (has('src/styles/tokens.css', '--color-surface')) fail('surface token defined');
// Decoys: hex case differs only.
if (!has('src/styles/tokens.css', '--color-primary: #1a73e8;')) fail('primary decoy missing');
if (!has('docs/design/DESIGN.md', '`--color-primary` | `#1A73E8`')) fail('primary doc decoy missing');
if (!has('src/styles/tokens.css', '--color-danger: #d93025;')) fail('danger decoy missing');

// The migrations really create exactly these tables.
const script = `
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const db = new DatabaseSync(':memory:');
db.exec(readFileSync('migrations/001_init.sql', 'utf8'));
db.exec(readFileSync('migrations/002_tasks.sql', 'utf8'));
const names = db.prepare("select name from sqlite_master where type = 'table' order by name").all().map(r => r.name).join(',');
if (names !== 'projects,tasks,users') { console.error(names); process.exit(1); }
`;
if (run(process.execPath, ['--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', script]).status !== 0) fail('migrations do not create exactly projects, tasks, users');
console.log('selfcheck: design-sync ok');
