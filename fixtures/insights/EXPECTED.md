# insights fixture: known answers

`sh setup.sh DIR` plants metrics and three runs (RUN-A, RUN-B, RUN-C); `selfcheck.sh DIR` runs
`proofline insights` against it and checks these answers. Nothing here is fitted to the output.

## Cost (from records.jsonl)

Claude-style records plant in, out and total = in + out; the Codex-style record (RUN-B implementer) plants only
`tokens_total` 4000 with in and out null. A column sums recorded values only: `(k/n)` = k of n dispatches reported.

| Scope | Dispatches | Duration | tokens in | tokens out | tokens total | Retries |
|---|---|---|---|---|---|---|
| RUN-A | 3 | run record: 900s | 6000 (2/3) | 1000 (2/3) | 7000 (2/3) | 1 |
| RUN-B | 3 | run record: 500s | 2000 (1/3) | 300 (1/3) | 6300 (2/3) | 0 |
| RUN-C | 1 | n/a | n/a | n/a | n/a | 0 |
| reviewer / sonnet | 3 | 300s | 3000 (2/3) | 500 (2/3) | 3500 (2/3) | 1 |
| implementer / gpt-5 | 2 | 350s | 5000 (1/2) | 800 (1/2) | 9800 | 0 |
| all dispatches | 7 | 750s | 8000 (3/7) | 1300 (3/7) | 13300 (4/7) | 1 |
| finished runs | 2 | 1400s | delegations 6 | fix rounds 1 | | |

Traps: null-token dispatches are never summed as zero; a record with schema `proofline.metrics/9` is skipped
(999999 appears nowhere); a second `run` record for RUN-B (777777 s, 9 delegations) is ignored, the first counts;
a blank line is silent and a non-JSON line is reported as non-JSON, not as an unknown schema.

## Recurring failures

- repeated-finding x3 (RUN-A, RUN-B): REVIEW_RULES `src/a.go` "Error from Close is ignored" (line numbers differ, same finding).
- Trap: "Error from Open is ignored" is a different finding; it occurs once and is not merged into the one above.
- Trap: an `info` finding repeated twice is not a pattern; an unbound gate record (`RUN-B/gates/009-QA.yaml`)
  repeating the finding is not counted (x3, not x4).
- gate-fail REVIEW_RULES x3 (RUN-A, RUN-B); SECURITY failed once: no pattern.
- scope x2 (RUN-A, RUN-B): findings that name a scope violation.
- unsupported x2 (RUN-A, RUN-B): "no benchmark tool in the project"; the RUN-C line occurs once: no pattern.
- approval plan x2 (RUN-A): asked 3 times, granted once. RUN-B's destructive approval was granted: no pattern.
