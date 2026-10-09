# Executing the frozen plan

## Environment

1. **Sandbox warning** once, before project code first runs: the scenarios execute project code and scripts with the user's permissions.
2. **Where.** Scenarios that use only the existing build, tests and CLI run in the working tree. Anything that needs temporary code (a probe script that imports project modules, a harness, a patched config) runs in a separate worktree created from the current tree (uncommitted changes copied in, git-ignored dependency folders symlinked, build output folders neither linked nor copied). Record the worktree path in the ledger before use; a recorded path from an earlier run is removed on resume. All path checks use `realpath`.
3. **Baseline first.** Run the project's test command on the unmodified tree; record result and duration. The scenario timeout is `max(30s, 3 x measured baseline duration of the relevant command)`.

## Per scenario

1. Append the scenario to the ledger as `started` (id, command).
2. Run the `run:` line exactly. Capture exit status and the relevant output lines (never the whole log).
3. Compare to `expected:` literally. Differences in wording that a test would not assert are not failures; differences in value, status, presence or absence are.
4. Record the result row, then the next scenario.

## Result rules

| Observed | Result |
|---|---|
| matches `expected:` | `PASS` |
| differs from `expected:` on the first run and again on one rerun | `FAIL` |
| differs on the first run only | `BLOCKED` with reason "non-deterministic" (a flaky result is never a PASS) |
| cannot run (tool, data, service or permission missing; timeout without result) | `BLOCKED` with the reason and what was tried |

Evidence in the report line: what was observed, then the command and exit status in parentheses.

## Failures section

For each `FAIL`: id, expected vs actual, smallest reproduction, `fix_scope:` (project paths the fix should touch, from tracing the failing path), fix instruction (what behaviour is wrong, not how to code it). For each `BLOCKED`: id, reason, what would unblock it. Suspicions (no reproduction) are listed under `Suspicions:` and never change the verdict.

## Unplanned observations

A defect noticed outside the plan is reported under Suspicions (or as a reproduced finding row in team mode only when it reproduces and touches a plan criterion). It does not add scenarios to the frozen plan.
