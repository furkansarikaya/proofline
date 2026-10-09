import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let server;
before(async () => {
  server = await startTestServer();
});
after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(server.baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('POST /api/books creates a book', async () => {
  const res = await call('POST', '/api/books', { title: 'Kindred', author: 'Octavia E. Butler' });
  assert.equal(res.status, 201);
  assert.equal(res.body.title, 'Kindred');
  assert.equal(res.body.legacyNotes, null);
});

test('POST /api/books rejects invalid input with 400', async () => {
  const res = await call('POST', '/api/books', { title: '' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /title/);
});

test('GET /api/books pages through the list', async () => {
  for (let i = 1; i < 10; i++) await call('POST', '/api/books', { title: `Book ${i}`, author: 'Author' });
  const first = await call('GET', '/api/books?pageSize=5');
  const second = await call('GET', '/api/books?pageSize=5&page=2');
  assert.equal(first.body.total, 10);
  assert.equal(first.body.totalPages, 2);
  assert.equal(second.body.items.length, 5);
  assert.equal(second.body.items.at(-1).title, 'Kindred');
});

test('PATCH and DELETE /api/books/:id', async () => {
  const { body: book } = await call('POST', '/api/books', { title: 'Solaris', author: 'Stanislaw Lem' });
  const patched = await call('PATCH', `/api/books/${book.id}`, { status: 'reading', notes: 'Chapter 3' });
  assert.equal(patched.body.status, 'reading');
  assert.equal(patched.body.notes, 'Chapter 3');
  assert.equal((await call('DELETE', `/api/books/${book.id}`)).status, 204);
  assert.equal((await call('GET', `/api/books/${book.id}`)).status, 404);
});

test('GET / serves the page', async () => {
  const res = await fetch(server.baseUrl + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<h1>Reading List<\/h1>/);
});
