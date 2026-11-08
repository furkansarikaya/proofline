// Runs the dependency-free migration helpers over the built fixture (<dir>) and asserts the planted facts.
// usage: node selfcheck.mjs <built-dir>
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { repoRoot, run } from '../../tests/lib/fixture.mjs';

const dir = path.resolve(process.argv[2] ?? (console.error('usage: node selfcheck.mjs <built-dir>'), process.exit(2)));
const mc = path.join(repoRoot, 'skills/data-design/scripts/migration-check.mjs');
/** The helper's JSON on stdout (the shell piped it into node and a parse failure was a failure). @param {string[]} args @returns {any} */
const json = (...args) => { const r = run('node', [mc, ...args], { cwd: dir }); try { return JSON.parse(r.out); } catch { return undefined; } };
const bad = (/** @type {string} */ m) => { console.log(m); process.exit(1); };

/** @param {string} s scenario @param {string} want @param {...string} extra extra scan options */
function check(s, want, ...extra) {
  const f = readdirSync(path.join(dir, 'scenarios', s, 'migration')).filter((n) => n.endsWith('.sql')).sort().map((n) => `scenarios/${s}/migration/${n}`);
  const j = json('scan', '--engine', 'postgres', ...extra, '--context', 'migrations/001_create_users.sql', 'migrations/002_create_orders.sql', '--readers', 'src', '--', ...f);
  const got = j ? `${j.hazards.map((/** @type {any} */ h) => `${h.code}:${h.evidence_class}`).join(',')}|${j.not_executable.length}` : 'undefined';
  if (got !== want) bad(`FAIL scan ${s}: expected '${want}' got '${got}'`);
}
check('clean-additive', '|0');
check('notnull-no-default', 'H01:traced|1', '--populated', 'users');
check('notnull-no-default', 'H01:judged|1');
check('rename-expand-contract', '|0');
check('rename-in-place', 'H05:traced|0');
check('index-create', 'H04:judged|0');
check('type-narrow', 'H02:traced,H03:judged|1');
check('drop-column-read', 'H05:traced|1');

let j = json('diff', 'scenarios/clean-additive/before.sql', 'scenarios/clean-additive/after.sql', '--rollback', 'scenarios/clean-additive/after-rollback.sql');
if (!(j && j.diff.tables_added.join() === 'audit_log' && j.diff.columns_added.length === 1 && j.diff.columns_added[0].column === 'notes' &&
  j.rollback.restores_schema === true && j.compatibility.old_app_on_new_schema.length === 0 && j.compatibility.new_app_on_old_schema.length === 2)) bad('FAIL diff clean-additive');
j = json('diff', 'scenarios/rename-in-place/before.sql', 'scenarios/rename-in-place/after.sql');
if (!(j && j.diff.columns_removed.some((/** @type {any} */ c) => c.column === 'name') && j.compatibility.old_app_on_new_schema.some((/** @type {any} */ c) => c.object === 'users.name'))) bad('FAIL diff rename-in-place');
for (const s of ['clean-additive', 'rename-expand-contract', 'index-create']) {
  j = json('data', `scenarios/${s}/seed-before.json`, `scenarios/${s}/seed-after.json`);
  if (!j || j.preserved !== true) bad('FAIL data preserved');
}
j = json('data', 'scenarios/rename-in-place/seed-before.json', 'scenarios/rename-in-place/seed-after.json');
const u = j?.tables.users;
if (!(u && u.missing.length === 0 && u.renamed_columns.some((/** @type {any} */ r) => r.from === 'name' && r.to === 'full_name'))) bad('FAIL data rename');
console.log('migration-validation selfcheck ok');
