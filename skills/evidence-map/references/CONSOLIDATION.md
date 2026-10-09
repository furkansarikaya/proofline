# Consolidating Explorer results into EVIDENCE.md (lead)

The lead runs this after every Explorer of the run returned `DONE`. Input: the claims tables from the result headers' artifacts (never re-reading the repository beyond running the verifier). Output: `EVIDENCE.md` in the run folder ([template](../assets/EVIDENCE.template.md)).

## Format

```
# Evidence: <TASK-ID>

## Repository
- Base SHA: <RUN.yaml repository.base_sha>
- Explorer results: results/001-explorer.md <sha256>, results/002-explorer.md <sha256>

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
```

## Rules

1. **Renumber** claims (`explorer-<n>` in the results) `E-1..E-n`; severity is kept (`blocking` only on `risk` and `conflict` rows) in category order (`code`, `test`, `pattern`, `dependency`, `constraint`, `affected`, `risk`, `conflict`); the evidence column cites the source as `<result number> <source id>` (`001 explorer-3`), several sources comma-separated.
2. **Deduplicate** rows with the same category and claim; keep every source.
3. **Contradictions** (one Explorer has a symbol as `code`, another as `conflict`) are not resolved by the lead's judgement: drop both rows, write the contradiction under `## Open questions`, and dispatch one more Explorer with that question as its objective (within the class's explorer bound), or return it to the user as NEEDS_INPUT when the bound is reached.
4. **Not found** keeps a category's `none` line only when no Explorer has a row for it; otherwise drop the line.
5. **Derived constraints** are the rules PLAN must respect, each citing claim ids (`C-<n>: <rule> (E-<n>[, E-<n>])`). Nothing that no claim supports.
6. **Verify** with `node <skill-dir>/scripts/verify-claims.mjs <run>/EVIDENCE.md --repo <repo>` before freeze; exit 0 is required. A claim that fails (the code changed since exploration) is dropped and its Explorer's question re-dispatched.
7. No prose summaries, no pasted code, no wiki copies: EVIDENCE.md is a table plus short lists.
