# Data model

SQLite database, created and updated by `src/migrate.js` from `migrations/`.

## books

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | INTEGER | primary key | |
| `title` | TEXT | not null | 1–200 characters (enforced by the service) |
| `author` | TEXT | not null | 1–200 characters (enforced by the service) |
| `status` | TEXT | not null, default `want_to_read`, check in (`want_to_read`, `reading`, `finished`) | |
| `legacy_notes` | TEXT | nullable | Notes imported from the old spreadsheet. Read-only: the API returns it, nothing writes it. |
| `added_at` | TEXT | not null, default `datetime('now')` | UTC, `YYYY-MM-DD HH:MM:SS` |
| `notes` | TEXT | nullable | User notes, up to 2000 characters (enforced by the service). Added in `002_add_notes.sql`. |

Index `books_status_added_at` on (`status`, `added_at`).

Lists are ordered by `added_at` descending, then `id` descending.

## schema_migrations

| Column | Type | Constraints |
|---|---|---|
| `version` | TEXT | primary key; the migration file name |
| `applied_at` | TEXT | not null, default `datetime('now')` |

## Migrations

| File | Change |
|---|---|
| `001_create_books.sql` | creates `books` and its index |
| `002_add_notes.sql` | adds `books.notes` |
