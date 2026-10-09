# Model: engine, current shape, target shape, reverse mode

Read-only work. Every statement about the schema cites `path:line` (migration, schema file, ORM model) or
`path:symbol` (code that reads or writes a column). No database is ever connected to.

## 1. Engine discovery

Look, in this order, and record every hit in the ledger (path:line and what it says):

1. Migration tool configuration: `flyway.conf`, `liquibase.properties`, `alembic.ini`, `knexfile.*`,
   `ormconfig.*`, `prisma/schema.prisma` (`provider`), `drizzle.config.*`, `config/database.yml`
   (`adapter`), Django `DATABASES` (`ENGINE`), EF Core provider (`UseNpgsql`, `UseSqlServer`, `UseSqlite`,
   `UseMySql`), `dbmate`/`goose`/`golang-migrate` directories and their driver flags.
2. Runtime configuration: `docker-compose*.yml` / Helm / Terraform images and engines (`postgres:16`,
   `mysql:8`, `mcr.microsoft.com/mssql/server`, `mongo:7`), `.env.example` connection strings
   (`postgres://`, `mysql://`, `sqlserver://`, `mongodb://`, `file:*.db`).
3. Driver dependencies in manifests: `pg`, `mysql2`, `better-sqlite3`, `node:sqlite`, `tedious`, `mongodb`,
   `psycopg`, `PyMySQL`, `Npgsql`, `Microsoft.Data.SqlClient`, `go-sql-driver/mysql`, `jackc/pgx`, ...
4. SQL dialect in existing migrations: `bigserial`/`timestamptz`/`$$` (Postgres), `AUTO_INCREMENT`/backticks
   (MySQL), `IDENTITY(1,1)`/`GO`/`[brackets]` (SQL Server), `AUTOINCREMENT`/`PRAGMA` (SQLite).

Result:

- `engine:` one of `postgres`, `mysql` (MariaDB included), `sqlite`, `sqlserver`, `mongo` (any document
  store), `other`. Postgres-compatible engines (CockroachDB, Aurora, Neon) are `postgres` with the product
  named in `version:`; their lock notes cite the product's documentation as unverified.
- `version:` from the image tag, a pinned dependency or a config value; otherwise `unknown` (lock notes then
  assume the oldest supported major version of that engine).
- `migrations:` the directory or glob the project applies, and `tool:` how it applies them (and whether each
  file runs in a transaction).
- Two engines for the same data, or none: NEEDS_INPUT ("Which database holds `<table>` in production?" with
  the candidates found as options). Never pick one.

## 2. Current model

For each table/collection the task touches:

- Columns with type, nullability, default, keys, unique and foreign keys, indexes: replay the migrations in
  order (later files override earlier ones) or read the schema file the tool keeps (`schema.rb`,
  `structure.sql`, `schema.prisma`, EF model snapshot). Cite the defining line.
- Readers and writers: search the code for the table and column names (and ORM field names); each hit is
  `path:symbol`. A column with readers outside the task's scope is a compatibility constraint for the switch
  step.
- Size and traffic: only from the repository (README, ops docs, seed sizes, capacity notes). Without evidence
  assume large and continuously written; say so.

## 3. Target model and invariants

- Mermaid `erDiagram` of the touched entities and their direct relations only: entity blocks with
  `type name PK|FK|UK`, relation lines with cardinality. Columns being removed are not in the target diagram.
- Invariants: rules the data must satisfy at every step of the migration, not only at the end. One line each:
  `- INV-<n>: <rule> (enforced by: <constraint | path:symbol | none: why>)`. Include at least: what the new
  column holds for old rows, NULL handling of every source column (a NULL operand makes most SQL
  expressions NULL), uniqueness and referential rules that move, and what writers must do during the dual
  phase.
- Prefer database constraints over application checks when the engine can add them without a long lock
  ([LOCKS.md](LOCKS.md)).

## 4. Reverse mode

Goal: `DATA_MODEL.md` that states what exists, so design-sync can check it later.

1. Discover the engine and migrations (section 1).
2. Build the current schema from the migrations or the schema file. List every table/collection with its
   columns, keys and indexes; each table cites its defining `path:line`.
3. Relations from foreign keys (and ORM associations, marked `app-enforced`).
4. Invariants only when enforced by something real (a constraint, a unique index, a validator at
   `path:symbol`); never invent business rules.
5. Write [DATA_MODEL.template.md](../assets/DATA_MODEL.template.md). Standalone: into
   `.agents/local/data-design/model/`, then ask before writing `docs/design/DATA_MODEL.md` (or the
   configured `design_docs.data_model`). Every table listed must exist in the replayed schema; every column
   cited must be in its table: check before reporting.
