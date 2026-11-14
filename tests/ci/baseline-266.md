# Baseline for issue 266 (before any change)

Starting point of main at 66d1bb28 (version 0.0.108), before any change of issue 266. Two sources: the CI run of that commit (suite totals, machine-neutral enough to compare later) and a partial local per-test measurement (loaded machine, order only).

## CI suite totals (before)

Source: `gh api repos/furkansarikaya/proofline/actions/runs/43640738049/jobs` (push run of 66d1bb28 on main, conclusion success, 140 jobs). Seconds from job start to job completion; "slowest step" is the longest step of the job. Slowest 25 jobs, slowest first:

| s | job | slowest step (s) |
|---:|---|---|
| 213 | static (ubuntu-latest) | skill tests (202) |
| 206 | node-tests (22.13.0, port-replays) | tests of this leg (files) (195) |
| 197 | node-tests (lts/*, port-replays) | tests of this leg (files) (187) |
| 161 | node-tests (22.13.0, cli-install) | tests of this leg (files) (150) |
| 144 | node-tests (lts/*, cli-install) | tests of this leg (files) (137) |
| 137 | node-tests (22.13.0, gates-s4) | tests of this leg (files) (129) |
| 124 | node-tests (lts/*, lifecycle-s2) | tests of this leg (files) (108) |
| 122 | node-tests (22.13.0, run6-merged) | tests of this leg (files) (112) |
| 111 | node-tests (lts/*, risk-s1) | tests of this leg (files) (103) |
| 107 | node-tests (22.13.0, cli-front) | tests of this leg (files) (99) |
| 104 | node-tests (lts/*, gates-s4) | tests of this leg (files) (94) |
| 101 | node-tests (lts/*, gates-s3) | tests of this leg (files) (90) |
| 98 | node-tests (22.13.0, lifecycle-s2) | tests of this leg (files) (83) |
| 95 | node-tests (22.13.0, lifecycle-s1) | tests of this leg (files) (86) |
| 90 | node-tests (22.13.0, gates-s3) | tests of this leg (files) (79) |
| 89 | node-tests (lts/*, run6-merged) | tests of this leg (files) (76) |
| 88 | node-tests (lts/*, lifecycle-s1) | tests of this leg (files) (74) |
| 86 | node-tests (22.13.0, lifecycle-s3) | tests of this leg (files) (77) |
| 82 | hook-node (node-tests, lts/*) | guard tests against the Node hook (24) |
| 80 | node-tests (22.13.0, risk-s1) | tests of this leg (files) (70) |
| 79 | node-tests (lts/*, cli-front) | tests of this leg (files) (69) |
| 78 | node-tests (lts/*, gates-s1) | tests of this leg (files) (69) |
| 78 | node-tests (lts/*, e2e-real-session) | tests of this leg (files) (70) |
| 77 | node-tests (22.13.0, run6-cifix) | tests of this leg (files) (67) |
| 75 | node-tests (22.13.0, e2e-real-session) | tests of this leg (files) (67) |

Sum of all job durations: 6538 s; slowest single job: 213 s (static (ubuntu-latest)); slowest node-tests leg: 206 s. The AC-7 comparison (slowest suite after not higher than before) uses these job durations; a later run should be compared with several runs, as one run varies with the runner.

## Per-test numbers (partial, loaded machine)

How: `node tests/ci/test-durations.mjs --twice --load --top 40 --out FILE -- <leg files>`, one CI leg (group of files of `.github/workflows/ci.yml`) at a time, three legs in parallel, on a local macOS machine (8 cores, Node v24.14.1; CI uses 22.13.0 and the active LTS) shared with other agents. The 1 minute load average was about 90 to 200 during the runs (see below), far above the 8 cores, so every duration is inflated by a factor of several against CI (the slowest CI leg is 206 s, the same legs took 400 s and more here) and only the ORDER of tests and suites is meaningful. The run was stopped by the coordinator after the groups below because it starved the other agents; the remaining groups and a quiet-machine run of the slowest files (golden, entry, legacy-waivers, port-rig, the process-group test file) were NOT done, since the load never fell below 8. Take budgets from CI step durations, not from these numbers.

Load average at the start of the runs: 92 to 189 (median 135); 220 when the runs were stopped. Groups measured: 12 of 66; 1376 tests; 0 failed in either run.

## Per-test numbers, partial: slowest 30 tests (by the faster of the two runs)

| min ms | max ms | group | file :: test |
|---:|---:|---|---|
| 40676 | 52661 | leg-core-rest | tests/core/golden.test.mjs :: next output order golden > agent.sh next prints the recorded text in every state |
| 34404 | 43711 | leg-core-rest | tests/core/entry.test.mjs :: doctor and a missing core > FAIL when proofline-core.mjs or core/ is missing, and it does not claim the moved commands run in Node |
| 26554 | 30036 | leg-run4b-freeze | tests/core/run4b-freeze.test.mjs :: handoff: the ladder is strict, an implementer may only start implementing, IMPLEMENTED needs the worker evidence, CODE_DONE needs the gates and an unc |
| 26086 | 43986 | leg-legacy-approvals | tests/core/legacy-waivers.test.mjs :: a waiver follows the finding across gate re-runs; a new place or a changed finding asks again |
| 25765 | 34322 | leg-legacy-approvals | tests/core/legacy-waivers.test.mjs :: a waiver without a resolvable line binds its record only; a backslash line keeps its copies apart |
| 23768 | 34515 | leg-legacy-approvals | tests/core/legacy-approval-multi.test.mjs :: several approvals in one message are parsed one by one (A202) |
| 15678 | 31176 | leg-legacy-flows-b | tests/core/legacy-recovery.test.mjs :: tree recovery: the user's approval of the inspected tree keeps the run, every gate runs again, no agent accepts it |
| 14769 | 16182 | leg-legacy-flows-b | tests/core/legacy-fail-closed.test.mjs :: a fix-round reopen keeps the hash; a TASK.md-only refreeze stays; a refreeze to non-destructive needs no approval |
| 14379 | 15765 | leg-legacy-flows-a | tests/core/legacy-destructive.test.mjs :: a refreeze drops the destructive approval; single_step: yes needs the user's single-step approval |
| 14344 | 16060 | leg-legacy-flows-a | tests/core/legacy-destructive.test.mjs :: destructive plan: forced CRITICAL, freeze on the plan approval, expand/contract steps, destructive approval before IMPLEMENT |
| 14134 | 20185 | leg-legacy-approvals | tests/core/legacy-approvals.test.mjs :: approvals: request, capture freshness/phrase/hash, single use, commit binding, no-run push |
| 13448 | 17842 | leg-verify | tests/core/verify-fixes.test.mjs :: a changed path that cannot be baselined fails the scope commands (S2-1) > an untracked symlink and two out-of-scope files |
| 13056 | 15014 | leg-verify | tests/core/verify-fixes.test.mjs :: a changed path that cannot be baselined fails the scope commands (S2-1) > a symlink in the knowledge scope |
| 12682 | 15227 | leg-run4a-records | tests/core/run4a-records.test.mjs :: discard-stray: only one stray top-level regular file of the run folder, lead only, never a known artifact, ledgered and chain-safe |
| 12655 | 30750 | leg-legacy-approvals | tests/core/legacy-approvals.test.mjs :: waivers: approval naming the finding, lead only |
| 12412 | 13455 | leg-run4b-freeze | tests/core/run4b-freeze.test.mjs :: freeze: the mutation budget is one question now, a destructive plan becomes CRITICAL, non-English plan text is refused, a UI plan needs visual_writes |
| 11590 | 14830 | leg-verify | tests/core/verify-fixes.test.mjs :: a changed path that cannot be baselined fails the scope commands (S2-1) > a nested git directory |
| 11495 | 13473 | leg-core-rest | tests/core/fingerprint.test.mjs :: content fingerprint equals the shell > control plane files are not content: .agents, installed files, proofline block |
| 11423 | 20450 | leg-run4a-records | tests/core/run4a-records.test.mjs :: delivery-check: knowledge-scope files written after the knowledge step are secret-scanned and design-sync drift blocks |
| 10792 | 12654 | leg-core-rest | tests/core/githooks.test.mjs :: pre-commit: identity guard, protected branch, copied files, no open run |
| 9690 | 15809 | leg-legacy-approvals | tests/core/legacy-questions.test.mjs :: NEEDS_INPUT: stored verbatim, one round per role, awaiting_input until every question is answered, a typed answer is the lead's |
| 9439 | 12139 | leg-legacy-approvals | tests/core/legacy-approval-grammar.test.mjs :: approve refuses an ambiguous reply and leaves the request pending; the question lists the accepted answers; the grammar is locale independent |
| 9363 | 12772 | leg-verify | tests/core/verify-fixes.test.mjs :: a changed path that cannot be baselined fails the scope commands (S2-1) > a submodule |
| 9301 | 28206 | leg-run4b-freeze | tests/core/run4b-freeze.test.mjs :: freeze: the task's own boundaries - Forbidden scope is never waived, Allowed scope bounds the plan, an entry must be a path, a pattern reference must  |
| 8914 | 16546 | leg-run4a-records | tests/core/run4a-records.test.mjs :: discard-stray evidence/<file> (A219): never a record, a registered artifact, or anything outside the run |
| 8766 | 12714 | leg-core-rest | tests/core/cli.test.mjs :: cli subcommands through the front ends > insights: text, json, run filter, off, empty states |
| 8328 | 9833 | leg-port-rig-b | tests/core/port-t3-rig.mjs :: rig stage 2, part 5 of 8 > pipeline: intake-branched |
| 8215 | 9005 | leg-port-rig-a | tests/core/port-t3-rig.mjs :: rig stage 2, part 3 of 8 > pipeline: scale-20 |
| 8199 | 8349 | leg-port-rig-b | tests/core/port-t3-rig.mjs :: rig stage 2, part 5 of 8 > pipeline: gates-waive-nomatch |
| 8174 | 9550 | leg-port-rig-b | tests/core/port-t3-rig.mjs :: rig stage 2, part 5 of 8 > pipeline: gates-pending-waive |

## Total per CI group (sum of the top level durations of its files)

| group | files | tests | total min ms | total max ms | exit statuses |
|---|---:|---:|---:|---:|---|
| leg-port-rig-a | 1 | 376 | 402899 | 433042 | 0,0 |
| leg-port-rig-b | 1 | 331 | 366518 | 390287 | 0,0 |
| leg-port-rig-c | 3 | 251 | 248053 | 261345 | 0,0 |
| leg-core-rest | 32 | 311 | 239836 | 319928 | 0,0 |
| leg-legacy-approvals | 6 | 23 | 170280 | 267809 | 0,0 |
| leg-run4a-records | 1 | 27 | 104335 | 154810 | 0,0 |
| leg-run4b-freeze | 1 | 10 | 74628 | 101924 | 0,0 |
| leg-legacy-flows-b | 3 | 11 | 73237 | 119826 | 0,0 |
| leg-verify | 1 | 8 | 56249 | 75760 | 0,0 |
| leg-legacy-flows-a | 3 | 5 | 41659 | 47494 | 0,0 |
| leg-run4a-classify | 1 | 13 | 40953 | 54040 | 0,0 |
| leg-run4b-lifecycle | 1 | 10 | 28508 | 63994 | 0,0 |

## Slowest 20 suites (files; by the faster of the two runs)

| min ms | max ms | tests | file |
|---:|---:|---:|---|
| 402899 | 433042 | 376 | tests/core/port-t3-rig.mjs |
| 104335 | 154810 | 27 | tests/core/run4a-records.test.mjs |
| 74628 | 101924 | 10 | tests/core/run4b-freeze.test.mjs |
| 59464 | 87344 | 3 | tests/core/legacy-waivers.test.mjs |
| 56249 | 75760 | 8 | tests/core/verify-fixes.test.mjs |
| 45779 | 75192 | 6 | tests/core/legacy-fail-closed.test.mjs |
| 41045 | 53128 | 4 | tests/core/golden.test.mjs |
| 40953 | 54040 | 13 | tests/core/run4a-classify.test.mjs |
| 39773 | 50952 | 11 | tests/core/entry.test.mjs |
| 36328 | 38705 | 3 | tests/core/legacy-destructive.test.mjs |
| 34777 | 60135 | 3 | tests/core/legacy-approvals.test.mjs |
| 30000 | 37306 | 13 | tests/core/fingerprint.test.mjs |
| 28508 | 63994 | 10 | tests/core/run4b-lifecycle.test.mjs |
| 26470 | 34959 | 11 | tests/core/answer-user.test.mjs |
| 23768 | 34515 | 1 | tests/core/legacy-approval-multi.test.mjs |
| 21391 | 27713 | 9 | tests/core/cli.test.mjs |
| 20672 | 37781 | 2 | tests/core/legacy-recovery.test.mjs |
| 17703 | 23022 | 3 | tests/core/githooks.test.mjs |
| 15832 | 19725 | 9 | tests/core/grep-failclosed.test.mjs |
| 14250 | 35945 | 13 | tests/core/test-scan.test.mjs |

## Unstable between the two runs (6: 0 outcome or missing, 6 duration; tolerance: more than 2000 ms apart AND more than 4x)

Duration (worst 15 by the larger run):

- leg-run4b-lifecycle: tests/core/run4b-lifecycle.test.mjs :: amend: reopens a CODE_DONE run with a specific form; a path outside the frozen scope needs plan_change; the record, the states and the ledger follow [23066 / 5337 ms]
- leg-legacy-flows-b: tests/core/legacy-fail-closed.test.mjs :: provenance: hand-written gate records, waivers (SECURITY included) and approvals are ignored; validate names them [21482 / 4401 ms]
- leg-run4a-classify: tests/core/run4a-classify.test.mjs :: classify: a bug or a refactor is never TRIVIAL, an unreadable type is refused, a destructive plan is CRITICAL, a completed run is not reclassified [14220 / 2501 ms]
- leg-legacy-approvals: tests/core/legacy-approval-grammar.test.mjs :: tree recovery: a hand-written window of role user, not bound in the ledger by tree-accept, attests nothing [12979 / 1874 ms]
- leg-core-rest: tests/core/test-scan.test.mjs :: S1: a support file that holds tests is scanned for waits; plain code only for clock reads [6183 / 1285 ms]
- leg-legacy-approvals: tests/core/legacy-approval-grammar.test.mjs :: approval detection is fail-closed: ambiguous, negated, hedged and wrong-kind answers never approve (A108) [3446 / 544 ms]

