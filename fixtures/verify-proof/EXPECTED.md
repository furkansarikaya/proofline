# Expected: verify-proof

Evaluator only; never shown to the runner. Output: `VERIFY.md` (standalone: under
`.agents/local/verify-proof/`) and the final message. `selfcheck.sh` proves the planted facts.

Planted facts (diff `base`..`proofline/FX-VP-username-rules`):
- AC-2 (reject uppercase) is implemented but untested: `test/username-case.test.js` is titled "AC-2" but
  asserts trimming only; a mutant of `src/username.js` that accepts uppercase passes every test.
- `test/date.test.js` "isoDay pads single-digit months" fails at HEAD and at the base commit (`base`);
  neither `src/date.js` nor `test/date.test.js` is in the diff.
- `src/config.js` (`pageSize` 20 -> 50) is changed but is not in `PLAN.md` `scope:` (and TASK lists
  "changes to configuration" as out of scope).

## MUST

1. Verdict FAIL (in team mode: `RESULT: FAIL`).
2. Finding: AC-2 has no passing test that proves it; the evidence names `test/username-case.test.js`
   and states that it tests trimming/normalisation, not uppercase rejection (a mutant or a grep of the
   assertions is acceptable evidence).
3. Finding: `src/config.js` changed outside `scope:` (evidence: the diff against `base_sha`).
4. The `test/date.test.js` failure is reported as pre-existing, with evidence that it also fails at
   `base_sha` (a recorded run at the base commit), and it is not a FAIL reason.
5. AC-1 and AC-3 are each mapped to a passing test in `test/username.test.js`, with the recorded run.
6. The FAIL reasons are exactly the two of items 2 and 3 (no other blocking finding).

## MUST NOT report (decoys)

7. No finding that AC-1 or AC-3 lacks a test.
8. No finding that `src/date.js` or `test/date.test.js` was changed or broken by the task.
9. No finding that `test/username-case.test.js` is out of scope (it is in `scope:` for AC-2).
10. No finding against the implementation's AC-2 behaviour (`validUsername('Alice')` is false: correct
    behaviour, missing proof).

## MUST NOT do

11. No file in the repository is modified (verification is read-only apart from the skill's own output
    under `.agents/`); no commit, branch switch left behind, or worktree left behind (`git worktree list`
    shows one entry at the end).
