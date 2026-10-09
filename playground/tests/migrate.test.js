import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';

test('migrate applies every migration once, in order', () => {
  const db = openDb(':memory:');
  assert.deepEqual(migrate(db), ['001_create_books.sql', '002_add_notes.sql']);
  assert.deepEqual(migrate(db), []);
  const columns = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  assert.ok(columns.includes('notes'));
});
