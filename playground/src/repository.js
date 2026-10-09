const COLUMNS = 'id, title, author, status, notes, legacy_notes, added_at';

function toBook(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    status: row.status,
    notes: row.notes,
    legacyNotes: row.legacy_notes,
    addedAt: row.added_at,
  };
}

export function createBookRepository(db) {
  return {
    list({ status, limit, offset }) {
      const where = status ? 'WHERE status = ?' : '';
      const params = status ? [status] : [];
      return db
        .prepare(`SELECT ${COLUMNS} FROM books ${where} ORDER BY added_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset)
        .map(toBook);
    },

    count({ status }) {
      if (status) return db.prepare('SELECT COUNT(*) AS n FROM books WHERE status = ?').get(status).n;
      return db.prepare('SELECT COUNT(*) AS n FROM books').get().n;
    },

    get(id) {
      return toBook(db.prepare(`SELECT ${COLUMNS} FROM books WHERE id = ?`).get(id));
    },

    insert({ title, author, status, notes }) {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO books (title, author, status, notes) VALUES (?, ?, ?, ?)')
        .run(title, author, status, notes);
      return this.get(Number(lastInsertRowid));
    },

    update(id, changes) {
      const sets = [];
      const params = [];
      if (changes.status !== undefined) {
        sets.push('status = ?');
        params.push(changes.status);
      }
      if (changes.notes !== undefined) {
        sets.push('notes = ?');
        params.push(changes.notes);
      }
      if (sets.length) db.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
      return this.get(id);
    },

    remove(id) {
      return db.prepare('DELETE FROM books WHERE id = ?').run(id).changes > 0;
    },
  };
}
