# Review: <TASK-ID> (<GATE>)

Owner: reviewer (FOCUS plan | rules | tests | data | rules+tests). Written at the skill's report path
(`reviews/proof-review/`, `reviews/test-trust/`, `reviews/data-design/`) and named as the result's ARTIFACT.
Judges the actual diff against TASK and the frozen PLAN; "tests passed" is not a review; never repairs code.
The compatibility `agent.sh gate` reads the Verdict line.

Verdict: PASS | FAIL

## Inspected

<paths and symbols>

## Findings

| id | severity | path:line | finding | evidence |
|---|---|---|---|---|
| REVIEW_RULES-1 | blocking | src/a.ts:12 | <finding> | <reproduced or traced> |
