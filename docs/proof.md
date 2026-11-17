# Proof, not promises

This page collects the measured facts behind proofline's claims, each with the place where you can check it, and ends with what these facts do not prove. It follows the project's own rule: no evidence, no claim. Figures were taken on 2026-11-17 at proofline 0.0.151 (`main` at ed7a0e31); the test counts are from the last finished push run of `main`, on 8f84d850 (0.0.150), because the counts were not recomputed for ed7a0e31, whose push run 44063481112 is also success.

Where a number comes from a decision record, the record is named by its number (`A<n>` in [decisions.md](decisions.md)); "local" means measured on the maintainer's machine, often under load, not on CI.

## The suite and what counts as a test

One CI run of `main` for commit 8f84d850 ([run 44051436515](https://github.com/furkansarikaya/proofline/actions/runs/44051436515), push, success) wrote one duration report per test step (133 `test-durations-*` artifacts, produced by `tests/ci/test-durations-ci.mjs`). A report counts leaf tests; suites are not counted. Summed over the reports of the Node 22.13.0 steps (the `static` job ran Node 22.23.4):

| Job | Reports | Test results |
|---|---:|---:|
| `node-tests` | 61 | 3,540 |
| `hook-node` (1 job) | 7 | 1,174 |
| `static` (1 job: suite, generator, benchmark) | 3 | 1,101 |
| `invariants` (8 jobs, one per scenario; the context-budget tests run inside one of them) | 9 | 22 |
| Total test results | | 5,837 |

The `node-tests` and `hook-node` legs also run on the `lts/*` Node release with the same counts (3,540 and 1,174); those are not added again. The previous figure on this page, 5,723 results on 03c110a0 (0.0.135), was counted the same way.

The total is test results, not distinct tests: a few files run in two jobs (for example the hook guards and wiring tests in both `hook-node` and `node-tests`, the context-budget tests, and the invariant scenarios, which are also inside `node-tests`). Per file, taking the largest count among the job kinds gives 5,661 distinct tests by that method (176 results counted twice; it is a computation on the artifacts, not a number the CI prints). No job failed; `fixtures`, `types` and `static` were green, and the Windows and browser legs were skipped, as they are on a push ([workflow](../.github/workflows/ci.yml)).

## Decisions on record

- `docs/decisions.md` holds 323 numbered decisions, A1 to A324 with one number never assigned, counted with `grep -c '^- \*\*A[0-9]\+\.'`. Each states what changed and why; 216 of the decision lines also contain the word "rejected" (`grep '^- \*\*A[0-9]*\.' docs/decisions.md | grep -ci rejected`; it counts the word, so a few of them use it for something other than a list of discarded alternatives). Every behaviour change is a decision ([CONTRIBUTING](../CONTRIBUTING.md)). The records below show what the reviews found:

- **A284 (a change to test exceptions at a refreeze), five security review rounds** (CHANGELOG entries "A284, review round 1" to "round 5"). Round 1 found a ledger-row injection: a free-text reason ending in a forged row could be read as a genuine baseline, so no approval was asked and a refreeze passed. It was fixed at the reader and at the writer. Round 2 found the same class in the readers of gate, waiver and approval bindings. Tests inj-1, inj-2 and inj-6 cover them; the record states that inj-6 fails before its fix.
- **A292 (Windows hook tests):** a "safe fs layer" built in a review round was removed after the security review showed that its own error was turned into an ALLOW when no run was active, which let a lead write product files the hook would deny; the proof of concept was reproduced. The existing hook wrapper already fails closed, so the layer was dropped (A292, "REVIEW HISTORY").
- **A293 (review and security roles never push):** four security rounds found bypasses that were closed class by class. The result is stated as a tripwire for honest mistakes, not a boundary against a determined agent; the real boundaries are named (branch protection and the git pre-push hook). The test matrix `tests/hook/readonly-git-cases.mjs` has 487 rows (324 deny, 163 allow), counted from the file at 03c110a0. The record itself quotes 440 rows (290 and 150) from an earlier state of the matrix.

## Pull requests #278 to #313

Every pull request in this range was merged (checked with `gh pr view <n> --json title,mergedAt`). "Decision" is the number in the pull request title; the version is the CHANGELOG heading that carries that decision. PR #289 carries A290 in its title, its record and its CHANGELOG entry are A295. The decisions A304 to A310 and A321 to A323 have no pull request in this range: they are docs-only records (accepted limits and the end-to-end expectations).

| PR | Merged (UTC date) | Decision | Version | Title |
|---|---|---|---|---|
| [#278](https://github.com/furkansarikaya/proofline/pull/278) | 2026-11-15 | A279 | 0.0.117 | fix: a pinned .NET SDK that is not installed is a mismatch, not 'not installed' |
| [#279](https://github.com/furkansarikaya/proofline/pull/279) | 2026-11-15 | A280 | 0.0.118 | fix: .NET projects on Microsoft.Testing.Platform get dotnet test --solution/--project |
| [#280](https://github.com/furkansarikaya/proofline/pull/280) | 2026-11-15 | A281 | 0.0.119 | test: real pytest 9.2 and Jest 29.7 output fixtures; pytest exit-code label |
| [#281](https://github.com/furkansarikaya/proofline/pull/281) | 2026-11-15 | A282 | 0.0.120 | docs: measured discovery cost replaces the stale 'plain sh' claim; .NET limit follows A280 |
| [#282](https://github.com/furkansarikaya/proofline/pull/282) | 2026-11-15 | A283 | 0.0.121 | refactor: the audit-tool table moves from exploit-proof code to ecosystems.json data; the static check catches ecosystem-keyed tables |
| [#283](https://github.com/furkansarikaya/proofline/pull/283) | 2026-11-16 | A284 | 0.0.122 | fix: a changed Test exceptions section passes a re-freeze with the user's scope approval; ledger and file-write hardening |
| [#284](https://github.com/furkansarikaya/proofline/pull/284) | 2026-11-16 | A285 | 0.0.123 | fix: a lead-written plan test exception clears a finding only with the user's approval; batch pre-flight lists them |
| [#285](https://github.com/furkansarikaya/proofline/pull/285) | 2026-11-16 | A286 | 0.0.124 | test: legacy-identity and legacy-language spawn fewer processes, so a stalled runner no longer turns main red |
| [#286](https://github.com/furkansarikaya/proofline/pull/286) | 2026-11-16 | A287 | 0.0.125 | test: visual-proof design browser tests run the audit waits at a quarter scale; the scale is recorded and refused outside tests |
| [#287](https://github.com/furkansarikaya/proofline/pull/287) | 2026-11-16 | A288 | 0.0.126 | test: doctor-faults runs doctor without the live probes it does not assert; fixture-trees builds the proofline-lead states once |
| [#288](https://github.com/furkansarikaya/proofline/pull/288) | 2026-11-16 | A289 | 0.0.127 | test: the user-decisions suite and lifecycle-s2 build their fixtures once and skip the doctor probes they do not assert |
| [#289](https://github.com/furkansarikaya/proofline/pull/289) | 2026-11-16 | A295 | 0.0.133 | ci: the Windows hook leg also runs on pull requests that touch path, hook or guard code |
| [#290](https://github.com/furkansarikaya/proofline/pull/290) | 2026-11-16 | A290 | 0.0.128 | test: six more spawn-heavy, duration-unstable tests build their state in process and share staged templates |
| [#291](https://github.com/furkansarikaya/proofline/pull/291) | 2026-11-16 | A291 | 0.0.129 | feat: in an approved unattended batch the knowledge step takes a visible non-writing default instead of asking the user |
| [#292](https://github.com/furkansarikaya/proofline/pull/292) | 2026-11-16 | A292 | 0.0.130 | test: the Windows hook tests state the Windows expectation and the hook screens the two code points that abort Node on Windows |
| [#293](https://github.com/furkansarikaya/proofline/pull/293) | 2026-11-16 | A293 | 0.0.131 | feat: review and security agents never push or create branches: a tripwire in the runtime hook and the pre-push hook |
| [#294](https://github.com/furkansarikaya/proofline/pull/294) | 2026-11-16 | A294 | 0.0.132 | feat: the task author proposes the test exceptions a task foreseeably needs, so a batch asks the user about them up front |
| [#295](https://github.com/furkansarikaya/proofline/pull/295) | 2026-11-16 | A296 | 0.0.134 | test: direct clock reads in new or changed tests are blocked, and the existing ones can only shrink |
| [#296](https://github.com/furkansarikaya/proofline/pull/296) | 2026-11-16 | A297 | 0.0.135 | test: the plan-exceptions invariant suite builds its state once and no longer sits at its duration budget |
| [#297](https://github.com/furkansarikaya/proofline/pull/297) | 2026-11-16 | none | no release | docs: README, an evidence page and a refresh of the documents for the launch |
| [#298](https://github.com/furkansarikaya/proofline/pull/298) | 2026-11-16 | A298 | 0.0.136 | fix: batch-plan stops on an invalid test-exception line, and the task templates carry the section |
| [#299](https://github.com/furkansarikaya/proofline/pull/299) | 2026-11-16 | A299 | 0.0.137 | test: the tree-recovery test guards the real window check, the exception suites stage their state once, and the budgets of the faster files are re-derived |
| [#300](https://github.com/furkansarikaya/proofline/pull/300) | 2026-11-16 | A300 | 0.0.138 | test: the windows-core legs are green on main again: four tests state the Windows expectation |
| [#301](https://github.com/furkansarikaya/proofline/pull/301) | 2026-11-16 | A301 | 0.0.139 | docs: the Turkish guides are updated to the current English pages, and a stale translation warns in CI |
| [#302](https://github.com/furkansarikaya/proofline/pull/302) | 2026-11-16 | A302 | 0.0.140 | fix: the PreToolUse wiring keeps the hook's exit status, so a deny, an abort or a crash is blocked with or without .agents/config.yaml |
| [#303](https://github.com/furkansarikaya/proofline/pull/303) | 2026-11-16 | A303 | 0.0.141 | fix: batch-cover and the knowledge default honour a task only when the user-approved summary lists it |
| [#304](https://github.com/furkansarikaya/proofline/pull/304) | 2026-11-16 | A311 | 0.0.142 | test: the port-rig and the readonly-git suites no longer sit near their duration budgets |
| [#305](https://github.com/furkansarikaya/proofline/pull/305) | 2026-11-16 | A312 | 0.0.143 | fix: the completion report is an English run file, checked before it is published |
| [#306](https://github.com/furkansarikaya/proofline/pull/306) | 2026-11-16 | A313 | 0.0.144 | test: the end-to-end reply loop answers a refreeze with the plan approval only and never repeats an interview answer |
| [#307](https://github.com/furkansarikaya/proofline/pull/307) | 2026-11-16 | A314 | 0.0.145 | test: the port-replays tier, fingerprint, eco and own-commits cases no longer sit near their duration budgets |
| [#308](https://github.com/furkansarikaya/proofline/pull/308) | 2026-11-17 | A315 | 0.0.146 | fix: the control plane does not touch process.stdin, so a command that reads piped input waits for it |
| [#309](https://github.com/furkansarikaya/proofline/pull/309) | 2026-11-17 | A316 | 0.0.147 | fix: a test name in a plan is a quoted string before the description dash, not a data value |
| [#310](https://github.com/furkansarikaya/proofline/pull/310) | 2026-11-17 | A317 | 0.0.148 | test: the FAILOVER scenario runs under the Codex worker profile: an in-process test helper, an at-kill snapshot, a scrubbed lead environment |
| [#311](https://github.com/furkansarikaya/proofline/pull/311) | 2026-11-17 | A318 | 0.0.149 | test: the COMPLEX scenario project sets its own mutation budget, so the run is not stopped by an approval the harness never gives |
| [#312](https://github.com/furkansarikaya/proofline/pull/312) | 2026-11-17 | A319 | 0.0.150 | fix: the plan's dash separator is found in the bytes the production path reads, so a quoted data value is not a test name |
| [#313](https://github.com/furkansarikaya/proofline/pull/313) | 2026-11-17 | A320 | 0.0.151 | test: the tests that call proc.mjs hand over the environment like an entry point, and a Linux test catches the break the Windows legs found |

## Real-session smoke test

`node tests/real-session/smoke.mjs` drives a real Claude Code session with a cheap model through `/proofline run`, `deliver` and a two-task `batch` in a throwaway repository (CONTRIBUTING; A195). It calls a model, so it is not part of CI; a pull request that changes hooks, skills, roles or the control plane pastes its table.

For [PR #293](https://github.com/furkansarikaya/proofline/pull/293) the final table has 12 rows, all PASS (haiku, 0.0.131). The first smoke of that change failed: the new rule refused the report here-documents of review roles, which parked batch task T-3 (A293, "HERE-DOCUMENT HANDLING"). The fix was re-reviewed by independent security reviews, which found the first fix too loose before it merged.

The first smoke of [PR #312](https://github.com/furkansarikaya/proofline/pull/312) failed its batch part (958 s, over the 900 s step cap); the second run passed. The cause class, a scratch worktree of a QA role that blocks CODE_DONE, and the maintainer's count of five batch failures in about 30 batch runs are recorded as A323.4 (the figures are quoted from the maintainer's notes, not re-derived here).

## End-to-end team runs

The end-to-end scenarios run a real lead and real specialists in a copy of a small project (`tests/e2e/README.md`). Each run is scored by an independent evaluator session against expected files in the repository. The campaign of 2026-11-16 and 2026-11-17 ran every scenario on 6830eae6 (0.0.141) and re-ran four of them (STANDARD.tr, CRITICAL, FAILOVER, COMPLEX) on later commits; the table that follows is that campaign. After it, all six scenarios were run on the final main, 900c2852 (0.0.151), TRIVIAL and STANDARD twice. The latest run of each scenario in the campaign, by the evaluator's own verdict line:

The final pass on 900c2852 (no product change between its runs; the evaluator's own verdict lines; run directories and evaluation files are on the maintainer's machine, the per-run table with classes is in [tests/e2e/README.md](../tests/e2e/README.md), section "The final pass on main 900c2852"):

| Run on 900c2852 | Verdict | Capabilities |
|---|---|---|
| TRIVIAL run 1 | FAIL, invariant 14/30 (the lead asked "reply yes" under A169 and nothing ran; model, A324.2) | FAIL 2/4 |
| TRIVIAL run 2 | PASS, invariant 33/33 | PASS 5/5 |
| STANDARD run 1 | FAIL, invariant 29/36 (stopped at REVIEW_TESTS on a plan-named test with no recorded duration; A324.1) | PASS 4/4 |
| STANDARD run 2 | FAIL, invariant 36/37 (S-6 only; whole lifecycle to DONE) | PASS 4/4 |
| STANDARD.tr | FAIL, invariant 43/44 (S-6 only; DONE) | PASS 4/4 |
| CRITICAL | FAIL, invariant 31/34 (K-2; K-5 and K-6 because `accept AS-2` is a user-only approval; A322.8) | PASS 4/4 |
| COMPLEX | FAIL, invariant 30/37 (stopped at REVIEW_TESTS on two waiver requests; A323.3, A324.1, A322.8) | FAIL 5/6 |
| FAILOVER (mixed) | FAIL, invariant 48/48, quality 0/1 (F-9; DONE with all 7 gates) | PASS 4/4 |

A later PASS does not erase an earlier FAIL: TRIVIAL passed once and failed once on the same commit, and no scenario passed every item in every run there. The pass found no new security or approval defect and loosened nothing; five findings are recorded and not changed in A324.

Four COMPLEX runs ended at stops that only the user may answer (the plan and scope requests of a refreeze after three failed reviews, a mutation-budget request, a scope request, an assumption acceptance); a complete COMPLEX run to DONE is not demonstrated by this campaign. The per-run table, the classes of the unmet items (product, model, harness) and the fixes (PRs #305, #306, #310, #311, #312; A312, A313, A317, A318, A319) are in [tests/e2e/README.md](../tests/e2e/README.md); the accepted limits are A322 and A323 in [limits](limits.md).

## CI legs

The workflow is [`.github/workflows/ci.yml`](../.github/workflows/ci.yml); the rules are in [CONTRIBUTING](../CONTRIBUTING.md) (A164, A250, A272, A295).

| Platform | When it runs | Latest result checked |
|---|---|---|
| Linux (ubuntu-latest) | every push and pull request | run 44051436515 (push, 8f84d850), success; run 44063481112 (push, ed7a0e31), success |
| macOS (macos-latest) | nightly and manual runs: `static`, `fixtures`, `visual-browser` | dispatch run 44054247041 (8f84d850): static 211 s, fixtures 230 s, visual-browser 59 s, all success; nightly 44009657772 (2026-11-17): the three macOS jobs success |
| Windows (windows-latest) | `hook-windows` nightly, manual and on pull requests that touch path, hook or guard code; `windows-core` (4 core shards and the invariants) nightly and manual | see "Windows runs of the whole matrix" below |

Read this honestly. The scheduled run of 2026-11-17 03:21 UTC (run 44009657772, on a3b2bb91, the merge of A315) was red on `windows-core` shards 1, 3 and 4 of 4; the one of 2026-11-16 03:25 UTC (run 43798071190) was red on Windows (`hook-windows` and `windows-core` shard 4 of 4), and the one of 2026-11-15 (run 43672011273) was red on `windows-core` shard 1 of 4. `hook-windows` was green in the scheduled runs of 2026-11-12, 11-13 and 11-14 (43147679229, 43358460249, 43551134283) and went red after A278 (A292). Windows is therefore tested but not a supported platform (CONTRIBUTING: proofline is supported on macOS and Linux).

### Windows runs of the whole matrix (manual dispatch, `workflow_dispatch`)

| Run | Commit (version) | `hook-windows` | `windows-core` 1/4 | 2/4 | 3/4 | 4/4 | invariants | Whole run |
|---|---|---|---|---|---|---|---|---|
| [43933981728](https://github.com/furkansarikaya/proofline/actions/runs/43933981728) | 6830eae6 (0.0.141) | 3 m 25 s, success | 30 m 21 s, success | 21 m 30 s, success | 13 m 46 s, success | 13 m 26 s, success | 1 m 52 s, success | failure: the Linux job `node-tests (22.13.0, port-rig-b)` failed because 6 port-rig tests exceeded their 7000 ms duration budget (7.2 to 8.2 s; `test-durations-ci: 6 test(s) ... over budget` in `tests/core/port-t3-rig.mjs`, rig stage 2 parts 4 to 6), fixed by A311 (PR #304); `checks` failed as a consequence |
| [44054247041](https://github.com/furkansarikaya/proofline/actions/runs/44054247041) | 8f84d850 (0.0.150) | 161 s, success | 2002 s, failure | 898 s, success | 1163 s, failure | 1138 s, failure | 124 s, success | failure: only the three Windows shards (every Linux, macOS and `checks` job succeeded) |
| [44063495839](https://github.com/furkansarikaya/proofline/actions/runs/44063495839) | ed7a0e31 (0.0.151) | 3 m 13 s, success | 33 m 38 s, success | 15 m 53 s, success | 17 m 13 s, success | 23 m 22 s, success | 1 m 37 s, success | success (every job, including the Linux `port-rig-b` legs, the macOS jobs and `checks`) |

Of the first two runs, only the first had all six Windows jobs passing, and it predates A315. The second run (44054247041, on 8f84d850) failed `windows-core` 1/4, 3/4 and 4/4 because of A315 (0.0.146), which broke four test files and a stdin regression test on Windows; A320 (0.0.151, PR #313) repaired the files and added a Linux test with a win32 stub, `tests/core/proc-win-smoke.test.mjs`, that catches that class on pull requests. The third run is the dispatch on ed7a0e31, the commit that holds the repair: it ended with overall conclusion success and every Windows job passed (the push run 44063481112 of the same commit is also success). Also on record: a dispatch run on the branch `fix/windows-core-main` (43907888898, 2026-11-16 16:28 UTC) with every Windows job green, on a reduced run (shards 21 to 193 s; the `tests` input is not recorded), so it is not a whole-matrix run. This is one green run of the whole matrix on Windows at a commit that contains A315 and A320; the nightly history above is red until then, so it is not a record of stability.

## Ecosystems: what was run against a real tool

The ecosystem matrix ([ecosystems.md](concepts/ecosystems.md#ecosystem-matrix)) labels every touch point as `real tool`, `docs` or `code reading only`. `control-plane/agents/ecosystems.json` defines ten ecosystems (npm, Python, Go, JVM, Cargo, .NET, PHP, Ruby, Swift, Dart). Captured runs of the real tool, on the maintainer's machine (the page dates them 2026-10-25, and 2026-11-15 for jest and pytest), cover test-output recognition for node:test, bun test, vitest, jest, tsc, unittest, pytest, go test, Minitest, test-unit, swift test and the .NET SDK with its four test frameworks. Mocha, Maven, Gradle, JUnit, cargo, PHPUnit, RSpec, dart and flutter test are from documentation only. Command discovery, risky paths and dependency manifests are checked by code reading and hand-written project layouts.

## What this does not prove

- That proofline works on your project. The status of the release is "not yet proven on real projects" (README, CHANGELOG).
- That a model's code is correct. Gates check evidence and rules; report wording, plan details and code quality stay model-dependent ([enforcement layers](concepts/enforcement-layers.md#what-is-guaranteed)).
- That the end-to-end team runs are current. In the campaign of 2026-11-16 and 2026-11-17 the newest run of each scenario is a FAIL except STANDARD, which passes only against the expectations of A310 (the same run failed 5 items against the old ones); the unmet items are model behaviour (TRIVIAL, STANDARD.tr, CRITICAL), product documentation gaps (FAILOVER) and harness limits (COMPLEX), each accepted in A322, and a complete COMPLEX run to DONE is not demonstrated. On the final `main`, 900c2852, all six scenarios ran once more: TRIVIAL passed 33/33 in its second run and failed 14/30 in its first, and every other scenario's newest run is a FAIL (see "The final pass on main 900c2852" in [tests/e2e/README.md](../tests/e2e/README.md)).
- That Codex works in every role. Only the implementer role is verified in real use (2026-10-23 to 25); the other Codex roles are not.
- That Jira, Linear, `glab` and `az` work: they were tried against fakes only ([workflow](concepts/workflow.md#not-tried)).
- That Windows is supported, or that the Windows legs are green today: every Windows job passed in a whole-matrix dispatch run before A315 (43933981728 on 6830eae6; a reduced run on a branch, 43907888898, was also green), three `windows-core` shards failed after A315 (nightly 44009657772, dispatch 44054247041), and the dispatch run on ed7a0e31 (44063495839, after A320) passed every Windows job once (see CI legs above).
- That the hooks stop a determined adversary. The runtime hooks and the review-role tripwire are tripwires for honest mistakes with named gaps; the boundaries are the git hooks and branch protection. Each accepted limit is listed with its reason on [limits](limits.md).
- That the speed-ups are the same on your machine. They are local measurements on one maintainer machine.
- That the real-session smoke test passes on every change: it is run by hand per pull request and costs model time; this page quotes one table.
- That counted tests are all meaningful: test count measures size, not assurance, and the records above name tests that were found vacuous.
