import { readFileSync } from 'node:fs';
import { NotFoundError, ValidationError } from './service.js';

const PUBLIC_DIR = new URL('../public/', import.meta.url);
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ValidationError('request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new ValidationError('invalid JSON body');
  }
}

export function createHandler(service) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
        const [file, type] = STATIC_FILES[url.pathname];
        res.writeHead(200, { 'content-type': type });
        return res.end(readFileSync(new URL(file, PUBLIC_DIR)));
      }

      if (url.pathname === '/api/books') {
        if (req.method === 'GET') return sendJson(res, 200, service.list(Object.fromEntries(url.searchParams)));
        if (req.method === 'POST') return sendJson(res, 201, service.add(await readJson(req)));
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      const match = url.pathname.match(/^\/api\/books\/(\d+)$/);
      if (match) {
        const id = Number(match[1]);
        if (req.method === 'GET') return sendJson(res, 200, service.get(id));
        if (req.method === 'PATCH') return sendJson(res, 200, service.update(id, await readJson(req)));
        if (req.method === 'DELETE') {
          service.remove(id);
          res.writeHead(204);
          return res.end();
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof ValidationError) return sendJson(res, 400, { error: err.message });
      if (err instanceof NotFoundError) return sendJson(res, 404, { error: err.message });
      console.error(err);
      return sendJson(res, 500, { error: 'internal error' });
    }
  };
}
