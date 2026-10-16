# Data design: <TASK-ID> — <title>

<!-- Every "## " heading below is required (validate-data.mjs). Replace <...>; delete these comments. -->

## Plan section

<!-- This section's text is copied VERBATIM into PLAN.md "## Data". First line is mandatory. -->
destructive: <yes|no>
<one sentence: what changes in the data and why>

| step | phase | operation | object | destructive | reversible | rollback | lock |
|---|---|---|---|---|---|---|---|
| S1 | expand | <operation> | <table or table.column> | <yes\|no> | <yes\|no> | <how this step is undone, or how data is recovered> | <lock taken, scope, expected duration> |

<!--
phase:      expand < backfill < switch < contract < deferred (non-decreasing down the table)
operation:  a classify-migration.mjs kind (add_column, drop_column, create_index, update, ...) or a process
            step: backup, backfill, dual_write, switch_reads, deploy, verify
object:     lower-case table, or table.column (required for statement kinds)
deferred:   a step that a later task performs; it must not appear in this change's diff
-->

## Engine

engine: <postgres|mysql|sqlite|sqlserver|mongo|other>
version: <version, or "unknown">
evidence: <path:line that proves the engine>
migrations: <directory or glob the project applies, e.g. migrations/>
tool: <how migrations are applied (path:line), or "unknown">

## Model

```mermaid
erDiagram
  <ENTITY> {
    <type> <column> PK
  }
```

## Invariants

- INV-1: <a rule the data must always satisfy> (enforced by: <constraint name | path:symbol | none: why>)

## Draft statements

<!-- The planned statements, in step order, in the engine's dialect (```sql) or the project's migration
     language. validate-data.mjs classifies them and checks them against the table. Deferred steps are
     not drafted here. -->

```sql
-- S1
<statement>;
```

## Backfill

<!-- "none" when there is no backfill step. Otherwise all three lines are required. -->
batch_size: <rows per batch, and why>
idempotency: <why re-running a batch changes nothing, e.g. WHERE new_col IS NULL>
resume: <how an interrupted backfill continues, e.g. from the highest processed id>

## Rollback

<per release: what to deploy/run to go back, and the last point after which going back loses data>

## Data loss

<!-- One line per destructive step (by step id), or "none". -->
- <S-id>: <what is lost, how much, recovery source>

## Proposed DATA_MODEL.md changes

<!-- For the knowledge step; this skill never writes docs/design/DATA_MODEL.md inside a run. -->
<entities/columns/invariants to add, change or remove in docs/design/DATA_MODEL.md, or "none">
