# Acceptance criterion to test mapping

For each `AC-n` in `TASK.md`:

1. **Candidates.** The plan's test mapping (`PLAN.md` `## Tests`) names tests per criterion; use it first. Otherwise search the changed and added test files (diff against base) for the criterion's concrete values (status code, message text, field names, limits) and its entry point.
   **Impact report (A85), when one is provided** (an evidence-map `impact` report, JSON `version: 1`, validated by `validate-impact.mjs <report> --repo <repo>` exiting 0; otherwise ignore it): `symbols[].tests[]` lists test files that reference or import the changed symbols; treat them as extra candidates and `symbols[].references[]` with `kind: exact` as the call sites a criterion's path may pass through. Candidates still go through steps 2 to 4; a listed test is not a pass. `heuristic` and `textual` entries and everything under `unknown` never prove a criterion covered, and an empty list never proves it uncovered (the limits name what static search cannot see); a criterion with no demonstrating test stays `MISSING`.
2. **References the behaviour.** Open the candidate and trace: the test sets up the criterion's situation, calls the code path the criterion describes, and asserts the observable outcome. Record `path:symbol` for the test and for the production function it reaches. A test that only imports the module, only checks that no exception occurs, asserts a constant, or mocks the unit under test does not reference the behaviour.
3. **Exists.** The test file and test name are present in the working tree (not only in a plan).
4. **Passes.** The test appears in this run's output as passed. Prefer a targeted run of just that test (`<test command> <selector>`) when the project supports selection; record it as an extra Commands line. A skipped, pending or focus-excluded test is not a pass.
5. **Row.** `| AC-n | <file>::<test name> | PASS | <command, exit 0, and the traced path:symbol> |`; several tests are listed in the test cell separated by `; `. For eligible command proof use `| AC-n | command: \`exact command\` | PASS | \`exact command\` exit=0; output: <demonstrating line> |`. The command and output line must also appear under Commands. No qualifying proof: `MISSING`; a qualifying test that fails: `FAIL`.

Rules:
- Command proof is allowed only when the frozen PLAN maps the criterion to at least one scope path and **every** mapped path has `tdd_exemption`. A bare exemption or an unrecorded grep is insufficient. Record the exact command, exit code and output lines that demonstrate the criterion.
- One test can cover several criteria; each criterion still gets its own row and its own trace.
- The verifier does not judge whether the test is good beyond rule 2; test quality belongs to the tests reviewer.
