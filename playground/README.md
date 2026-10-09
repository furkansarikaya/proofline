# Reading List

A small personal libary service: keep track of the books you want to read, are reading, and have finished.
It is a JSON API and a single web page served by the same Node.js process, with data stored in SQLite.

## Requirements

Node.js 22.13 or newer. There are no dependencies to install.

## Commands

```sh
npm run migrate   # create or update the database (data/reading-list.db)
npm run seed      # load sample books into an empty database
npm start         # serve the API and the page on http://127.0.0.1:3000
npm test          # run unit and API tests against an in-memory database
```

Environment variables: `DB_PATH` (default `data/reading-list.db`), `PORT` (default `3000`).
`npm start` applies pending migrations before it listens.

## Layout

| Path | Purpose |
|---|---|
| `src/server.js` | HTTP server and wiring |
| `src/routes.js` | request routing, JSON parsing, static files, error mapping |
| `src/service.js` | validation, pagination, business rules |
| `src/repository.js` | SQL access to the `books` table |
| `src/db.js` | opens the SQLite database |
| `src/migrate.js` | applies `migrations/NNN_name.sql` files in order, once each |
| `src/seed.js`, `seed/books.sql` | sample data |
| `public/` | the web page (`index.html`, `app.js`) |
| `tests/` | `node --test` tests |
| `docs/design/` | data model and API reference |

## Migrations

Each file in `migrations/` is named `NNN_description.sql` and runs once, in name order, inside a
transaction. Applied versions are recorded in the `schema_migrations` table. Never edit a migration
that has been applied; add a new one.
