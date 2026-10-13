# Migration validation (REVIEW_DATA focus `migration`)

Runs inside gate `REVIEW_DATA` when `agent.sh pipeline <ID>` lists `focus.REVIEW_DATA.migration` (a migration
path signal, or `## Data` in the plan). It answers one question the plan review cannot: what does this
migration do to a real schema and real rows, and can it be rolled back. Not a new skill, not a new gate; the
`data` focus (plan versus diff, [REVIEW.md](REVIEW.md)) is separate and unchanged.

Report: `reviews/data-migration/REPORT.md` (+ `ledger.md`, same directory). Helpers: `scripts/migration-check.mjs`,
`scripts/validate-migration.mjs`.

## 1. Database safety (A50, A52) comes first

- The only database this check may apply a migration to is **one the project's own test infrastructure creates
  for the test run**: a test helper or fixture that makes a fresh temp database (in-memory or temp-file engine,
  or a container the test suite itself starts) and removes it afterwards. Cite its `path:line` as `harness:`.
- Never connect to any other database. No connection string is read from the environment, `.env`, config or
  docs, and none is written into the report. The runtime hook denies SQL clients, database files and
  migration/seed commands that are not the test suite's; obey it, do not work around it. A denied call is
  recorded as such, never retried differently.
- **Destructive statements are never executed** (drop, alter ... drop, truncate, delete, destructive
  `UPDATE`, a type change that is not a provable widening, NOT NULL without default), even on the throwaway
  database. The classifier decides ([MIGRATION.md](MIGRATION.md#1-classification)). Such a migration is
  `applied: no` with `not executed (destructive statement)`; its checks are static only.
- The agent never deploys and never runs a migration anywhere else. Rollback guidance stays in the data-design
  plan and the completion report.

## 2. Capability: throwaway database or UNSUPPORTED

Look for the project's own way to get a throwaway database: a test helper (`createTestDb`, `tempDatabase`,
a pytest/Jest/Go fixture), a test configuration that points tests at an in-memory or temp-file database, a
test-suite-managed container. Prove it with the project's own test command (a real trial run of an existing
test that uses it), not by reading names.

| finding | result |
|---|---|
| harness proven | `throwaway_db: yes`, apply and measure (section 3) |
| none found, found but its trial failed, or the hook denied the test command | `throwaway_db: no`, `reason:` names what is missing or quotes the denial; status **UNSUPPORTED** |

UNSUPPORTED is never PASS (shared rule 2: nothing is installed to obtain a capability). With
`throwaway_db: no` the static scan (`migration-check.mjs scan`) still runs and its findings are reported:
`traced` hazards are blocking and turn the status into FAIL, `judged` ones are `warn`. The completion report
lists the check under `## Unsupported Checks` (A78).

## 3. Method (with a throwaway database)

The runtime hook denies, in every environment, any command matching `database.migrate_commands` (migrate,
seed, schema, rollback, up/down commands of the common tools) and any SQL client or database file access
that is not the test suite's own. So the agent never issues a migrate, dump, seed or rollback command
itself. Applying, dumping and rolling back happen **only inside the project's own test command**, which
creates the throwaway database, runs the migration code and writes the snapshot and row files. The agent
runs that test command and reads the files it wrote.

1. **Plan the order.** Changed migrations in file-name order. Run the scan first (`migration-check.mjs scan`):
   statements it lists under `not_executable` are never applied, by the agent or by a test it writes.
2. **Find the project's test that does the work.** An existing test (or test mode) that creates the temp
   database, applies the pending migrations, and can export the schema and the seed rows. If no existing
   test applies the pending migration and exposes before/after snapshots, there is no usable capability:
   `throwaway_db: no`, status UNSUPPORTED (the agent does not write a new harness, install one, or call a
   migrate command to get one).
3. **Run that test command** with its own timeout; record the command, exit status and elapsed time. A
   failing apply is the finding (measured), with the engine's error line. A hook denial of that command is
   not worked around: it is the reason for `throwaway_db: no` / UNSUPPORTED, recorded verbatim.
