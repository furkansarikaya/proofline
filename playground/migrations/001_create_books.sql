CREATE TABLE books (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'want_to_read'
    CHECK (status IN ('want_to_read', 'reading', 'finished')),
  legacy_notes TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX books_status_added_at ON books (status, added_at);
