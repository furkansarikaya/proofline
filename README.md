# proofline

**No evidence, no claim.** A deterministic engineering team for coding agents: nothing is "done" because a model said so.

## What it is

- A **lead** (your main agent session) runs one deterministic lifecycle per task: classify, freeze a plan, dispatch, gate, report, stop before delivery.
- Eleven **roles** (lead, task author, explorer, architect, data architect, designer, QA, implementer, reviewer, security reviewer, verifier). Only the lead dispatches; specialists never spawn agents.
- Twenty-one method **skills** plus the `/proofline` command entry skill, each usable on its own, each producing runnable or traceable evidence.
- Independent **gates** (secrets, reviews, security, QA, verify) judged by scripts on the exact content, never by the lead.
- **Risk signals** (contract, migration, UI, dependency and config paths, plan flags) add focused checks inside those gates, chosen by script; tested by the control-plane self-tests and the `risk-signals` fixture. The `dependencies` focus (manifest diff, license policy, the project's own audit tool when it exists; fixture `dependency-audit`) and the `config` focus (fixture `config-consistency`) have tool-free checks. The `concurrency` focus runs the concurrency-proof skill (tested: skill tests and the `concurrency-proof` fixture). The migration focus is data-design's migration validation (throwaway database of the project's own test suite, otherwise UNSUPPORTED); its helpers and report validator are tested by the `migration-validation` fixture and `tests/skills`. The QA `visual` focus runs the `visual-proof` skill (measured checks in a browser the machine or project already has; without one UNSUPPORTED): its report validator and depth rules are tested in every pull request, and the browser measurement of its fixture is run by a main/nightly CI step and is UNSUPPORTED where no browser is found. The `performance` focus runs the performance-proof skill (base against change with the project's own benchmark, interleaved runs, median and bootstrap interval; noise is INCONCLUSIVE, never a FAIL or a pass); its decision rule, validator and runner are tested by the `performance-proof` fixture and `tests/skills`, not on a real benchmark in CI. The `contract` focus runs contract-proof (tested: skill tests and the `contract-proof` fixture). Every risk focus now has its skill; a check that cannot run reports UNSUPPORTED, which is never a pass: by default it is unproven and reported (listed in the completion report with what it leaves unproven, the gate is not held), `risk.unsupported: block` makes it a blocking finding only the user can waive, and an INCONCLUSIVE measurement always blocks. An UNSUPPORTED result must cite the skill validator's own saved output, and the script cross-checks it against the contract and migration files it detected in the diff, so a reason line alone never skips a check (tested by the control-plane self-tests with the skills' real validator output).
- **Enforcement** lives in `agent.sh` and git hooks, so it works with any agent; runtime hooks only block earlier.
- Claude Code is the primary runtime, Codex is experimental, and any agent that reads `AGENTS.md` and runs shell commands gets the protocol tier (see the [adapters](adapters/README.md)).

## Status

Version 0.0.1 is an early release.
Scripts and hooks enforce the guarantees: approvals, database safety, scope, evidence and cleanup.
More than 900 automated tests and enforcement tests check them.
Claude Code is the primary runtime.
Codex, mixed setups and failover are experimental.
Their integration checks passed, and the full team runs are still in progress.
[tests/e2e/README.md](tests/e2e/README.md) lists the detailed full-team results.

## What to expect from AI behaviour

- **Guaranteed:** approvals, database safety, scope, evidence and cleanup. Scripts and hooks refuse a step that breaks these rules. A run can still stop or fail before it finishes, and hook checks have documented limits.
- **Model-dependent:** report wording, plan details and code quality. These vary from run to run. The end-to-end runs measure them as a rate.
- **Valid differences:** two runs of the same task can differ, and both can be valid.
- **Lead model:** a cheap model can follow the route poorly, most of all as lead. Give the lead a base-level model. `exec-policy.sh check-lead` and the end-to-end harness refuse a Codex lead below the base model or without a model. `proofline doctor` fails on a resolved model below base, and only warns when it cannot resolve the model. No other runtime has a base model, so choose the lead model yourself.

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

## Capabilities and what tests them

