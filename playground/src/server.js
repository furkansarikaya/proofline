import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { migrate } from './migrate.js';
import { createBookRepository } from './repository.js';
import { createBookService } from './service.js';
import { createHandler } from './routes.js';

export function createApp(db) {
  return createServer(createHandler(createBookService(createBookRepository(db))));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  migrate(db);
  const port = Number(process.env.PORT ?? 3000);
  createApp(db).listen(port, '127.0.0.1', () => {
    console.log(`reading list running at http://127.0.0.1:${port}`);
  });
}
