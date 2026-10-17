# proofline

> **Status 0.0.1: the control plane and enforcement are tested; every Claude-only end-to-end scenario has passed at least once, but none has been verified on the current `main`.**
> See [Support levels](#support-levels) and the [end-to-end results](tests/e2e/README.md#current-results).

**No evidence, no claim.** A deterministic engineering team for coding agents: nothing is "done" because a model said so.

## What it is

- A **lead** (your main agent session) runs one deterministic lifecycle per task: classify, freeze a plan, dispatch, gate, report, stop before delivery.
- Eleven **roles** (lead, task author, explorer, architect, data architect, designer, QA, implementer, reviewer, security reviewer, verifier). Only the lead dispatches; specialists never spawn agents.
- Twenty-one method **skills** plus the `/proofline` command entry skill, each usable on its own, each producing runnable or traceable evidence.
- Independent **gates** (secrets, reviews, security, QA, verify) judged by scripts on the exact content, never by the lead.
- **Risk signals** (contract, migration, UI, dependency and config paths, plan flags) add focused checks inside those gates, chosen by script; tested by the control-plane self-tests and the `risk-signals` fixture. The `dependencies` focus (manifest diff, license policy, the project's own audit tool when it exists; fixture `dependency-audit`) and the `config` focus (fixture `config-consistency`) have tool-free checks. The `concurrency` focus runs the concurrency-proof skill (tested: skill tests and the `concurrency-proof` fixture). The migration focus is data-design's migration validation (throwaway database of the project's own test suite, otherwise UNSUPPORTED); its helpers and report validator are tested by the `migration-validation` fixture and `tests/skills`. The QA `visual` focus runs the `visual-proof` skill (measured checks in a browser the machine or project already has; without one UNSUPPORTED): its report validator and depth rules are tested in every pull request, and the browser measurement of its fixture is run by a main/nightly CI step and is UNSUPPORTED where no browser is found. The `performance` focus runs the performance-proof skill (base against change with the project's own benchmark, interleaved runs, median and bootstrap interval; noise is INCONCLUSIVE, never a FAIL or a pass); its decision rule, validator and runner are tested by the `performance-proof` fixture and `tests/skills`, not on a real benchmark in CI. The `contract` focus runs contract-proof (tested: skill tests and the `contract-proof` fixture). Every risk focus now has its skill; a check that cannot run reports UNSUPPORTED, which is never a pass: by default it is unproven and reported (listed in the completion report with what it leaves unproven, the gate is not held), `risk.unsupported: block` makes it a blocking finding only the user can waive, and an INCONCLUSIVE measurement always blocks. An UNSUPPORTED result must cite the skill validator's own saved output, and the script cross-checks it against the contract and migration files it detected in the diff, so a reason line alone never skips a check (tested by the control-plane self-tests with the skills' real validator output).
- **Enforcement** lives in `agent.sh` and git hooks, so it works with any agent; runtime hooks only block earlier.
- Runs on Claude Code and Codex; any agent that reads `AGENTS.md` and runs shell commands gets the protocol tier.

## Install

**Claude Code (plugin marketplace)**

```text
/plugin marketplace add furkansarikaya/proofline
/plugin install proofline@proofline
```

Then, in your project (a git repository): `proofline init` (or `/proofline init` inside Claude Code).

**Codex / terminal**

```sh
git clone https://github.com/furkansarikaya/proofline
proofline/adapters/codex/install.sh        # links bin/proofline onto your PATH; options: --dir DIR, --yes
cd your-project && proofline init
```

**Skills only** (no team, no enforcement):

```sh
npx skills add furkansarikaya/proofline --skill <name>
```

Windows: use WSL or Git Bash (the control plane is POSIX `sh`).

## Support levels

What was actually tested for 0.0.1 (details, dates and every run in [tests/e2e/README.md](tests/e2e/README.md#current-results)).
"Tested" means the self-tests and enforcement tests pass. "Passed" in the end-to-end column means the independent
evaluator's verdict `E2E: PASS` against the known-answer EXPECTED files; the date is the run's date and the
commit is the `main` commit it ran on. Only a scenario verified on the current `main` may be called plainly
"passing": **none is** (the current `main` is `de4efd8`, A132; the last runs are older). "Not re-verified after" lists
the decisions in [docs/decisions.md](docs/decisions.md) merged after the run (A109, A121, A128 and A131 changed only CI, the e2e harness or tests; A100 (harness plus a `none` step in the shipped Codex effort ladder), A110 (a CI job plus the visual-proof measure script), A117, A118 and A125 are mixed; the rest changed the control plane, the hooks or the skills).

| Platform / configuration | Tier | Self-tests + enforcement | End-to-end team runs |
|---|---|---|---|
| Claude Code, Claude-only team, TRIVIAL | Full | tested (incl. one live headless hook test) | passed on 2026-10-16 (`7eeeeb4`), not re-verified after A121 to A132; latest run 2026-10-17 (`9e70f03`): FAIL 35/36, report accuracy (C-22), addressed by A130, not re-run |
| Claude Code, Claude-only team, STANDARD | Full | tested | passed on 2026-10-14 (`b515110`), not re-verified after A99 to A132; latest runs 2026-10-16 (`7eeeeb4`) and 2026-10-17 (`9e70f03`): FAIL 35/36 each (missing debug report, then report accuracy), addressed by A122 and A130, not re-run |
| Claude Code, Claude-only team, STANDARD.tr (Turkish chat, English files) | Full | tested | passed on 2026-10-17 (`f75d1f5`, twice in a row), not re-verified after A126 to A132; latest run 2026-10-17 (`9e70f03`): FAIL 40/41, report accuracy (C-22), addressed by A130, not re-run |
| Claude Code, Claude-only team, COMPLEX | Full | tested | passed on 2026-10-17 (`128e516`), not re-verified after A129 to A132; it failed in 9 other runs of the campaign and one model-behaviour item (the accuracy of the lead's report) still differs run to run; latest run 2026-10-17 (`9e70f03`): FAIL 37/39 (report accuracy; two parallel explorers shared a scratch file), addressed by A130 and A132, not re-run |
| Claude Code, Claude-only team, CRITICAL | Full | tested | passed on 2026-10-14 (`b515110`), not re-verified after A99 to A132; latest run 2026-10-17 (`9e70f03`): FAIL 30/35 (the scripted harness reply steered the interview to the non-destructive option, so the destructive stop was never reached), addressed in the harness by A131, not re-run |
| Codex CLI, Codex-only team | Full | tested (hooks, dispatch, agents rendered) | partially tested: dispatch of a worker, sandbox, `submit` and the doctor and hook probes passed (cheapest model, a few calls); the scored TRIVIAL run failed (26/43, 2026-10-14) and no other scenario was run |
| Claude lead + Codex worker (mixed) | Full | tested with fake runtimes | partially tested: TRIVIAL passed up to the commit-approval stop (an integration check, not a scored `E2E: PASS`); no scored scenario |
| Lead failover (Claude to Codex `resume`) | Full | `agent.sh next` / dispatch failover tested with fake runtimes | partially tested: resume, freshness, the dispatch of a headless Claude verifier, the in-flight `wait:` line and the single-status-file token were verified on `128e516` (2026-10-17), the route printed after a VERIFY failure only partly right (addressed by A127 and A129, not re-run); the run did not reach DONE (the cheap Codex lead stopped to ask for authorization in prose) |
| Any `AGENTS.md` agent (standalone topology) | Protocol | control plane + git hooks tested | not tested |
| Any headless CLI as worker (command template) | Worker | tested with a fake command | not tested |
| Task adapters: markdown, GitHub Issues | — | tested (GitHub via a fake `gh`) | markdown used in every run |
| Task adapters: Jira, Linear | — | not tested (argument checks only) | not tested |
| Windows | — | not tested (use WSL or Git Bash) | not tested |

Known limits, stated plainly: no scenario was re-run after A130 to A132; COMPLEX passed twice in 11 runs and is
not yet a stable result; the Codex checks used the cheapest model and never ran a full scenario. End-to-end items are
tagged invariant or quality, and C-14 allows 3 answers +1 per refreeze (A133); the results above predate both.

## Capabilities and what tests them

"Tested" below means a test that runs in CI (on every code pull request; documentation-only pull requests skip the test jobs) or in `sh tests/selftest.sh`. "Tested on fixtures" means the check is
exercised by planted data with known answers (`fixtures/*/EXPECTED.md`) and its validator or helper scripts. "End-to-end"
means an independent evaluator scored a team run that used the capability (`expected/CAPABILITIES.md`, the `N-`
items): in the runs listed in the e2e page (the regression round of 2026-10-17, COMPLEX `128e516`, STANDARD.tr `f75d1f5`, TRIVIAL `7eeeeb4`) every `N-` item was met or not applicable; other COMPLEX runs scored 5/6 with the visual focus (N-4) unmet. The capabilities marked "end-to-end" below were exercised by those team runs and the others were not. Details:
[tests/e2e/README.md](tests/e2e/README.md#capabilities-the-n--items).

| Capability | Status |
|---|---|
| Risk-adaptive pipeline (`agent.sh pipeline`, focuses inside the existing gates) | tested (control-plane self-tests, `risk-signals` fixture); end-to-end: signals and the checks they trigger listed in COMPLEX and CRITICAL runs (N-1) |
| Assumption register (`## Assumptions`, freeze stop, completion report) | tested (self-tests, plan and evidence validators); end-to-end: N-2 met in every scenario (the register was empty in TRIVIAL, STANDARD and STANDARD.tr); the COMPLEX completion reports list unverified assumptions |
| Metrics (`records.jsonl`) and `proofline insights` | tested (self-tests, CLI test, `insights` fixture); tokens only where a runtime reports them; end-to-end: records written, null tokens shown as `n/a`, `insights` read-only (N-3, N-6) |
| evidence-map `impact` mode | tested on fixtures (`impact-map`, skill tests); static analysis limits stated in every report; not exercised by a team run |
| ui-design (creative direction, UX comparison, self-critique, `visual_proof` criteria) | tested on fixtures (`ui-design`, skill tests); not scored in a team run |
| visual-proof, report validator and depth rules | tested (skill tests on every code pull request); end-to-end: the QA visual focus passed with a measured report in COMPLEX runs (N-4) |
| visual-proof, browser measurement | run by the main/nightly CI step (`fixtures/visual-proof/browser-check.sh`); UNSUPPORTED where no browser is found; end-to-end: measured in a real browser in COMPLEX runs |
| contract-proof | tested on fixtures (`contract-proof`, skill tests); compatibility tools of real projects not exercised; end-to-end: the contract focus ended UNSUPPORTED in COMPLEX, listed as not proven (in CRITICAL the signals and the checks they would trigger were listed, but the run stops before implementation) |
| concurrency-proof | tested on fixtures (`concurrency-proof`, skill tests); a concurrent reproduction in a real project's test runner not exercised; not exercised by a team run |
| performance-proof | tested on fixtures (`performance-proof`, skill tests); not run against a real benchmark in CI; not exercised by a team run |
| data-design migration validation | tested on fixtures (`migration-validation`, skill tests); applying migrations to a project's own throwaway database not exercised; end-to-end: the migration focus ended UNSUPPORTED in COMPLEX, listed as not proven |
| SECURITY `dependencies` and REVIEW `config` | tested on fixtures (`dependency-audit`, `config-consistency`); a project's own audit tool not exercised; not exercised by a team run |
| UNSUPPORTED reporting (A98, A102) and the database-unchanged check (A121) | tested (self-tests); end-to-end: reported in COMPLEX runs, database unchanged in every run from A121 on, where `db_unchanged=yes` is recorded (N-4, N-5) |
| Benchmark report (`tests/benchmark`) | tested (its own known-answer test on every code pull request; full report on main/nightly CI) |

Skills and roles are counted from `skills/` (twenty-two method skills plus the `/proofline` entry skill) and
`roles/` (eleven roles); `sh adapters/generate.sh --check` and `sh docs/reference/generate-skills.sh --check` keep
the generated references in step with them. Test counts on 2026-10-17: `sh tests/selftest.sh` 16 suites with over 145
units; `node --test tests/skills/` 737 tests (734 pass, 3 skipped); `sh tests/fixtures/check-fixtures.sh` 42 passed,
1 skipped. A pull request takes about 8 minutes of wall time in CI (Linux only; A109).

## Quick start (5 minutes)

```sh
cd your-project
proofline init            # asks runtimes, profile, task adapter, protected branches, push approval
proofline doctor          # live probes: hooks, runtimes, config, commit identity, every enforced rule
proofline insights        # later: cost and recurring failures across runs (read-only report)
```

Give the agent a task in plain words, or write it first:

```sh
proofline task --grill "Add rate limiting to the login endpoint"
proofline run TASK-001
```

What happens: the lead classifies the task (TRIVIAL to CRITICAL), creates a task branch, records a baseline, has
explorers gather evidence, writes `PLAN.md` with a `scope:` file list, freezes it, and dispatches one implementer
that must show RED then GREEN evidence. Gates then run in parallel on the exact content; a FAIL goes back to the
implementer for at most `max_fix_rounds` (default 2). You approve the plan for COMPLEX and CRITICAL tasks, and you
approve every commit and push. `proofline status` shows the next step at any time.

## Real output

The lead's final message from a real end-to-end run (STANDARD bug fix in the playground, Claude-only team,
headless, 2026-10-09), unedited:

```text
The pagination bug is fixed in the working tree. With your 12 sample books you should now see "Page 1 of 2" and an enabled Next button. `GET /api/books?page=2` should return the 2 oldest books, Dune and Neuromancer. Nothing is committed yet.

**Cause:** `paginate()` in `src/service.js` rounded the page count down, so 12 books at 10 per page counted as 1 page. Page 2 was then clamped back to page 1. At 20 books the count divides evenly, which is why that case worked.

**Fix:** it's a one-word change, `Math.floor` to `Math.ceil`, with the "at least 1 page" floor kept. Empty lists, exact multiples and "page past the end returns the last page" behave as before.

**Tests:** I added two to `tests/service.test.js`, one for the page maths and one that lists 12 books and checks page 2 returns 2. They failed before the fix and pass after it. `npm test` passes 16 of 16.

**Review:** the proofline gates (secret scan, review, verify) all passed, and the run is marked done. The reviewer traced rather than ran the revert-to-`floor` check, so its confidence was only medium. The implementer did run that check, and the new tests failed as expected.

**Not done:**
- **Branch:** the work is on branch `proofline/T-1-fix-pagination-dropping-last-partial-page`.
- **Commit:** nothing is committed or pushed. The workflow needs your explicit go-ahead for that, so tell me if you want me to commit.
- **Run cleanup:** I'll run the final cleanup once you've decided on delivery.
- **Task file:** `.agents/tasks/` is a new untracked folder holding the task file.
```

In that run the lead classified the task TRIVIAL instead of STANDARD (so no QA gate ran); the evaluator marked it
FAIL for that reason. See [tests/e2e/README.md](tests/e2e/README.md) for every run's result.

## Documentation

- Concepts: [workflow](docs/concepts/workflow.md), [roles](docs/concepts/roles.md), [gates](docs/concepts/gates.md), [evidence](docs/concepts/evidence.md), [metrics](docs/concepts/metrics.md), [failover](docs/concepts/failover.md), [enforcement layers](docs/concepts/enforcement-layers.md)
- Guides: [daily use](docs/guides/daily-use.md), [existing project](docs/guides/existing-project.md), [task templates](docs/guides/task-templates.md), [writing an adapter](docs/guides/writing-an-adapter.md), [prompt catalogue](docs/guides/prompt-catalogue.md)
- Turkish: [gunluk kullanim](docs/guides/tr/gunluk-kullanim.md), [prompt katalogu](docs/guides/tr/prompt-katalogu.md)
- Reference: [skills](docs/reference/skills.md), [roles](docs/reference/roles.md), [design decisions](docs/decisions.md)

## Community adapters

Other agents are added through small adapters. See [adapters/README.md](adapters/README.md) and
[writing an adapter](docs/guides/writing-an-adapter.md). Untested adapters must be labelled "not tested". PRs welcome.

## Status and license

Version **0.0.1**: full scope, not yet proven on real projects. Until 1.0.0, 0.0.x is fixes and 0.x.0 is new features or behaviour changes. See [CHANGELOG.md](CHANGELOG.md).

MIT License, 2026 Furkan SARIKAYA. See [LICENSE](LICENSE).

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md) to report a vulnerability.
