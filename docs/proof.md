# Proof, not promises

This page collects the measured facts behind proofline's claims, each with the place where you can check it, and ends with what these facts do not prove. It follows the project's own rule: no evidence, no claim. Figures were taken on 2026-11-16 at proofline 0.0.135 (`main` at 03c110a0).

Where a number comes from a decision record, the record is named by its number (`A<n>` in [decisions.md](decisions.md)); "local" means measured on the maintainer's machine, often under load, not on CI.

## The suite and what counts as a test

One CI run of `main` for commit 03c110a0 ([run 43883302769](https://github.com/furkansarikaya/proofline/actions/runs/43883302769), push, success) wrote one duration report per test step (133 `test-durations-*` artifacts, produced by `tests/ci/test-durations-ci.mjs`). A report counts leaf tests; suites are not counted. Summed over the reports of the Node 22.13.0 steps (the `static` job ran Node 22.23.4):

| Job | Reports | Test results |
|---|---:|---:|
| `node-tests` | 61 | 3,436 |
| `hook-node` (1 job) | 7 | 1,165 |
| `static` (1 job: suite, generator, benchmark) | 3 | 1,100 |
| `invariants` (8 jobs, one per scenario; the context-budget tests run inside one of them) | 9 | 22 |
| Total test results | | 5,723 |

The `node-tests` and `hook-node` legs also run on the `lts/*` Node release with the same counts (3,436 and 1,165); those are not added again.

The total is test results, not distinct tests: a few files run in two jobs (for example the hook guards and wiring tests in both `hook-node` and `node-tests`, the context-budget tests, and the invariant scenarios, which are also inside `node-tests`). Per file, taking the largest count among the job kinds gives about 5,550 distinct tests (5,547 by that method, 176 results counted twice; it is a computation on the artifacts, not a number the CI prints). No job failed; `fixtures`, `types` and `static` were green, and the Windows and browser legs were skipped, as they are on a push ([workflow](../.github/workflows/ci.yml)).

## Decisions on record

- `docs/decisions.md` holds 296 numbered decisions, A1 to A297 with one number skipped, counted with `grep -c '^- \*\*A[0-9]\+\.'`. Each states what changed and why; 192 of the decision lines also contain the word "rejected" (`grep '^- \*\*A[0-9]*\.' docs/decisions.md | grep -ci rejected`; it counts the word, so a few of them use it for something other than a list of discarded alternatives). Every behaviour change is a decision ([CONTRIBUTING](../CONTRIBUTING.md)). The records below show what the reviews found:

- **A284 (a change to test exceptions at a refreeze), five security review rounds** (CHANGELOG entries "A284, review round 1" to "round 5"). Round 1 found a ledger-row injection: a free-text reason ending in a forged row could be read as a genuine baseline, so no approval was asked and a refreeze passed. It was fixed at the reader and at the writer. Round 2 found the same class in the readers of gate, waiver and approval bindings. Tests inj-1, inj-2 and inj-6 cover them; the record states that inj-6 fails before its fix.
- **A292 (Windows hook tests):** a "safe fs layer" built in a review round was removed after the security review showed that its own error was turned into an ALLOW when no run was active, which let a lead write product files the hook would deny; the proof of concept was reproduced. The existing hook wrapper already fails closed, so the layer was dropped (A292, "REVIEW HISTORY").
- **A293 (review and security roles never push):** four security rounds found bypasses that were closed class by class. The result is stated as a tripwire for honest mistakes, not a boundary against a determined agent; the real boundaries are named (branch protection and the git pre-push hook). The test matrix `tests/hook/readonly-git-cases.mjs` has 487 rows (324 deny, 163 allow), counted from the file at 03c110a0. The record itself quotes 440 rows (290 and 150) from an earlier state of the matrix.

## Real-session smoke test

`node tests/real-session/smoke.mjs` drives a real Claude Code session with a cheap model through `/proofline run`, `deliver` and a two-task `batch` in a throwaway repository (CONTRIBUTING; A195). It calls a model, so it is not part of CI; a pull request that changes hooks, skills, roles or the control plane pastes its table.

For [PR #293](https://github.com/furkansarikaya/proofline/pull/293) the final table has 12 rows, all PASS (haiku, 0.0.131). The first smoke of that change failed: the new rule refused the report here-documents of review roles, which parked batch task T-3 (A293, "HERE-DOCUMENT HANDLING"). The fix was re-reviewed by independent security reviews, which found the first fix too loose before it merged.

## CI legs

The workflow is [`.github/workflows/ci.yml`](../.github/workflows/ci.yml); the rules are in [CONTRIBUTING](../CONTRIBUTING.md) (A164, A250, A272, A295).

| Platform | When it runs | Latest result checked |
|---|---|---|
| Linux (ubuntu-latest) | every push and pull request | run 43883302769, success |
| macOS (macos-latest) | nightly and manual runs: `static`, `fixtures`, `visual-browser` | scheduled run 43798071190 (2026-11-16): these three macOS jobs success |
| Windows (windows-latest) | `hook-windows` nightly, manual and on pull requests that touch path, hook or guard code; `windows-core` (4 core shards and the invariants) nightly and manual | manual run 43832888807 (branch fix/win-hook-a278, `tests` input = tests/hook): `hook-windows` and the `windows-core` legs passed on the hook tests only; the full core suite on Windows is last on record in the scheduled runs 43672011273 and 43798071190, both red |

Read this honestly. The scheduled run of 2026-11-16 03:25 UTC (run 43798071190) was red on Windows (`hook-windows` and `windows-core` shard 4 of 4), and the one of 2026-11-15 (run 43672011273) was red on `windows-core` shard 1 of 4. `hook-windows` was green in the scheduled runs of 2026-11-12, 11-13 and 11-14 (43147679229, 43358460249, 43551134283) and went red after A278 (A292). A292 repaired the hook leg afterwards; no scheduled run has happened since, so a green scheduled run on all three platforms is not yet on record. Windows is therefore tested but not a supported platform (CONTRIBUTING: proofline is supported on macOS and Linux).

## Ecosystems: what was run against a real tool

The ecosystem matrix ([ecosystems.md](concepts/ecosystems.md#ecosystem-matrix)) labels every touch point as `real tool`, `docs` or `code reading only`. `control-plane/agents/ecosystems.json` defines ten ecosystems (npm, Python, Go, JVM, Cargo, .NET, PHP, Ruby, Swift, Dart). Captured runs of the real tool, on the maintainer's machine (the page dates them 2026-10-25, and 2026-11-15 for jest and pytest), cover test-output recognition for node:test, bun test, vitest, jest, tsc, unittest, pytest, go test, Minitest, test-unit, swift test and the .NET SDK with its four test frameworks. Mocha, Maven, Gradle, JUnit, cargo, PHPUnit, RSpec, dart and flutter test are from documentation only. Command discovery, risky paths and dependency manifests are checked by code reading and hand-written project layouts.

## What this does not prove

- That proofline works on your project. The status of the release is "not yet proven on real projects" (README, CHANGELOG).
- That a model's code is correct. Gates check evidence and rules; report wording, plan details and code quality stay model-dependent ([enforcement layers](concepts/enforcement-layers.md#what-is-guaranteed)).
- That the end-to-end team runs are current. Each scenario last passed between 2026-10-14 and 2026-10-17, and in the newest round (2026-10-17) every scenario failed one to five items, fixed since but not re-run; none has run on the present `main` ([tests/e2e/README.md](../tests/e2e/README.md)).
- That Codex works in every role. Only the implementer role is verified in real use (2026-10-23 to 25); the other Codex roles are not.
- That Jira, Linear, `glab` and `az` work: they were tried against fakes only ([workflow](concepts/workflow.md#not-tried)).
- That Windows is supported, or that the nightly Windows legs are green today (see CI legs above).
- That the hooks stop a determined adversary. The runtime hooks and the review-role tripwire are tripwires for honest mistakes with named gaps; the boundaries are the git hooks and branch protection.
- That the speed-ups are the same on your machine. They are local measurements on one maintainer machine.
- That the real-session smoke test passes on every change: it is run by hand per pull request and costs model time; this page quotes one table.
- That counted tests are all meaningful: test count measures size, not assurance, and the records above name tests that were found vacuous.
