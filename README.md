# proofline

> **Status 0.0.1: control plane and enforcement are tested; end-to-end team runs do not pass yet.**
> See the [end-to-end results table](tests/e2e/README.md#results-for-001-2026-10-09).

**No evidence, no claim.** A deterministic engineering team for coding agents: nothing is "done" because a model said so.

## What it is

- A **lead** (your main agent session) runs one deterministic lifecycle per task: classify, freeze a plan, dispatch, gate, report, stop before delivery.
- Eleven **roles** (lead, task author, explorer, architect, data architect, designer, QA, implementer, reviewer, security reviewer, verifier). Only the lead dispatches; specialists never spawn agents.
- Seventeen method **skills** plus the `/proofline` command entry skill, each usable on its own, each producing runnable or traceable evidence.
- Independent **gates** (secrets, reviews, security, QA, verify) judged by scripts on the exact content, never by the lead.
- **Risk signals** (contract, migration, UI, dependency and config paths, plan flags) add focused checks inside those gates, chosen by script; tested by the control-plane self-tests and the `risk-signals` fixture. The contract, concurrency, performance and visual focuses have no skill yet; they report UNSUPPORTED, which is never a pass and only the user can waive. The migration focus is data-design's migration validation (throwaway database of the project's own test suite, otherwise UNSUPPORTED); its helpers and report validator are tested by the `migration-validation` fixture and `tests/skills`.
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

What was actually tested for 0.0.1 (details in [tests/e2e/README.md](tests/e2e/README.md)). "Tested" means the
self-tests and enforcement tests pass; the end-to-end column reports the independent evaluator's verdict against the
known-answer EXPECTED files, which no run has fully met yet.

| Platform / configuration | Tier | Self-tests + enforcement | End-to-end team runs |
|---|---|---|---|
| Claude Code, Claude-only team | Full | tested (incl. one live headless hook test) | tested, partial: 6 scenarios, 75–94 % of expectations met, 0 fully passing |
| Codex CLI, Codex-only team | Full | tested (hooks, dispatch, agents rendered) | partially tested: TRIVIAL only, did not complete |
| Claude lead + Codex worker | Full | tested with fake runtimes | not tested |
| Lead failover (Claude → Codex `resume`) | Full | `agent.sh next` / dispatch failover tested with fake runtimes | not tested |
| Any `AGENTS.md` agent (standalone topology) | Protocol | control plane + git hooks tested | not tested |
| Any headless CLI as worker (command template) | Worker | tested with a fake command | not tested |
| Task adapters: markdown, GitHub Issues | — | tested (GitHub via a fake `gh`) | markdown used in every run |
| Task adapters: Jira, Linear | — | not tested (argument checks only) | not tested |
| Windows | — | not tested (use WSL or Git Bash) | not tested |

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

- Concepts: [workflow](docs/concepts/workflow.md), [roles](docs/concepts/roles.md), [gates](docs/concepts/gates.md), [failover](docs/concepts/failover.md), [enforcement layers](docs/concepts/enforcement-layers.md)
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
