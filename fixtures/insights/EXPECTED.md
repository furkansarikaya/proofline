# insights fixture: known answers

`sh setup.sh DIR` plants metrics and three runs (RUN-A, RUN-B, RUN-C); `selfcheck.sh DIR` runs
`proofline insights` against it and checks these answers. Nothing here is fitted to the output.

## Cost (from records.jsonl)

| Scope | Dispatches | Duration | tokens in | tokens out | Retries |
|---|---|---|---|---|---|
| RUN-A | 3 | run record: 900s | 6000 (2/3) | 1000 (2/3) | 1 |
| RUN-B | 2 | run record: 500s | 2000 (1/2) | 300 (1/2) | 0 |
| RUN-C | 1 | n/a | n/a | n/a | 0 |
| reviewer / sonnet | 3 | 300s | 3000 (2/3) | 500 (2/3) | 1 |
| all dispatches | 6 | 700s | 8000 (3/6) | 1300 (3/6) | 1 |
| finished runs | 2 | 1400s | delegations 6 | fix rounds 1 | |

Trap: the null-token dispatches are never summed as zero (the `(k/n)` annotation, and `n/a` for RUN-C);
a record with schema `proofline.metrics/9` is skipped (its 999999 seconds appear nowhere).

## Recurring failures

- repeated-finding x3 (RUN-A, RUN-B): REVIEW_RULES `src/a.go` "Error from Close is ignored" (line numbers differ, same finding).
- Trap: "Error from Open is ignored" is a different finding; it occurs once and is not merged into the one above.
- Trap: an `info` finding repeated twice is not a pattern; an unbound gate record (`RUN-B/gates/009-QA.yaml`)
  repeating the finding is not counted (x3, not x4).
- gate-fail REVIEW_RULES x3 (RUN-A, RUN-B); SECURITY failed once: no pattern.
- scope x2 (RUN-A, RUN-B): findings that name a scope violation.
- unsupported x2 (RUN-A, RUN-B): "no benchmark tool in the project"; the RUN-C line occurs once: no pattern.
- approval plan x2 (RUN-A): asked 3 times, granted once. RUN-B's destructive approval was granted: no pattern.
