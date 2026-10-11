# Migration plan

## 1. Classification

`scripts/classify-migration.mjs [--context <old files> --] <files>` reads text only. SQL files are lexed
(`--` and `/* */` comments, `'...'` / `E'...'` strings, `$tag$` bodies and quoted identifiers are never
matched as keywords) and split on `;` and SQL Server `GO` lines. Other files (ORM, document-store
migrations) get a token scan (`dropColumn`, `remove_column`, `RemoveField`, `deleteMany`, `$unset`, ...) plus
a SQL scan of their string literals. Each action gets a `kind`, an `object` and a `class`:

| class | kinds (and condition) |
|---|---|
| destructive | `drop_table`, `drop_schema`, `drop_column`, `drop_partition`, `truncate`, `delete` (with or without WHERE), `replace`, `merge` with UPDATE/DELETE, upserts; `update` unless every assigned column is restricted by `<col> IS NULL` in a WHERE without OR; `alter_column_type` unless a widening is provable from a prior definition (`varchar(n)`->`varchar(m>=n)`/`text`, smaller int -> larger int); `add_column ... NOT NULL` without DEFAULT/identity and `set_not_null` on a table not created in the same change |
| breaking | `rename_table`, `rename_column`, `drop_constraint`, `drop_index`, `drop_other` (views, functions, types...): no rows lost, readers or guarantees break |
| safe | `create_table`, `create_index`, `create_other`, `add_column` (nullable or with default), `add_constraint`, `drop_not_null`, `set_default`, `drop_default`, `insert`, NULL-only `update`, `alter_other` table options, `other` (transaction control, grants, comments) |
| unknown | anything not recognised (`DO` blocks, `CALL`/`EXEC`, `DELIMITER` scripts, unknown ALTER actions) |

`destructive: yes` when any action is `destructive` or `unknown`. Pass the files that define the touched
tables with `--context` so type changes can be proven widening; without them a type change is destructive.
A classification is never argued away: to make a step non-destructive, change the step.
A destructive plan separates the phases: the destructive step sits in phase `contract` or `deferred`, after a
non-destructive step in `expand`, `backfill` or `switch` that stops reading or writing the data first. One
step (drop and stop-reading in the same migration) is only allowed with the user's explicit single-step
approval, written as `single_step: yes` in `## Plan section`; plan-contract's validator and the freeze check it.

## 2. Expand and contract

Order the steps so that every deployed version of the code works against every schema state it can meet:

| phase | contains | rule |
|---|---|---|
| `expand` | new tables, nullable columns or columns with a default, new indexes, relaxed constraints (`drop_not_null` on a column the new code stops writing), application deploy that writes both shapes (`dual_write`) | nothing an old reader or writer depends on changes |
| `backfill` | filling new structures from old data | batched, idempotent, resumable (section 3) |
| `switch` | constraints that need backfilled data (added unvalidated, then validated), deploy that reads the new shape (`switch_reads`), `verify` (counts/invariant queries) | only after the backfill is complete and verified |
| `contract` | `backup` of what will be lost, then drops, renames, type narrowing, NOT NULL | only after no deployed code reads or writes the old shape |
| `deferred` | contract steps a later task performs | not drafted, never in this change's diff |

- A rename is `add new` + `dual_write` + `backfill` + `switch_reads` + `drop old`, not `RENAME`, unless the
  task proves a single deploy with downtime is acceptable (quote the acceptance criterion).
- When one change must ship all phases, each phase is its own migration file/release in that order; say which
  release each step belongs to in the step's rollback text.
- Process steps (`backup`, `backfill`, `dual_write`, `switch_reads`, `deploy`, `verify`) carry an object (the
  table) and are not matched against SQL.

## 3. Backfill

- **Batched:** walk the primary key in ranges (`WHERE id > :last ORDER BY id LIMIT :n`, or `id BETWEEN`),
  `batch_size` chosen so one batch holds row locks for well under a second; commit per batch; optional pause
  between batches for replication lag.
- **Idempotent:** the batch predicate excludes finished rows (`WHERE new_col IS NULL`), so a repeated batch
  changes nothing; the classifier then sees a NULL-only `update` (safe).
- **NULL-safe expression:** source columns that allow NULL are wrapped (`concat_ws`, `coalesce`, `CASE`); state
  the result for a NULL source in an invariant.
- **Resumable:** the resume point is the highest processed key, read back from the data itself
  (`max(id) WHERE new_col IS NOT NULL`) or a progress row; never only from process memory.
- **Concurrent writes:** rows written during the backfill are covered by `dual_write` deployed before it.
- **Verify:** a `verify` step counts rows still unfilled (`count(*) WHERE new_col IS NULL` = 0) before
  `switch`.
- Document-stores: same rules with `updateMany` filters on `{new_field: {$exists: false}}` and `_id` ranges.

## 4. Rollback and data loss

- Each step's `rollback` cell: the inverse statement for a reversible step (`DROP INDEX CONCURRENTLY ...` for
  `CREATE INDEX CONCURRENTLY ...`; `ALTER TABLE ... DROP COLUMN new_col` for an added column, valid only before
  anything depends on it); for an irreversible step, where the lost data comes back from (the `backup` step's
  snapshot, a retained column) and the restore procedure.
- `## Rollback` gives, per release, how to go back and the **point of no return** (the first step after which
  going back loses data written since).
- `## Data loss`, one line per destructive step id: what is lost (columns, rows, precision), approximate
  volume, whether the information survives elsewhere (e.g. merged into another column), and whether the
  transformation is reversible (merging two fields is often not: splitting `"Mary Ann Smith"` back is
  ambiguous).
- Migration tools without down files: the rollback is a new forward migration; say so.

## 5. The approval question

Destructive plan -> `RESULT: NEEDS_INPUT` (team) or the report's final question (standalone):

```
QUESTIONS:
1. The plan permanently removes data in steps <S-ids> (<one line each: what is lost>). Approve these destructive steps?
   options: (a) approve as planned (backup step <S-id> runs first); (b) defer <S-ids> to a follow-up task and ship
   only the expand/backfill/switch steps now; (c) cancel the data change
   recommended: <a or b: the option that satisfies every acceptance criterion with the least irreversible loss>
   why: destructive migrations make the task CRITICAL and need explicit user approval before IMPLEMENT.
```

Option (b) is offered only when deferring keeps the change correct; if an acceptance criterion requires the
removal, say that deferring needs a scope change.
