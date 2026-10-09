import { readFileSync } from 'node:fs';
import { openDb } from './db.js';
import { migrate } from './migrate.js';

const db = openDb();
migrate(db);
const { n } = db.prepare('SELECT COUNT(*) AS n FROM books').get();
if (n === 0) {
  db.exec(readFileSync(new URL('../seed/books.sql', import.meta.url), 'utf8'));
  console.log('seeded sample books');
} else {
  console.log(`skipped: ${n} books already present`);
}
db.close();
