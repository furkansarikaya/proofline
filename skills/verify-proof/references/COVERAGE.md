# Acceptance criterion to test mapping

For each `AC-n` in `TASK.md`:

1. **Candidates.** The plan's test mapping (`PLAN.md` `## Tests`) names tests per criterion; use it first. Otherwise search the changed and added test files (diff against base) for the criterion's concrete values (status code, message text, field names, limits) and its entry point.
2. **References the behaviour.** Open the candidate and trace: the test sets up the criterion's situation, calls the code path the criterion describes, and asserts the observable outcome. Record `path:symbol` for the test and for the production function it reaches. A test that only imports the module, only checks that no exception occurs, asserts a constant, or mocks the unit under test does not reference the behaviour.
3. **Exists.** The test file and test name are present in the working tree (not only in a plan).
4. **Passes.** The test appears in this run's output as passed. Prefer a targeted run of just that test (`<test command> <selector>`) when the project supports selection; record it as an extra Commands line. A skipped, pending or focus-excluded test is not a pass.
5. **Row.** `| AC-n | <file>::<test name> | PASS | <command, exit 0, and the traced path:symbol> |`; several tests are listed in the test cell separated by `; `. No qualifying test: `| AC-n | - | MISSING | searched <paths/terms> |`. A qualifying test that fails: `FAIL` with the failing output line.

Rules:
- A criterion verified only manually has no test and is `MISSING` unless the plan carries a `tdd_exemption` for it (then the exemption's recorded evidence replaces the test; cite it).
- One test can cover several criteria; each criterion still gets its own row and its own trace.
- The verifier does not judge whether the test is good beyond rule 2; test quality belongs to the tests reviewer.
