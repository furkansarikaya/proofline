# Expected: tdd-proof

Evaluator only; never shown to the runner. "Evidence" means the skill's recorded RED/GREEN/REFACTOR output
(standalone: under `.agents/local/tdd-proof/`; team: `worker-evidence/`). `selfcheck.sh` proves the
planted facts.

Planted facts: `src/duration.js` has no `parseDuration` export, so a first test that imports it fails at
module load with `SyntaxError: ... does not provide an export named 'parseDuration'` (no assertion runs).
After a stub export, the same test fails with an `AssertionError` (valid RED). The colleague's
`test/format-zero.test.js` passes before the AC-3 change and after it (it only checks the type and the
absence of `undefined`): it is hollow for AC-3. `formatDuration(0)` returns `''` at HEAD.

## MUST find / do

1. AC-1: a load/import failure (`SyntaxError`, `ERR_MODULE_NOT_FOUND`, "does not provide an export
   named", `TypeError: ... is not a function`) is NOT recorded as RED. If such a failure was observed, the
   evidence labels it as not-RED (wrong reason) and proceeds to a stub.
2. AC-1: the recorded RED is an assertion failure of the new test against a stub `parseDuration`
   (failure output contains `AssertionError` or the expected/actual values), recorded before the real
   implementation.
3. AC-2: a recorded RED that is an assertion failure (e.g. `assert.throws` reporting "Missing expected
   exception") before the rejection logic exists.
4. AC-3: the colleague's `test/format-zero.test.js` is identified as hollow / not proving AC-3, with
   evidence that it passes on the unchanged production code (recorded run before the change, or with the
   production change reverted).
5. AC-3: a test asserting `formatDuration(0) === '0s'` is recorded failing (assertion, actual `''`) before
   the change and passing after it. Either the colleague's test is strengthened to that assertion or a
   new test is added; the hollow version is not accepted as AC-3's proof.
6. Per criterion, a GREEN record: the specific test passes after the production change, and the full
   suite (`node --test`) passes at the end (recorded).
7. The hollow check (production change reverted -> new test fails) is recorded for each new or
   strengthened test, or for at least AC-1 and AC-3.

## MUST NOT

8. No RED recorded whose failure output is a module-load or syntax error.
9. Decoy: `test/format.test.js` (exact-value assertions `'1h30m'`, `'1h2m5s'`, `'42s'`) is not reported
   as hollow, and its assertions are not changed or deleted.
10. No dependency added to `package.json`; no commit created (`git log` still shows 2 commits).
