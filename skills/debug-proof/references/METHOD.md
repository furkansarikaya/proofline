# debug-proof method

## 1. Reproduce

1. Create the worktree from HEAD (path recorded in the ledger before creation); copy the user's uncommitted changes in when the bug involves them; symlink git-ignored dependency folders, never build output folders; check paths with `realpath`.
2. Find the narrowest command that shows the bug: an existing failing test, a new minimal test, a script that calls the function, a CLI invocation, a request. Prefer the project's own test runner.
3. Run it unmodified, with a timeout (3x measured duration, at least 30 seconds), at least twice. Record `command`, `runs`, `failures`, `exit_code`, and an excerpt (at most 20 lines) of the failure output.
4. The failure must be the reported one. A different failure (for example a setup error) means the reproduction is wrong: fix the reproduction, not the code.
5. Flaky (failures < runs): find what varies (time, order, concurrency, randomness, environment) by repeating with controls; the proof experiment later is repeated enough times that a pass cannot be luck (at least 10 runs, all passing, against a baseline that failed in a measured share of runs).

## 2. Hypothesise

Write at least two candidate causes, ranked by (likelihood given the evidence) and (cost to test). Each: `statement` (a mechanism at a `path:symbol`), `falsifier` (the observation that would refute it), `rank` (1 = test first). Sources: the stack trace, the diff since the last good version, the data the failing input exercises, recent changes to the failing function's callers. A hypothesis that names no mechanism ("something with caching") is rewritten until it does.

## 3. Narrow

- **Minimise the input**: halve the failing input/fixture repeatedly while it still fails.
- **Instrument** in the worktree only: log the values at the hypothesis' decision points; one probe per hypothesis; record the observed values in the ledger.
- **Bisect over commits** when a known-good commit exists and the reproduction is scriptable ([BISECT.md](BISECT.md)).
- **Bisect over inputs/config** when no good commit exists: toggle half of the differing settings between a working and a failing configuration.
- After each experiment update the hypotheses: `refuted` when the falsifier was observed, `confirmed` only through section 4, otherwise stays `open`. Stuck after all hypotheses are refuted: write new ones from what the experiments showed; do not pick the least-bad one.

## 4. Prove the cause

Proof experiment: change only the suspected cause in the worktree (restore the correct value/branch/ordering/guard at the identified `path:symbol`), run the reproduction, and observe it pass (`flips_failure: true`). Then revert exactly that change and observe the failure return. The experiment is `isolates_cause: true` only when the diff of the experiment is that single change. Record the diff size in lines in the `change` text. If the flip needs more than one change, the cause is not yet isolated: continue narrowing.

## 5. Fix

Before editing: grep every caller of the function you will change. Fix once at the cause where all callers route through. Keep the diff to what the cause requires: no renames, no formatting churn, no opportunistic cleanup. Public contract or behaviour change visible to callers other than the failing one is reported to the lead (team) or the user (standalone) before it is applied.

## 6. Regression test

Place the test where the project's tests for that unit live, in the style they use. It must assert the correct behaviour, with the failing input minimised in step 3. Run it against the pre-fix code (worktree with the fix reverted): it must fail on the assertion, not on compile/import/setup errors; record the excerpt. Run it with the fix: it passes with the same command. Run the suite: it passes (pre-existing failures named and excluded). A regression test that passes before the fix is rejected: it does not test the bug.

## 7. Build errors

Mode `build_error`: the reproduction is the project's build/compile/typecheck command and its first failing diagnostic. Work from the first error only (later errors are often consequences). Hypotheses are causes of that diagnostic: missing/renamed symbol, version or API change in a dependency, generated code stale, wrong target/configuration, environment (tool version). Never install or upgrade anything to fix it: if a missing tool or dependency is the cause, report it (NEEDS_INPUT). The regression check is the build command passing after the fix (`regression_test.type: build`) plus a test whenever behaviour changed.

## 8. Validation rules

The validator enforces, always: `schema_version` 1; `kind` `bug|build_error`; `status` `fixed|unresolved`; reproduction with `exit_code` non-zero, `runs >= 2`, `failures >= 1`, non-empty excerpt; at least 2 hypotheses with unique ids, unique ranks, non-empty statement and falsifier; unique experiment ids that reference known hypotheses; each `confirmed` hypothesis has a `confirms` experiment, each `refuted` one a `refutes` experiment; at most one confirmed hypothesis; `bisect` complete when used. For `fixed`: `root_cause` referencing the confirmed hypothesis and a proof experiment with `result: confirms`, `isolates_cause: true`, `flips_failure: true`; `fix.paths` non-empty relative paths; `regression_test` with before exit non-zero (and, for type `test`, an excerpt that is not a compile/import/syntax/setup error), after exit 0, suite exit 0, same command before and after; with `--scope`, every fix path and the regression test path inside scope. For `unresolved`: `blocked_reason` and `next_experiment` non-empty, and no `fixed`-only fields.
