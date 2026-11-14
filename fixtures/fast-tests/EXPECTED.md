# fast-tests fixture (issue 265, AC-9)

Built by `setup.mjs <dir>`, proved by `selfcheck.mjs <dir>` (run by `node tests/fixtures/check-fixtures.mjs fast-tests`). Plain files; nothing is installed, run or waited for.

| Case | Input | Expected |
|---|---|---|
| a. a test that sleeps | `sleepy/tests/retry.test.js` (a real 600 ms timer) | `cli test-scan` reports `sleepy/tests/retry.test.js:8 wait setTimeout` (exit 1, the same bytes twice); `findings/sleepy.json` (`real_wait`, traced) validates and the gate is FAIL; `findings/wrong-gate.json` (gate PASS for a confirmed wait) is INVALID |
| b. the same test with a fake clock | `fake-clock/tests/retry.test.js` | no candidate (exit 0); `findings/fake-clock.json` gate PASS; `findings/justified.json` (the plan's `## Test exceptions` line quoted) is `cleared` and PASS with `--plan plan/PLAN.md` |
| c. a test over its budget | 3500 ms measured, plan budget 200 ms | `BUDGET test "retries after the delay" (unit) took 3500 ms, over its 200 ms test budget (plan)`; `findings/over-budget.json` (`over_budget`) gate FAIL |
| d. a test that fails in one of two runs | an injected runner: exit 0, then exit 1 | one `STABILITY ... exited 0 on run 1 and 1 on run 2 of the same commit`; the second command is never run, nothing is retried |
