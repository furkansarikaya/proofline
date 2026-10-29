# Consolidating Explorer results into EVIDENCE.md (lead)

The lead runs this after every Explorer of the run returned `DONE`. Input: the claims tables from the result headers' artifacts (never re-reading the repository beyond running the verifier). Every path or symbol TASK.md names (references, context, out-of-scope notes) becomes a claim or an explicit `not found` row, so a reference the task states cannot silently drop out. Output: `EVIDENCE.md` in the run folder ([template](../assets/EVIDENCE.template.md)).

## Format

```
# Evidence: <TASK-ID>

## Repository
- Base SHA: <RUN.yaml repository.base_sha>
- Explorer results: reports/001-explorer.md <sha256>, reports/002-explorer.md <sha256>

## Claims
| id | severity | path:line | finding | evidence |
|---|---|---|---|---|
| E-1 | info | `src/pricing/discount.js:applyDiscount` | code: percentage discount used at checkout | 001 explorer-1 |

## Not found
- dependency: none — 001: package.json has no dependencies

## Open questions
- none

## Derived constraints
- C-1: Amounts stay integer cents (E-4, E-5)

## Assumptions
| id | assumption | source | risk | verification | status | decisions |
|---|---|---|---|---|---|---|
| AS-1 | The shipping threshold is read from config, never hard-coded elsewhere | 001 explorer-2 | low | grep -rn "THRESHOLD" src/ finds one definition (E-3) | verified | AC-2, C-1 |
| AS-2 | Orders created before this change keep the old rounding | TASK.md Context | high | none yet: needs a data owner's answer | unverified | AC-3 |
```

## Rules

1. **Renumber** claims (`explorer-<n>` in the results) `E-1..E-n`; severity is kept (`blocking` only on `risk` and `conflict` rows) in category order (`code`, `test`, `pattern`, `dependency`, `constraint`, `affected`, `risk`, `conflict`); the evidence column cites the source as `<result number> <source id>` (`001 explorer-3`), several sources comma-separated.
2. **Deduplicate** rows with the same category and claim; keep every source.
3. **Contradictions** (one Explorer has a symbol as `code`, another as `conflict`) are not resolved by the lead's judgement: drop both rows, write the contradiction under `## Open questions`, and dispatch one more Explorer with that question as its objective (within the class's explorer bound), or return it to the user as NEEDS_INPUT when the bound is reached.
4. **Not found** keeps a category's `none` line only when no Explorer has a row for it; otherwise drop the line.
5. **Derived constraints** are the rules PLAN must respect, each citing claim ids (`C-<n>: <rule> (E-<n>[, E-<n>])`). Nothing that no claim supports. A valid decision from an ADR or a wiki page goes here with its source (the claim row names the page: `C-<n>: <rule> (E-<n>)`, where E-<n> is the `constraint` row at that page); a pattern to follow stays a `pattern` row under Claims. No new section for either (A202).
6. **Verify** with `node <skill-dir>/scripts/verify-claims.mjs <run>/EVIDENCE.md --repo <repo>` before freeze; exit 0 is required. A claim that fails (the code changed since exploration) is dropped and its Explorer's question re-dispatched.
7. **Assumptions** (`## Assumptions`, mandatory, A79): every fact the plan will have to take as true that no verified claim supports (an Explorer's open question, an unmeasured behavior, a statement from the task or the user that the repository could not confirm) is one row: id `AS-<n>`, text, source (result number and id, TASK.md, user), risk `low|medium|high` (what breaks if it is wrong: `high` = data loss, security, a public contract or most of the change), verification (the check that was run, citing a claim id or command, or the one that could be run), status `verified|unverified`, and the decisions it affects. `verified` needs a named check; `high` needs a method in both statuses. No assumptions: the section is the single line `none`. An unverified `high` row stops the freeze until the user answers it; it is never accepted by the lead and never written as `accepted-by-user` here (the run records the user's answer). The same assumption keeps its id when PLAN.md repeats it.
8. No prose summaries, no pasted code, no wiki copies: EVIDENCE.md is a table plus short lists.