"Tested" below means a test that runs in CI (on every code pull request; documentation-only pull requests skip the test jobs) or in `sh tests/selftest.sh`. "Tested on fixtures" means planted data with known answers (`fixtures/*/EXPECTED.md`) exercises the check, together with its validator or helper scripts. The end-to-end team runs and their results are in [tests/e2e/README.md](tests/e2e/README.md#capabilities-the-n--items).

| Capability | Status |
|---|---|
| Risk-adaptive pipeline (`agent.sh pipeline`, focuses inside the existing gates) | tested (control-plane self-tests, `risk-signals` fixture) |
| Assumption register (`## Assumptions`, freeze stop, completion report) | tested (self-tests, plan and evidence validators) |
| Metrics (`records.jsonl`) and `proofline insights` | tested (self-tests, CLI test, `insights` fixture); tokens only where a runtime reports them |
| evidence-map `impact` mode | tested on fixtures (`impact-map`, skill tests); static analysis limits stated in every report; not exercised by a team run |
| ui-design (creative direction, UX comparison, self-critique, `visual_proof` criteria) | tested on fixtures (`ui-design`, skill tests); not scored in a team run |
| visual-proof, report validator and depth rules | tested (skill tests on every code pull request) |
| visual-proof, browser measurement | run by the main/nightly CI step (`fixtures/visual-proof/browser-check.sh`); UNSUPPORTED where no browser is found |
| contract-proof | tested on fixtures (`contract-proof`, skill tests); compatibility tools of real projects not exercised |
| concurrency-proof | tested on fixtures (`concurrency-proof`, skill tests); a concurrent reproduction in a real project's test runner not exercised; not exercised by a team run |
| performance-proof | tested on fixtures (`performance-proof`, skill tests); not run against a real benchmark in CI; not exercised by a team run |
| data-design migration validation | tested on fixtures (`migration-validation`, skill tests); applying migrations to a project's own throwaway database not exercised |
| SECURITY `dependencies` and REVIEW `config` | tested on fixtures (`dependency-audit`, `config-consistency`); a project's own audit tool not exercised; not exercised by a team run |
| UNSUPPORTED reporting (A98, A102) and the database-unchanged check (A121) | tested (self-tests) |
| Benchmark report (`tests/benchmark`) | tested (its own known-answer test on every code pull request; full report on main/nightly CI) |

Skills and roles are counted from `skills/` (twenty-four method skills plus the `/proofline` entry skill) and
`roles/` (eleven roles); `sh adapters/generate.sh --check` and `sh docs/reference/generate-skills.sh --check` keep
the generated references in step with them. The self-tests (`sh tests/selftest.sh`), the skill tests (`node --test tests/skills/`) and the fixtures (`sh tests/fixtures/check-fixtures.sh`) hold more than 900 tests in all (counted 2026-10-17). A pull request takes about 8 minutes of wall time in CI (Linux only; A109).

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

The end-to-end results are in [tests/e2e/README.md](tests/e2e/README.md).

## Documentation

- Concepts: [workflow](docs/concepts/workflow.md), [roles](docs/concepts/roles.md), [gates](docs/concepts/gates.md), [evidence](docs/concepts/evidence.md), [metrics](docs/concepts/metrics.md), [failover](docs/concepts/failover.md), [enforcement layers](docs/concepts/enforcement-layers.md)
- Guides: [daily use](docs/guides/daily-use.md), [existing project](docs/guides/existing-project.md), [task templates](docs/guides/task-templates.md), [writing an adapter](docs/guides/writing-an-adapter.md), [prompt catalogue](docs/guides/prompt-catalogue.md)
- Turkish: [gunluk kullanim](docs/guides/tr/gunluk-kullanim.md), [prompt katalogu](docs/guides/tr/prompt-katalogu.md)
- Reference: [skills](docs/reference/skills.md), [roles](docs/reference/roles.md), [design decisions](docs/decisions.md)

## Community adapters

Other agents are added through small adapters. See [adapters/README.md](adapters/README.md) and
[writing an adapter](docs/guides/writing-an-adapter.md). Untested adapters must be labelled "not tested". PRs welcome.

## Versioning and license

Version **0.0.1**: full scope, not yet proven on real projects. Until 1.0.0, 0.0.x is fixes and 0.x.0 is new features or behaviour changes. See [CHANGELOG.md](CHANGELOG.md).

MIT License, 2026 Furkan SARIKAYA. See [LICENSE](LICENSE).

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md) to report a vulnerability.
