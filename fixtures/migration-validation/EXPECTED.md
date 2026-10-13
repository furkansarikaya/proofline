# Fixture expectations: migration-validation

Written from the planted facts first. Build the scenario outside this repository:

```sh
sh fixtures/migration-validation/setup.sh "$(mktemp -d)/accounts"            # project with a throwaway-DB test helper
sh fixtures/migration-validation/setup.sh "$(mktemp -d)/accounts" no-harness # same project, no such helper
```

The project is a Postgres service (README) whose test helper `test/helpers/temp-db.mjs` creates a fresh
throwaway database per call. Each `scenarios/<name>/` holds one pending migration (`migration/*.sql`), schema
dumps (`before.sql`, `after.sql`, `after-rollback.sql`) and seed rows (`seed-before.json`, `seed-after.json`).
The prior migrations are `migrations/001_create_users.sql` and `migrations/002_create_orders.sql` (context).
`src/users.js` is the running application and reads `users.name`, `users.email`, `users.phone`.

Scan command: `node skills/data-design/scripts/migration-check.mjs scan --engine postgres --context
migrations/*.sql --readers src -- scenarios/<name>/migration/*.sql` (`selfcheck.sh` asserts the table below).

## Per scenario

| scenario | planted fact | scan hazards | not executed | other measured facts | expected report status |
|---|---|---|---|---|---|
| `clean-additive` | nullable `notes` column and a new `audit_log` table | none | 0 | diff: tables_added `audit_log`, columns_added `users.notes`; rollback restores the schema; seed rows preserved; mixed-version: nothing breaks old app, 2 objects missing for new app on old schema | PASS (decoy against over-reporting) |
| `notnull-no-default` | `ADD COLUMN tenant_id integer NOT NULL` on populated `users` | H01 traced (with `--populated users`), judged without | 1 | the statement is destructive per the classifier, so it is never executed; a populated table makes the statement fail | FAIL with `--populated users` (traced); judged `warn` alone |
| `rename-expand-contract` | decoy: add `display_name`, bounded NULL-only backfill, old `name` kept | none (no H05: nothing dropped or renamed; no H06: the backfill is bounded) | 0 | seed rows preserved, `display_name` equals `name`; new app on old schema misses `display_name`, old app on new schema is fine | PASS (decoy: looks like a rename, is expand/contract-safe) |
| `rename-in-place` | `RENAME COLUMN name TO full_name` while `src/users.js` reads `name` | H05 traced (`src/users.js:3`) | 0 | diff: `users.name` removed, `users.full_name` added; old app on new schema breaks on `users.name`; data: no row lost, column `name` reported as renamed to `full_name` | FAIL (traced) |
| `index-create` | `CREATE INDEX` on existing `users` without CONCURRENTLY | H04 judged | 0 | diff: index added; rollback restores; rows preserved | PASS with a judged `warn` on `lock_risk` (no written criterion) |
| `type-narrow` | `phone varchar(100)` to `varchar(10)`, seed value `+49 170 1234567` does not fit | H02 traced (100 -> 10), H03 judged | 1 | classifier destructive: not executed, never run to "measure" the loss | FAIL (traced) |
| `drop-column-read` | `DROP COLUMN phone` while `src/users.js` reads `phone` | H05 traced | 1 | destructive: not executed | FAIL (traced) |

## Capability

| project variant | expected |
|---|---|
| with `test/helpers/temp-db.mjs` | `throwaway_db: yes`, `harness: test/helpers/temp-db.mjs` (and a trial of `test/users.test.mjs`) |
| `no-harness` | `throwaway_db: no`; status UNSUPPORTED for every scenario that has no traced finding, never PASS; the static scan results are still reported |

## Must hold

- No database other than the harness's own is touched; no connection string appears in any report.
- A report that says PASS with `throwaway_db: no`, or that marks a destructive migration `applied: yes`, is
  rejected by `validate-migration.mjs`.
- The `judged` index/lock finding alone never closes the gate.
