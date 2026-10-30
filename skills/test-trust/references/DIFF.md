# Diff mode: the review gate's tests focus

Question answered: **"Can the tests this change added, edited or relies on be trusted?"** It replaces steps 3 to 8 of the full flow in `SKILL.md`; the probe (step 2) and the report step still apply. Nothing here widens the audit beyond the diff.

Flaky, hollow and slow keep the definitions and evidence criteria of [FLAKY.md](FLAKY.md), [HOLLOW.md](HOLLOW.md) and [SLOW.md](SLOW.md). What changes is the scope, the number of runs and the gate.

## 1. Inputs

- **Base.** Inside a run: `base_sha` from the assignment (also `repository.base_sha` in `.agents/runs/<TASK-ID>/RUN.yaml`). It must match `^[0-9a-f]{7,40}$` and pass `git rev-parse --verify '<sha>^{commit}'`; otherwise `BLOCKED`. Outside a run: `diff <base>` from the user; without one, `HEAD` when uncommitted changes exist, else the merge-base of the current branch with the main branch.
- **The task diff** is `<base>` against the working tree including untracked files, excluding `.agents/runs/` and `.agents/local/`: `git diff --name-status -M -z <base>` plus `git ls-files --others --exclude-standard -z` (paths come from `-z` output and are passed through NUL-delimited stdin, never typed into a command). Unchanged files are never examined.
- **Thresholds**: `repeat`, `mutation_budget`, `slow_ratio` as in `SKILL.md` "Thresholds". Record them in the ledger and in `scope.diff.thresholds`.
- **Fingerprint** at the start ([SKILL.md](../SKILL.md#fingerprint)).

## 2. Find the scope (read-only)

1. Split the changed paths into **test files** (the project's own test layout: naming convention, test directories, what the runner discovers) and **production files**. Documentation, config and generated files are neither; ignore them.
2. **Changed tests**: tests added or edited in the changed test files (read the hunks; a test whose body did not change is not a changed test, even in a changed file).
3. **Changed units**: production functions, methods or types with an added or modified line in the changed production files (hunk headers plus reading). Deleted-only units are not mutated. Record each as `file:name`.
4. **Covering tests**: tests that exercise a changed unit (imports, calls, names, fixtures; one level of indirection through a direct caller is enough). Tests already in the changed-tests set count once.
   **Impact report (A85), when one is provided** (an evidence-map `impact` report, JSON `version: 1`, validated by `validate-impact.mjs <report> --repo <repo>` exiting 0; otherwise ignore it): its `symbols[].tests[]` and top-level `tests[]` are candidate covering tests. Take `relation: references-symbol` with `kind: exact` as covering tests after a quick check; `imports-defining-module` and `covers-affected-file` are hints that still need the check above, and `textual` entries (a test title mentioning the name) are not coverage. Its `unknown` and `limits` (tests that reach a unit through dynamic dispatch, reflection or another repository) mean the covering set can be incomplete: a missing test in the report is never a reason to record "no test covers it".
5. The **diff scope** is changed tests plus covering tests. Record it in the ledger (`Hollow targets` table and Candidates) and in `scope.diff.tests`.

If the diff scope is empty (no test changed and none covers a changed unit) there is nothing to measure: `PASS`, `findings` empty, `CONFIDENCE: medium`, and say in the report "no test changed or covers a changed unit". Missing tests are not a test-trust finding; the plan, verify and QA gates own that question.

## 3. Baseline of the diff scope

Run the diff scope once, unmutated, in place. Record per-test durations (reporter output, never process wall time), outcomes and total duration. The timeout rule of `SKILL.md` hard rule 6 applies; the first run has no baseline to derive from, so use the 15-minute ceiling and stop if it is exceeded.

A test that fails here goes to **red at baseline**. Re-run it once in a clean worktree at `<base>` ([HOLLOW.md](HOLLOW.md#2-prepare-the-worktree)): if it also fails there it is **pre-existing**, informational, never a finding. If it passes at `<base>` it fails because of the change: it is not test-trust's finding either (the verify gate owns failing tests), it is listed under "red at baseline" in the report and is excluded from mutation. Flaky candidates are not treated this way: see section 4.

## 4. Flaky: isolated repeats

For every test in the diff scope run it **alone, `repeat` times**, sequentially, result caches disabled (single-test selection proven in the probe). Save `evidence/flaky-<test-slug>.*`. Timeout: 3× that test's own baseline duration, minimum 30 seconds; a timeout is a **fail**.

| Outcome over the runs | Verdict |
|---|---|
| at least one pass and at least one fail | `flaky_nondeterministic`, `confirmed` (the recorded pass and fail are the evidence; stop early, no need to complete the remaining runs) |
| all pass | not flaky |
| all fail | red (section 3), not flaky |

- **No single-test selection:** run the smallest selection the runner supports (file, class, package) `repeat` times. A test whose outcome changes between those runs is `flaky_unclassified`, `confirmed`, `missing`: "single-test selection unsupported, so nondeterministic vs. order-dependent could not be determined". Note the narrowing in the report and lower `CONFIDENCE` to `medium`.
- **Order dependence is not checked in diff mode** (it needs the whole suite shuffled). Say so in the report notes; the full-mode audit covers it.
- A flaky test is flaky whether the change introduced it or it was already there: a `confirmed` flaky finding in a changed **or covering** test fails the gate. Refute before reporting as in [FLAKY.md](FLAKY.md#refuting-a-candidate) (an environment change between runs is not the test's fault).
- Tests with a `confirmed` flaky finding are removed from the covering sets before mutation ([HOLLOW.md](HOLLOW.md#3-run-the-mutants)). A changed unit left with no non-flaky covering test is `hollow`, `needs_validation`, `missing`: "covering tests are flaky", and its mutants are not run.

## 5. Hollow: mutate changed units only

Only the **changed units** from section 2 are mutated, never other code, even when a changed test exercises it.

1. **Budget.** `mutation_budget` is the maximum number of mutants in total. Rank the changed units with the priority list of [HOLLOW.md](HOLLOW.md#1-choose-targets-read-only-before-the-cost-estimate) (units reached by tests with no assertions first), take 3 to 5 single-point mutations per unit round-robin by priority until the budget is spent. A unit that received no mutant goes to `scope.diff.not_examined` with reason `mutation budget`, and the result's `CONFIDENCE` is at most `medium`.
2. **Worktree.** Prepare and verify it exactly as in [HOLLOW.md](HOLLOW.md#2-prepare-the-worktree): path recorded in the ledger first, uncommitted changes copied in, dependency folders linked, build folders never, one unmutated verification run whose result must match the baseline. A first-build failure is `BLOCKED` inside a run (`BLOCKED_REASON: worktree build fails: <command>; decide: stop the hollow stage or fix the build`), never a question, never linking or installing on your own.
3. **Run** each mutant against the covering tests only (non-flaky ones), sequentially, timeout 3× the covering tests' summed baseline durations. Killed, survived and the verdict follow [HOLLOW.md](HOLLOW.md#3-run-the-mutants) and [HOLLOW.md](HOLLOW.md#4-verdict): a surviving mutant makes every covering test that stayed green `hollow`, `confirmed`, one finding per test, each pointing at the same surviving diff. Save every surviving diff under `evidence/` before removing the worktree.
4. A mutant killed only by the compiler proves nothing; choose another mutation (it still counts against the budget).
5. Ask `gate.mjs mutant <review-folder>/mutants.count ...` before EVERY mutant ([HOLLOW.md](HOLLOW.md#3-run-the-mutants), step 0): the budget is a cap enforced by that counter, and a `REFUSED` answer ends the mutant loop. `scope.diff.mutants_run` equals the count file. Count the mutants actually run in `scope.diff.mutants_run`. Stay within the budget: the validator refuses (INVALID, non-zero) findings whose `mutants_run` exceeds `mutation_budget`, so an overrun cannot be reported, only avoided with the counter.

### 5a. Claim mutants: does the named test observe its criterion?

Inside a run, PLAN `## Tests` names a test for each acceptance criterion (`- AC-n: <file> "<test name>"`). For **each** such criterion write one *claim mutant*: it removes the criterion's stated effect **while the operation still succeeds** (same status code, no exception), for example a cascade that deletes nothing without breaking the foreign key, a filter that returns everything, a value that is not stored. Run the **named test alone** against it.

- It must fail **on an assertion**. A failure by an error (exception, 5xx, constraint violation, timeout) proves only that the operation broke; it is not a kill of the claim, exactly like a compiler kill.
- A claim that survives, or dies only by error, is a `hollow` finding on the criterion's changed unit (`confirmed`), and the gate fails: the test does not observe what the plan says it proves.
- Record each claim in `scope.diff.claims` (`ac`, `test`, `mutant`, `outcome`, `failure`, `killed_by`). Claim mutants count against `mutation_budget`; when the budget cannot cover every criterion, say so as `needs_validation` and `CONFIDENCE: low`.
- Outside a run (no PLAN), claims are optional.

## 6. Slow: informational

Slow uses the per-test durations of the baseline run and the isolated runs, and the `slow_ratio` threshold instead of the full-mode rule:

- a test's duration is the mean of its completed isolated runs (timed-out runs left out, fewer than 3 completed runs means `needs_validation`);
- the reference median is the median of the per-test durations of the **enclosing test files** (the smallest selection the runner can report per-test durations for, run once, unmutated, in place), so a small diff scope still has peers;
- below the reporter's resolution, use the resolution as the median;
- a test is slow when its mean duration is more than `slow_ratio` times that median. `observed` follows [SLOW.md](SLOW.md#criterion) (`ratio_to_median` is checked against the threshold by the validator; `share_of_total` is the share of the diff scope's total).

Without the per-test duration capability slow is unsupported and nothing is guessed. A slow finding never changes the result; it is listed with severity `info`.

## 7. Result

1. Write `findings.json` with `mode: "diff"`, `fingerprint`, `scope.diff` (base, thresholds, changed units, tests, `mutants_run`, `not_examined`) and the findings, then compute the gate with the rule of `SKILL.md` (`node <skill-dir>/scripts/gate.mjs gate` or by hand) and write `gate: {result, failing}`. The scope `slug` is `diff`; `paths` are the changed paths.
2. Write `REPORT.md` ([REPORTING.md](REPORTING.md#reportmd)) with the gate result first, then the blocking findings, then everything else.
3. Validate, prune evidence, take the closing fingerprint, send the result message (`SKILL.md` "Result in a run").

`CONFIDENCE`: `high` when every changed unit was examined and single test, repeat and per-test duration were proven; `medium` when a unit was left out for the budget, a capability was unsupported, or the diff scope was empty; `low` when a refutation attempt was inconclusive for a finding that decides the result.

## 8. Re-runs (fix rounds)

Diff mode keeps no findings between runs: every run measures the diff scope from scratch against the same `<base>` and writes a fresh `findings.json`. A fix round therefore proves the fix by re-measuring, and a finding that no longer reproduces simply does not appear. Ids restart at `F001`.
