# Review mode (gate REVIEW_DATA)

Dispatched as `reviewer` with `FOCUS: data` on a run whose PLAN.md has a `## Data` section. Read-only: no
project code runs, so no worktree is needed. Writes only `reviews/data-design/REVIEW.md` in the run.

## 1. Inputs

1. The frozen `PLAN.md` of the run (never `design/DATA.md`, which may have changed after the freeze).
2. `migrations:` from `design/DATA.md` `## Engine` (or, standalone, the user's answer).
3. The task diff (`base_sha` -> working tree incl. untracked, excluding `.agents/runs/` and `.agents/local/`),
   NUL-delimited: `git diff -z --name-only <base>` plus `git ls-files -z --others --exclude-standard`.
4. Changed migration files = changed paths under `migrations:`, plus every changed `*.sql` anywhere, plus every
   changed file the classifier's token scan would flag (ORM migration directories). Deleted migration files are
   a finding of their own (`a migration that may already be applied was deleted`), not input.
5. Context files = migration files under `migrations:` that the change did not touch (prior column types).

## 2. Gate rule

Run:

```
node <skill-dir>/scripts/validate-data.mjs <run>/PLAN.md --migrations <changed...> --context <unchanged...>
```

| exit | result |
|---|---|
| 0 (`OK`) | PASS |
| 1 | FAIL: one finding per `FAIL <code>: ...` line |
| 2 | BLOCKED (usage or unreadable file); BLOCKED_REASON quotes stderr |

What the codes mean (the plan table rules apply to the frozen plan, the `M` rules to the diff):

| code | rule |
|---|---|
| D02-D09 | the frozen `## Data` is malformed: header line, table columns, values, empty rollback or lock, an always-destructive operation not marked destructive, a destructive step marked reversible, header/rows mismatch, phase order |
| M1 | a statement in the diff that no non-deferred plan step declares (undeclared change) |
| M2 | a destructive or unknown statement declared by a step marked `destructive: no` (undeclared destructive statement) |
| M3 | a planned statement step missing from the diff (plan/diff mismatch) |
| M4 | a `deferred` step already in the diff |
| M5 | the diff is destructive while the plan says `destructive: no` |

Missing rollback for a reversible step is D05 on the frozen plan.

No judgement overrides the exit code. A finding can be disputed only by changing the plan (a new frozen plan
needs the lead's amendment and, for a destructive change, a new user approval) or the code.

## 3. Output

`reviews/data-design/REVIEW.md` (artifact and ledger in one; a restart re-reads it): the exact command, the classifier JSON (or its path), the validator output
verbatim, then one row per finding. Result header: `ROLE: reviewer`, `FOCUS: data`, `RESULT` per the table,
`CONFIDENCE: high` (all changed files `method: sql`) or `medium` (any `token-scan`), `ARTIFACT:
reviews/data-design/REVIEW.md <sha256>`. Findings table rows: `| REVIEW_DATA-<n> | blocking | <file:line> | <validator
message> (code <code>) | validate-data.mjs output |`.
