import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_DB_PATH = 'data/reading-list.db';

export function openDb(path = process.env.DB_PATH ?? DEFAULT_DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
