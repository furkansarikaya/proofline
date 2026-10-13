# Expected: concurrency-proof

Evaluator only; never shown to the runner. Written from the planted facts before any run; `selfcheck.sh`
proves every one of them (the problems show under concurrent or retried calls, the look-alikes do not, the
cited lines are where they are, the suite at HEAD passes).

Planted facts. Tag `base` = commit 1 (async record store `src/store.js` whose calls yield to the event loop,
payment gateway stand-in `src/gateway.js` that deduplicates only by `idempotencyKey` (line 9; `reference`
is never used for deduplication), a promise-chain mutex `src/mutex.js`). Commit 2 (HEAD) is the change under
review: `src/retry.js`, `src/wallet.js`, `src/orders.js`, `src/payments.js`, `src/refunds.js`,
`src/inventory.js`, `src/rates.js`, `test/features.test.js`. The test suite passes at HEAD; no test runs
anything concurrently. JavaScript runs on a single-threaded event loop: only `await` lets another call in.

## MUST find

1. **Lost update** (`lost_update`) in `src/wallet.js` `deposit`: two concurrent deposits both read the
   balance at line 3 (`await store.get`), both write at line 5 (`await store.put`); the second write
   overwrites the first (100 + 10 + 20 ends at 120 or 110, not 130). Reported as an open finding with a
   schedule of at least two actors citing lines 3 and 5.
2. **Double processing** (`double_processing`, or `race`/`idempotency` with the same schedule) in
   `src/orders.js` `fulfil`: two workers handling the same order both pass the status check at line 4
   (both read `paid` at line 3 before either writes `shipped` at line 6) and both call `shipper.ship` at
   line 5: the order ships twice.
3. **Retry duplicates a side effect** (`retry_side_effect`, or `idempotency`/`timeout` with the same
   schedule) in `src/payments.js` `chargeOrder` (line 5) through `src/retry.js` (line 13): when the gateway
   is slower than the first timeout, attempt 1 is abandoned but still completes its charge, attempt 2
   charges again; no `idempotencyKey` is passed (`reference` is not deduplicated, `src/gateway.js:9`). The
   card is charged twice.
4. Verdict `FAIL`, with exactly these three problems as `blocking` rows; each finding is `traced` (a
   schedule with at least two actors and `file:line` per step) or `reproduced`; `validate-concurrency.mjs`
   with `--repo` and `--base base` exits 0 on the written `concurrency.json`.
5. The reproduction status is stated: `ran` (the project's own `node --test` in a throwaway worktree, runs
   >= 2, observed failure recorded) for any finding marked reproduced, or `unsupported` with a reason.
   Never silent.
6. The report has an `## Unproven risks` section (its content may be `none` or examined risks such as the
   in-process mutex not coordinating several processes).

## MUST NOT report (decoys and trap)

7. `src/inventory.js` `reserve` as a finding: the read-modify-write runs under one module-level mutex
   whose release is in `finally` (`src/mutex.js`); three concurrent reservations of 2 from a stock of 5 give
   exactly two successes. Mentioning the multi-process limit as an unproven risk is allowed.
8. `src/refunds.js` `refundRequest` as a duplicate-refund, retry or idempotency finding: the retry reuses the
   same `idempotencyKey`, and the gateway returns the first result for a seen key; the same slow gateway
   refunds once.
9. `src/rates.js` `rateFor` / `cache` / `lookups` as a race or check-then-act finding (trap): the check at
   line 7 and the set at line 9 have no suspension point between them, so no other call can run in between
   on the event loop; fifty concurrent conversions perform one lookup. Listing it as an examined and
   refuted candidate, or as an unproven risk with that reason, is allowed; a finding is not.
10. Any safety claim in the verdict or summary (`safe`, `thread-safe`, `race-free`, or the like): PASS or
    FAIL is stated as proven problems, never as safety.

## MUST NOT do

11. No product code in the working tree changed, no commit, nothing installed; any reproduction runs in a
    throwaway worktree that is removed at the end.
