# Gate rule

`Verdict: FAIL` when at least one of these holds; `PASS` when none does:

| # | Condition | Recorded as |
|---|---|---|
| 1 | a command exits non-zero and has no `base_exit` (not re-run at base), or `base_exit=0` (regression) | `command failed: <cmd>` |
| 2 | an `AC-n` row has status `FAIL` or `MISSING`, or an AC of the task has no row | `AC-n FAIL|MISSING` |
| 3 | `verify-scope` exit is non-zero (a changed path outside the plan's scope) | `verify-scope failed` |
| 4 | design-sync verdict is `FAIL` | `design-sync drift` |
| 5 | a dependency or contract check named in step 7 failed, or design-sync drift (also row 4) | each entry under `## Failures` |

Not failures: a command that fails with a non-zero `base_exit` (pre-existing); design-sync `SKIPPED` with a reason; design-sync unverifiable claims; anything that is only an opinion.

`BLOCKED` is not computed: it is written when a check cannot be performed at all (no test command exists, a required tool is missing, no base revision for a baseline that rule 5 needs). It carries a `BLOCKED: <reason>` line and records no gate.

`scripts/validate-verify.mjs` implements rows 1-5 and rejects a `PASS` when any of them holds: every entry (bullet or table row) under `## Failures` counts as a failure, only `None` or an empty section does not. Nothing needs mirroring in Commands or Scope.

A `PASS` with a flaky command (passed on rerun) is returned with `CONFIDENCE: low`.
