# Expected: qa-plan

Evaluator only; never shown to the runner. Outputs: `QA_PLAN.md` and `QA_REPORT.md` (standalone: under
`.agents/local/qa-plan/`). `selfcheck.sh` proves the planted facts.

Planted facts: `src/shipping.js:shippingCents` uses `> FREE_SHIPPING_CENTS` (exclusive), so a subtotal of
exactly 5000 cents is charged 499 although AC-1 says "50.00 or more" is free; its empty-cart guard is
`if (!cart)`, which never fires for `[]`, so an empty cart returns 499 instead of throwing
`cart is empty` (AC-3). The committed tests cover only 60000 and 450 cents and pass.

## QA_PLAN.md MUST contain

1. At least one acceptance scenario per criterion AC-1, AC-2, AC-3, each tagged with its AC id.
2. A boundary scenario at exactly 5000 cents expecting `0`, and a just-below scenario (4999) expecting
   `499`.
3. An empty-input scenario: `shippingCents([])` expecting an `Error` with message `cart is empty`.
4. Each scenario has concrete input and expected output (not prose like "test edge cases").

## QA_REPORT.md MUST

5. Verdict FAIL (in team mode: `RESULT: FAIL`).
6. A finding for AC-1 at the boundary, reproduced: concrete input with subtotal exactly 5000 (e.g.
   `[{qty:1,unitCents:5000}]` or `[{qty:2,unitCents:2500}]`), expected `0`, actual `499`, with the command
   or test that produced it, citing `src/shipping.js:shippingCents`.
7. A finding for AC-3, reproduced: `shippingCents([])` returns `499` (no error thrown), with the command or
   test that produced it.
8. Each finding names its acceptance criterion (AC-1, AC-3).

## MUST NOT report (decoys)

9. No finding about floating-point rounding (amounts are integer cents; e.g. 3 x 1667 = 5001 -> 0 is
   correct).
10. No finding for just-below (4999 -> 499), just-above (5001 -> 0), or multi-line sums away from the
    boundary; these behave correctly.
11. A non-array input (e.g. `null`) throwing `TypeError` is not a FAIL finding (the task does not specify
    non-array input); at most a listed suspicion/question that does not affect the verdict.
12. No finding against AC-2 (flat 499 below the threshold is correct).

## MUST NOT do

13. `src/` is not modified (QA reports; it does not fix). No commit created.
