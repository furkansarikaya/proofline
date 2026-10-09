# Lock risk per engine family

Each step's `lock` cell names: the lock taken, what it blocks (reads, writes, DDL), and the expected duration
(`metadata only`, `scales with table size`, `per batch`). These notes are general guidance for the engine
family; when the version is `unknown`, assume the oldest supported major version and say so. Version-specific
claims not listed here are written as unverified.

Common to all: a DDL statement that waits for a lock blocks every later query on that table behind it.
Set a short lock wait limit for every DDL step and retry instead of queueing behind long transactions.

## Postgres

- Session settings for DDL: `SET lock_timeout = '5s'` (or less) and a `statement_timeout` sized to the step.
- `ADD COLUMN` nullable, or with a constant default (11+): ACCESS EXCLUSIVE, metadata only. Volatile default
  (`DEFAULT now()` is stable, `random()`/`gen_random_uuid()` volatile) or pre-11: table rewrite.
- `DROP COLUMN`: ACCESS EXCLUSIVE, metadata only (space reclaimed later).
- `ALTER COLUMN TYPE`: table rewrite + index rebuild under ACCESS EXCLUSIVE, except binary-compatible changes
  (`varchar(n)` -> larger or `text`).
- `SET NOT NULL`: full scan under ACCESS EXCLUSIVE. Online path: `ADD CONSTRAINT c CHECK (col IS NOT NULL)
  NOT VALID` (brief), `VALIDATE CONSTRAINT c` (SHARE UPDATE EXCLUSIVE, reads and writes continue), then on
  12+ `SET NOT NULL` uses the valid check and skips the scan.
- `ADD FOREIGN KEY` / `CHECK`: same `NOT VALID` + `VALIDATE` split.
- `CREATE INDEX`: SHARE lock, blocks writes for the whole build. Use `CREATE INDEX CONCURRENTLY` (writes
  continue; cannot run inside a transaction, so its own migration file / tool flag; a failed build leaves an
  INVALID index to drop and retry). Same for `DROP INDEX CONCURRENTLY`. A unique constraint: build the
  unique index concurrently, then `ADD CONSTRAINT ... UNIQUE USING INDEX`.
- `RENAME`: ACCESS EXCLUSIVE, metadata only, but breaks readers.
- `UPDATE` backfill: row locks per batch; large single updates bloat the table and lag replicas.
- `TRUNCATE`: ACCESS EXCLUSIVE; `DELETE` row locks.

## MySQL (InnoDB) / MariaDB

- Online DDL: request it explicitly so an unsupported operation fails instead of locking:
  `ALTER TABLE ... , ALGORITHM=INSTANT` (8.0.12+ for ADD COLUMN; 8.0.29+ for DROP COLUMN), else
  `ALGORITHM=INPLACE, LOCK=NONE`.
- Every online ALTER still takes a brief metadata lock at start and end; a long-running transaction on the
  table blocks it and everything queued behind it. Set `lock_wait_timeout` low.
- `MODIFY`/`CHANGE` column type: table copy (`ALGORITHM=COPY`) blocks writes, except `VARCHAR` growth within
  the same length-byte range (<=255 or >255 bytes) which is in place.
- `ADD INDEX`: INPLACE, concurrent DML allowed; `ADD FULLTEXT/SPATIAL`: blocks writes.
- Adding NOT NULL: table rebuild (INPLACE where allowed) and fails/converts on existing NULLs depending on
  `sql_mode`.
- Large tables: external online schema-change tools (`gh-ost`, `pt-online-schema-change`) only if the project
  already uses them (cite the evidence).

## SQLite

- One writer for the whole database: every write, DDL included, takes the database write lock; readers continue
  only in WAL mode (`PRAGMA journal_mode`).
- `ADD COLUMN`: metadata only (no NOT NULL without default, no non-constant default).
- `DROP COLUMN` (3.35+), `RENAME COLUMN` (3.25+): rewrite/check of the schema; older versions and type
  changes need the rebuild pattern: `CREATE TABLE new`, `INSERT INTO new SELECT ...`, `DROP TABLE old`,
  `ALTER TABLE new RENAME TO old`, inside one transaction with `PRAGMA foreign_keys=off` around it. The
  `DROP TABLE` is classified destructive: declare it and its data copy.
- Duration scales with database size; the whole database is write-locked meanwhile.

## SQL Server

- Most `ALTER TABLE` take a schema modification lock (Sch-M), blocking all access.
- `ADD` nullable column, or NOT NULL with a runtime-constant default (Enterprise / Azure SQL): metadata only;
  otherwise a size-of-data update.
- `ALTER COLUMN` type or nullability: size-of-data, Sch-M for the duration, unless the edition supports
  `WITH (ONLINE = ON)` (Enterprise / Azure SQL) - cite the edition evidence, otherwise assume it does not.
- `CREATE INDEX ... WITH (ONLINE = ON)` (Enterprise / Azure SQL); otherwise blocks writes for the build.
- Use `SET LOCK_TIMEOUT <ms>` for DDL; batches with `UPDATE TOP (n)` for backfill; watch the transaction log.

## Document stores (Mongo-style)

- No schema DDL: shape changes are application-level; the steps table uses `update` (bulk `updateMany`),
  `delete`, `drop_table` (collection drop), `drop_column` (`$unset`) and process steps.
- Index builds: since 4.2 an optimized build holds an exclusive lock only at start and end; on a replica set
  each member builds it. Note duration scaling with collection size.
- `$unset` / `deleteMany` / collection `drop()` are destructive; backfill with `updateMany` in `_id` ranges
  and a `{field: {$exists: false}}` filter.
- Validation rules (`collMod` validator) with `validationLevel: moderate` to avoid rejecting old documents.

## Other

Cite the engine's documentation for each lock claim as unverified, and mark every step's lock cell
`unknown: <what would need to be checked>`; this keeps the plan valid and visibly incomplete.
