# API

JSON over HTTP, served by `src/server.js`. Request bodies are JSON objects of at most 64 KiB.
Errors are `{ "error": "<message>" }` with status 400 (invalid input), 404 (unknown book or path)
or 405 (method not allowed).

## Book

```json
{
  "id": 1,
  "title": "Dune",
  "author": "Frank Herbert",
  "status": "want_to_read",
  "notes": null,
  "legacyNotes": null,
  "addedAt": "2024-02-29 13:00:00"
}
```

`status` is one of `want_to_read`, `reading`, `finished`. `legacyNotes` is read-only.

## Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/books` | – | 200 page object (below) |
| POST | `/api/books` | `title` (required), `author` (required), `status`, `notes` | 201 Book |
| GET | `/api/books/:id` | – | 200 Book |
| PATCH | `/api/books/:id` | `status`, `notes` (both optional; `notes: null` clears) | 200 Book |
| DELETE | `/api/books/:id` | – | 204 |

### GET /api/books

Query parameters:

| Name | Default | Rule |
|---|---|---|
| `status` | all | one of the statuses |
| `page` | 1 | positive integer; a page past the end returns the last page |
| `pageSize` | 10 | positive integer, capped at 50 |

Response:

```json
{ "items": [Book], "page": 1, "pageSize": 10, "total": 20, "totalPages": 2 }
```

Items are ordered newest first (`addedAt` descending, then `id` descending).

## Static files

| Path | File |
|---|---|
| `/` | `public/index.html` |
| `/app.js` | `public/app.js` |
