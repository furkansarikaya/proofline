import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export function migrate(db, dir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(dir, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(file);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
    ran.push(file);
  }
  return ran;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const ran = migrate(db);
  console.log(ran.length ? `applied: ${ran.join(', ')}` : 'up to date');
  db.close();
}
