import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate, ValidationError, NotFoundError } from '../src/service.js';
import { createTestService } from './helpers.js';

test('paginate splits a full list into pages', () => {
  assert.deepEqual(paginate(20, 2, 10), { page: 2, pageSize: 10, totalPages: 2, offset: 10 });
});

test('paginate moves a page past the end back to the last page', () => {
  assert.equal(paginate(20, 5, 10).page, 2);
});

test('an empty list is page 1 of 1', () => {
  assert.deepEqual(paginate(0, 1, 10), { page: 1, pageSize: 10, totalPages: 1, offset: 0 });
});

test('add trims input and defaults the status', () => {
  const service = createTestService();
  const book = service.add({ title: '  Dune ', author: 'Frank Herbert' });
  assert.equal(book.title, 'Dune');
  assert.equal(book.status, 'want_to_read');
  assert.equal(book.notes, null);
});

test('add rejects a missing title and an unknown status', () => {
  const service = createTestService();
  assert.throws(() => service.add({ author: 'Nobody' }), ValidationError);
  assert.throws(() => service.add({ title: 'X', author: 'Y', status: 'lost' }), ValidationError);
});

test('list filters by status and returns the newest first', () => {
  const service = createTestService();
  service.add({ title: 'A', author: 'a', status: 'reading' });
  service.add({ title: 'B', author: 'b' });
  service.add({ title: 'C', author: 'c', status: 'reading' });
  const result = service.list({ status: 'reading' });
  assert.deepEqual(result.items.map((b) => b.title), ['C', 'A']);
  assert.equal(result.total, 2);
});

test('list rejects a non-numeric page', () => {
  assert.throws(() => createTestService().list({ page: 'two' }), ValidationError);
});

test('update changes the status and remove deletes the book', () => {
  const service = createTestService();
  const { id } = service.add({ title: 'Dune', author: 'Frank Herbert' });
  assert.equal(service.update(id, { status: 'finished' }).status, 'finished');
  service.remove(id);
  assert.throws(() => service.get(id), NotFoundError);
});
