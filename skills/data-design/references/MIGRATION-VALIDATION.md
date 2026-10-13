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
| none found, or found but its trial failed | `throwaway_db: no`, `reason:` names what is missing; status **UNSUPPORTED** |

UNSUPPORTED is never PASS (shared rule 2: nothing is installed to obtain a capability). With
`throwaway_db: no` the static scan (`migration-check.mjs scan`) still runs and its findings are reported:
`traced` hazards are blocking and turn the status into FAIL, `judged` ones are `warn`. The completion report
lists the check under `## Unsupported Checks` (A78).

## 3. Method (with a throwaway database)

1. **Plan the order.** Changed migrations in file-name order; the unchanged earlier ones are applied first by
   the project's own mechanism in the throwaway database. Run the scan first
   (`migration-check.mjs scan`): destructive statements are excluded from step 3.
2. **Seed.** Insert seed rows with the project's own seed/fixture data or a few rows the check writes through
   the harness; export rows per touched table to `seed-before.json` (`{ "tables": { "<t>": [ {row}, ... ] } }`).
3. **Snapshot before.** Dump the schema (the engine's own schema dump through the harness, or a JSON snapshot
   as described in the script header) to `before.sql`.
4. **Apply** the non-destructive migrations. Record the exact command, the exit status and the elapsed time.
   A failing apply is the finding (measured), with the engine's error line.
5. **Snapshot after, export rows after** (`after.sql`, `seed-after.json`).
6. **Roll back** when a down migration exists (`down_migration: yes`); snapshot again (`after-rollback.sql`).
   Without a down file the rollback is a new forward migration: `down_migration: no`, check result `na`.
7. **Compare.**
   - `migration-check.mjs diff before.sql after.sql [--rollback after-rollback.sql]`: tables, columns (type,
     NOT NULL, default), indexes, constraints and other objects added, removed or changed; `rollback.restores_schema`
     must be true for the rollback check to pass; the same output carries the mixed-version lists.
   - `migration-check.mjs data seed-before.json seed-after.json [--key table=column]`: row counts, rows
     missing, values changed, columns dropped, columns renamed (values moved unchanged to a new name).
8. **Write the report** ([section 5](#5-report)) and run `scripts/validate-migration.mjs REPORT.md`.

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
harness: <path:line of the test helper, and the trial command with its exit status>   (yes)
reason: <what the project lacks>                                                        (no)
engine: <engine and evidence>
down_migration: yes | no

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

- any `fail` -> FAIL; no throwaway database, any `unsupported` check, or any migration not applied ->
  UNSUPPORTED; otherwise PASS. The `status:` line must equal this derivation (V14).
- A `fail` is `measured`, `reproduced` or `traced`. A `judged` finding is `warn`; it fails only when its
  evidence cites the written spec or plan criterion it violates (`criterion: <text>`, V08).
- `schema_diff`, `rollback`, `data_preservation` results `pass`/`fail` need a throwaway database and class
  `measured` or `reproduced` (V05, V09); without one they are `unsupported`.
- `lock_risk` and `long_running` are `measured` only with a measured duration in the evidence (V09).
- `rollback` is `na` only with `down_migration: no`; `pass` only with `down_migration: yes` (V11).
- A destructive migration is never `applied: yes` (V10); no connection string anywhere (V13).

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