4. **Collect** `before.sql`, `after.sql`, `seed-before.json`, `seed-after.json` (and `after-rollback.sql`)
   from the files the test wrote.
5. **Rollback.** Only when a down migration exists and the project's own test runs it. A down migration
   containing destructive statements (`DROP COLUMN`, `DROP TABLE`, `TRUNCATE`, `DELETE` ...) is never
   executed by the agent (hard rule 3): the rollback check is `unsupported` with "not executed (destructive
   statement)" unless the project's own test runs it (name it as `down_run_by: path[:line]`). Without a down
   file the rollback is a new forward migration: `down_migration: no`, check result `na` with that reason.
6. **Compare.**
   - `migration-check.mjs diff before.sql after.sql [--rollback after-rollback.sql]`: tables, columns (type,
     NOT NULL, default), indexes, constraints and other objects added, removed or changed; `rollback.restores_schema`
     must be true for the rollback check to pass; the same output carries the mixed-version lists.
   - `migration-check.mjs data seed-before.json seed-after.json [--key table=column]`: row counts, rows
     missing, values changed, columns dropped, columns renamed (values moved unchanged to a new name).
7. **Write the report** ([section 5](#5-report)) and run `scripts/validate-migration.mjs REPORT.md --repo .`
   (`--repo` re-classifies every cited migration: V16 a drop or unknown action marked `destructive: no` or a
   `patterns: pass` over a traced blocking hazard, V17 a file the scanner cannot analyze marked applied or a
   cited file that is missing). Non-SQL migrations (python, JavaScript, TypeScript, Ruby, Go, XML) are token
   scanned; a file with run-time built SQL or no recognised operation is listed under `unanalyzed` and is never
   applied.

## 4. What is reported and how it is classified

| check id | what | class |
|---|---|---|
| `schema_diff` | the snapshot diff is exactly what the plan's `## Data` steps declare; nothing extra | measured |
| `rollback` | down migration applied, snapshot equals the pre-migration one | measured |
| `data_preservation` | seed rows: counts equal, no row missing, no value changed, no column lost (a rename is not a loss) | measured |
| `lock_risk` | statements that block reads or writes for their duration (table rewrite, non-concurrent index build, constraint validation, `SET NOT NULL` scan) | judged; measured only with a measured duration in evidence |
| `long_running` | statements whose run time grows with table size (full-table `UPDATE`, rewrite, unbatched backfill) | judged; measured only with a measured duration |
| `patterns` | problematic DDL patterns from the scan (below) | traced when a statement and its context prove it, else judged |
| `mixed_version` | old app + new schema and new app + old schema (rollout order, and after rollback) | judged, traced where a reader was found |

Scan hazards (`migration-check.mjs scan`, codes stable):

| code | hazard | traced when | otherwise |
|---|---|---|---|
| H01 | NOT NULL without default on an existing table (`ADD COLUMN ... NOT NULL`, `SET NOT NULL`) | the table is declared populated (`--populated`, from seed files or the harness) | judged: population unknown |
| H02 | type narrowing (`varchar(100)` -> `varchar(10)`, `bigint` -> `integer`) | both types known from context and the new one holds fewer values | judged: type change not provably a widening |
| H03 | full-table rewrite (`ALTER COLUMN TYPE`) | never (engine and size dependent) | judged |
| H04 | index created on an existing table without the concurrent/online option | never | judged |
| H05 | drop or rename of a column or table while the running app still reads it | a reader found in the given paths (`path:line`) | judged: no reader found; consumers outside the repository are unknown |
| H06 | full-table or unbatched backfill `UPDATE` | never | judged |
| H07 | constraint added without `NOT VALID` (postgres) | never | judged |

An expand/contract rename (new column added, bounded NULL-only backfill, old column kept) is none of these:
the old column still exists, so old readers keep working. The same rename done in place (`RENAME COLUMN`) with
a reader found is H05, traced.

**Mixed-version compatibility** (from the measured diff):

- old app + new schema: removed or renamed tables and columns, a NOT NULL column without default (old inserts
  fail), type or NOT NULL tightening, new unique indexes;
- new app + old schema (rollout runs the app before the migration, or after a rollback): every added table,
  column and index is missing.

The lists are inferences about code that is not observed; they are `judged` unless a scan reader hit
(`path:line`) ties an object to the running app.

## 5. Report

`reviews/data-migration/REPORT.md`:

```markdown
# Migration validation: <TASK-ID>

status: PASS | FAIL | UNSUPPORTED | BLOCKED
blocked_reason: <only with BLOCKED>

## Capability
throwaway_db: yes | no
harness: <path[:line] of the test helper, then the trial command and its exit status>   (yes)
reason: <what the project lacks>                                                        (no)
engine: <engine and evidence>
down_migration: yes | no
down_destructive: yes | no                 (optional, default no: the down file holds destructive statements)
down_run_by: <path[:line] of the project's own test that runs it>   (optional)

## Migrations
| file | applied | destructive | note |
|---|---|---|---|
| migrations/003_x.sql | yes | no | applied in 0.4 s |
| migrations/004_y.sql | no | yes | not executed (destructive statement) |

## Checks
| id | check | class | result | evidence |
|---|---|---|---|---|
| schema_diff | ... | measured | pass | `migration-check.mjs diff` output ... |
... one row per id: schema_diff rollback data_preservation lock_risk long_running patterns mixed_version
```

Result values: `pass`, `fail`, `warn`, `na`, `unsupported`.

Gate rule (checked by `validate-migration.mjs`, exit 0 `OK` / 1 `FAIL <code>` / 2 usage):

- any `fail` -> FAIL; no throwaway database, any `unsupported` check, `schema_diff` or `data_preservation`
  not `pass`, a `rollback` that is not a `pass` while `down_migration: yes`, or any migration not applied ->
  UNSUPPORTED; otherwise PASS. The `status:` line must equal this derivation (V14).
- A `fail` is `measured`, `reproduced` or `traced`. A `judged` finding is `warn`; it fails only when its
  evidence cites the written spec or plan criterion it violates (`criterion: <text>`, V08).
- `schema_diff`, `rollback`, `data_preservation` results `pass`/`fail` need a throwaway database and class
  `measured` or `reproduced` (V05, V09); without one they are `unsupported`.
- `lock_risk` and `long_running` are `measured` only with a measured duration in the evidence (V09).
- `rollback` is `na` only with `down_migration: no`; `pass` only with `down_migration: yes` (V11); a down
  migration with destructive statements is `unsupported` ("not executed (destructive statement)") unless
  `down_run_by` names the project's own test that runs it (V15).
- `na` and `unsupported` always carry the reason as evidence (V12); `harness:` starts with a path[:line] (V03);
  `criterion:` needs text (V08).
- A destructive migration is never `applied: yes` (V10); no connection string, URL scheme or DSN fragment
  (`password=`, `host=`) anywhere (V13).

Submit: `--focus migration`, `--artifact reviews/data-migration/REPORT.md`; result PASS or FAIL from the
gate rule, `--result UNSUPPORTED --reason "<what the project lacks>"` when status is UNSUPPORTED (a FAIL
from traced static findings is reported as FAIL with its findings). `CONFIDENCE: high` only when every
non-destructive migration was applied and compared; `medium` when some were static only.

## 6. Limits (write them into the report)

- Throwaway-database behaviour is the test engine's: lock durations, planner choices and engine-specific
  rewrites on a production engine and production-size tables are not measured.
- Row preservation covers seeded rows only; production data shapes the seeds do not model are unknown.
- Reader detection is a word-boundary text match in the paths given; other services and repositories that read
  the schema are unknown.
- A snapshot comparison sees what the dump contains (the dump tool decides: functions, triggers, privileges).
- The validator checks the report's shape and consistency, not the world: it cannot prove that the harness
  trial ran, that the snapshots came from the throwaway database, or that the cited evidence is true. The
  reviewer's ledger (commands and output) is the proof; a report without it is judged `CONFIDENCE: low`.
