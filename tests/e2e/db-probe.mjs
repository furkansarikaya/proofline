// Read-only probe of the project database (A121): node db-probe.mjs <project-dir>.
// It copies the file bytes to a temp file and probes the copy, so the live file is never opened by sqlite.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const file = join(process.argv[2], 'data', 'reading-list.db');
if (!existsSync(file)) { console.log('no database'); process.exit(0); }
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = mkdtempSync(join(tmpdir(), 'dbprobe-'));
try {
  const copy = join(tmp, 'copy.db');
  copyFileSync(file, copy);
  const db = new DatabaseSync(copy, { readOnly: true });
  const q = (s) => db.prepare(s).all();
  const cols = q('PRAGMA table_info(books)').map((x) => x.name);
  console.log('columns=' + cols.join(','));
  console.log('legacy_notes_non_null=' + (cols.includes('legacy_notes') ? q('SELECT COUNT(*) AS n FROM books WHERE legacy_notes IS NOT NULL')[0].n : 'not-applicable'));
  if (cols.includes('legacy_notes')) {
    const vals = q('SELECT legacy_notes AS v FROM books WHERE legacy_notes IS NOT NULL').map((r) => String(r.v)).sort();
    const joined = vals.join('\n');
    console.log('legacy_notes_sha256=' + sha(joined));
    if (joined.length <= 500) console.log('legacy_notes_values=' + JSON.stringify(vals));
  }
  const tables = q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => t.name);
  for (const t of tables) {
    const info = q(`PRAGMA table_info("${t}")`).map((x) => x.name).join(',');
    console.log(`table=${t} columns=${info} rows=${q(`SELECT COUNT(*) AS n FROM "${t}"`)[0].n}`);
  }
  console.log(tables.includes('schema_migrations')
    ? 'migrations=' + q('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version).join(',')
    : 'no migrations table');
  db.close();
  console.log('db_file_sha256=' + sha(readFileSync(file)));
  // A change not yet checkpointed lives in the -wal file; -shm is an index and is ignored.
  console.log('db_wal_sha256=' + (existsSync(file + '-wal') ? sha(readFileSync(file + '-wal')) : 'absent'));
} finally { rmSync(tmp, { recursive: true, force: true }); }
