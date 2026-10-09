export const STATUSES = ['want_to_read', 'reading', 'finished'];
export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 50;

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

export function paginate(total, page, pageSize) {
  const totalPages = Math.max(1, Math.floor(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  return { page: current, pageSize, totalPages, offset: (current - 1) * pageSize };
}

function positiveInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ValidationError(`${name} must be a positive integer`);
  return n;
}

function text(value, name, max, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ValidationError(`${name} is required`);
  if (trimmed.length > max) throw new ValidationError(`${name} must be at most ${max} characters`);
  return trimmed || null;
}

function status(value) {
  if (!STATUSES.includes(value)) throw new ValidationError(`status must be one of ${STATUSES.join(', ')}`);
  return value;
}

function object(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('body must be a JSON object');
  }
  return input;
}

export function createBookService(repo) {
  function get(id) {
    const book = repo.get(id);
    if (!book) throw new NotFoundError(`book ${id} not found`);
    return book;
  }

  return {
    list(query = {}) {
      const filter = query.status ? status(query.status) : undefined;
      const pageSize = Math.min(positiveInt(query.pageSize, DEFAULT_PAGE_SIZE, 'pageSize'), MAX_PAGE_SIZE);
      const total = repo.count({ status: filter });
      const p = paginate(total, positiveInt(query.page, 1, 'page'), pageSize);
      const items = repo.list({ status: filter, limit: p.pageSize, offset: p.offset });
      return { items, page: p.page, pageSize: p.pageSize, total, totalPages: p.totalPages };
    },

    get,

    add(input) {
      object(input);
      return repo.insert({
        title: text(input.title, 'title', 200, true),
        author: text(input.author, 'author', 200, true),
        status: input.status === undefined ? 'want_to_read' : status(input.status),
        notes: text(input.notes, 'notes', 2000),
      });
    },

    update(id, input) {
      object(input);
      get(id);
      const changes = {};
      if (input.status !== undefined) changes.status = status(input.status);
      if (input.notes !== undefined) changes.notes = text(input.notes, 'notes', 2000);
      return repo.update(id, changes);
    },

    remove(id) {
      if (!repo.remove(id)) throw new NotFoundError(`book ${id} not found`);
    },
  };
}
