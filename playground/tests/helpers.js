import { openDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createBookRepository } from '../src/repository.js';
import { createBookService } from '../src/service.js';
import { createApp } from '../src/server.js';

export function createTestDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

export function createTestService() {
  return createBookService(createBookRepository(createTestDb()));
}

export async function startTestServer() {
  const server = createApp(createTestDb());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, close: () => new Promise((resolve) => server.close(resolve)) };
}
