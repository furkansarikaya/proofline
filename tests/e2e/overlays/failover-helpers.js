import { Readable } from 'node:stream';
import { openDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createBookRepository } from '../src/repository.js';
import { createBookService } from '../src/service.js';
import { createApp } from '../src/server.js';

// FAILOVER scenario only (tests/e2e/run.mjs copies this file over tests/helpers.js of the project copy before the baseline commit).
// A Codex worker runs in a profile without network (a loopback listener is refused: `listen EPERM 127.0.0.1`), so `startTestServer` does not listen.
// It keeps its interface ({ baseUrl, close }): a test that calls `fetch(server.baseUrl + path)` reaches the same request handler in this process.

export function createTestDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

export function createTestService() {
  return createBookService(createBookRepository(createTestDb()));
}

const ORIGIN = 'http://reading-list.test';

/** Run one request through the server's request handler without a socket. */
async function handle(server, request) {
  const body = Buffer.from(await request.arrayBuffer());
  const url = new URL(request.url);
  const req = Readable.from(body.length ? [body] : []);
  req.method = request.method;
  req.url = url.pathname + url.search;
  req.headers = Object.fromEntries(request.headers);
  const headers = new Headers();
  const chunks = [];
  let status = 200;
  const done = new Promise((resolve) => {
    const res = {
      writeHead(code, h = {}) { status = code; for (const [k, v] of Object.entries(h)) headers.set(k, String(v)); return res; },
      setHeader(k, v) { headers.set(k, String(v)); },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve(); },
    };
    server.emit('request', req, res);
  });
  await done;
  const payload = Buffer.concat(chunks);
  const empty = status === 204 || status === 304;
  return new Response(empty ? null : payload, { status, headers });
}

export async function startTestServer() {
  const server = createApp(createTestDb());
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    return request.url.startsWith(ORIGIN) ? handle(server, request) : realFetch(input, init);
  };
  return { baseUrl: ORIGIN, close: () => { globalThis.fetch = realFetch; return Promise.resolve(); } };
}
