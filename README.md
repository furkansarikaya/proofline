# proofline

**No evidence, no claim.** A deterministic engineering team for coding agents: nothing is "done" because a model said so.

## What it is

- A **lead** (your main agent session) runs one deterministic lifecycle per task: classify, freeze a plan, dispatch, gate, report, stop before delivery.
- Eleven **roles** (lead, task author, explorer, architect, data architect, designer, QA, implementer, reviewer, security reviewer, verifier). Only the lead dispatches; specialists never spawn agents.
- Twenty-four method **skills** plus the `/proofline` command entry skill, each usable on its own, each producing runnable or traceable evidence.
- Independent **gates** (secrets, reviews, security, QA, verify) judged by scripts on the exact content, never by the lead.
- **Risk signals** (contract, migration, UI, dependency and config paths, plan flags) add focused checks inside those gates, chosen by script. A check that cannot run is reported UNSUPPORTED and never counts as a pass. [Testing](docs/concepts/testing.md) lists what tests each check.
- **Enforcement** lives in `agent.sh` and git hooks, so it works with any agent; runtime hooks only block earlier.
- Claude Code is the primary runtime, Codex is experimental, and any agent that reads `AGENTS.md` and runs shell commands gets the protocol tier (see the [adapters](adapters/README.md)).
- proofline works alongside skills specific to your ecosystem; the gates verify the result regardless of which skill produced it.

## Status

Version 0.0.16 is an early release.
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

## Quick start (5 minutes)

```sh
cd your-project
proofline init            # asks runtimes, profile, task adapter, protected branches, push approval
proofline doctor          # live probes: hooks, runtimes, config, commit identity, every enforced rule
proofline insights        # later: cost and recurring failures across runs (read-only report)
```

Run a role on another runtime with `proofline init --role implementer=codex` (repeatable; sets `runtime.roles.<role>`).

- **Wiki:** there is no on/off setting. Start it with `/proofline wiki ingest README.md`.
- **Codex:** open Codex once in the project folder and approve the hooks with `/hooks`. Without this, the Codex-side protections do not run. `proofline doctor` shows a warning about it when Codex is a runtime, because it cannot check the approval itself.

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

Pushes from visual git clients (VS Code, GitHub Desktop) work: the hooks tell an agent session from a person by the session's environment markers, not by a terminal.

## Commands

`proofline <command>` in a terminal, `/proofline <command>` in an agent session. `proofline help` prints the same list.

```text
init, upgrade, doctor, version        install, update, verify, version
status, resume, queue                 state of the active run, the task queue
task, design, docs, explain           write a task, design documents, documentation, an explanation page
run <TASK>                            take a task through the whole workflow
review, audit, debug                  proof-review, test-trust and debug-proof standalone
wiki ingest|query|lint                keep the project wiki in docs/wiki/
knowledge <TASK>                      knowledge step of a finished run
reopen <TASK>                         take a FAILED or BLOCKED run back into the workflow, with your approval
deliver <TASK>                        commit, push, pull request, merge and cleanup after one approval
batch <ID...|all>                     night mode: one approval of one summary for several tasks; batch run, batch status
debt                                  list the shortcut comments in the code (read-only, needs no run)
clean, merge, insights                clean up, the only allowed merge, cost and recurring failures
```

**Night mode.** `/proofline batch <ID...|all>` orders the listed tasks by `depends_on` and shows one summary: the order, what the approval covers, what it does not, and the tasks left out (CRITICAL or unclassified tasks, and tasks that depend on them). Your one reply "approve batch" is bound to that summary. `proofline batch run` then works through the tasks one at a time, each in a clean headless lead session, and the summary's approval stands in for the plan approval, the delivery approval (commit, push, pull request, merge only when CI is green and every gate passed, cleanup) and a mutation budget raise up to `batch.mutation_budget_cap`. A waiver, a scope expansion, a new dependency, a reopen, a destructive data change, a rule promotion, sending the friction report and a new fix-round budget are never covered: the task is parked with its question, tasks that depend on it are skipped, and the next independent task still runs. The driver stops when main CI is red, when every runtime hit its usage limit, or when a runtime is not logged in. `proofline batch status` is the morning table, generated from records only. Known limits: markdown task files only, and the headless session runs with the permission mode of `dispatch.claude_permission_mode` (the PreToolUse hook confines it).

**Shortcut debt.** When the implementer cuts a corner on purpose, it marks the code with a comment `shortcut: <limit>, <when to improve>`. `proofline debt` lists those comments with `file:line`, limit and improvement condition. The knowledge step writes the same list to one wiki page. A removed shortcut drops off it.

**Observations.** The implementer lists issues it saw but did not touch because they are out of scope. The knowledge step proposes them to you as new tasks and writes a task only after you approve it.

**Unrelated changes.** The plan review fails a change inside the scope that alters behaviour but serves no acceptance criterion. Formatting, comments and import order only produce a note.

**Processes.** An agent stops only a process it started itself, by its own PID. `pkill`, `killall`, `kill` by pattern (`kill $(pgrep ...)`, `pgrep ... | xargs kill`) and mass kills (`kill -1`) are denied by the runtime hook for the agents' tool calls; commands you type yourself are not affected.

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

- Concepts: [workflow](docs/concepts/workflow.md), [roles](docs/concepts/roles.md), [gates](docs/concepts/gates.md), [evidence](docs/concepts/evidence.md), [metrics](docs/concepts/metrics.md), [failover](docs/concepts/failover.md), [enforcement layers](docs/concepts/enforcement-layers.md), [testing](docs/concepts/testing.md)
- Guides: [daily use](docs/guides/daily-use.md), [existing project](docs/guides/existing-project.md), [task templates](docs/guides/task-templates.md), [writing an adapter](docs/guides/writing-an-adapter.md), [prompt catalogue](docs/guides/prompt-catalogue.md)
- Turkish: [gunluk kullanim](docs/guides/tr/gunluk-kullanim.md), [prompt katalogu](docs/guides/tr/prompt-katalogu.md)
- Reference: [skills](docs/reference/skills.md), [roles](docs/reference/roles.md), [design decisions](docs/decisions.md)

## Community adapters

Other agents are added through small adapters. See [adapters/README.md](adapters/README.md) and
[writing an adapter](docs/guides/writing-an-adapter.md). Untested adapters must be labelled "not tested". PRs welcome.

## Versioning and license

Version **0.0.16**: full scope, not yet proven on real projects. Until 1.0.0, 0.0.x is fixes and 0.x.0 is new features or behaviour changes. See [CHANGELOG.md](CHANGELOG.md).

MIT License, 2026 Furkan SARIKAYA. See [LICENSE](LICENSE).

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md) to report a vulnerability.
