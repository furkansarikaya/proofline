# proofline

**No evidence, no claim.** A deterministic engineering team for coding agents: nothing is "done" because a model said so.

## What it is

- A **lead** (your main agent session) runs one deterministic lifecycle per task: classify, freeze a plan, dispatch, gate, report, stop before delivery.
- Eleven **roles** (lead, task author, explorer, architect, data architect, designer, QA, implementer, reviewer, security reviewer, verifier). Only the lead dispatches; specialists never spawn agents.
- Twenty-four method **skills** plus the `/proofline` command entry skill, each usable on its own, each producing runnable or traceable evidence.
- Independent **gates** (secrets, reviews, security, QA, verify) judged by scripts on the exact content, never by the lead.
- **Risk signals** (contract, migration, UI, dependency and config paths, plan flags) add focused checks inside those gates, chosen by script. A check that cannot run is reported UNSUPPORTED, never a pass. [Testing](docs/concepts/testing.md) lists what tests each check.
- Visual verification works on native apps with the project's own test tools.
- UI craft: each surface gets a visitor mode (persuade, operate, read, experience); `design_docs.design` can hold one document per surface ([details](docs/concepts/design-surfaces.md)). Generated-UI looks need a written reason; persuade and experience surfaces also need real imagery, motion and a characterful type voice, with directions dealt reproducibly from a bundled design library and a draft visual (comp) before coding when an image tool exists. `design ui <mode> <target>` makes one focused change. visual-proof measures this in a browser and lints the source ([details](docs/concepts/testing.md)).
- **Enforcement** lives in `agent.sh` and git hooks, so it works with any agent; runtime hooks only block earlier.
- Claude Code is the primary runtime, Codex is supported as implementer, and any agent that reads `AGENTS.md` and runs shell commands gets the protocol tier (see the [adapters](adapters/README.md)).
- proofline works alongside skills specific to your ecosystem; the gates verify the result regardless of which skill produced it.

## Status

Version 0.0.33 is an early release.
Scripts and hooks enforce the guarantees: approvals, database safety, scope, evidence and cleanup.
More than 900 automated tests and enforcement tests check them.
Claude Code is the primary runtime.
Codex as implementer is supported (real use, 2026-10-23 to 25).
Other Codex roles are not yet verified in real use; failover from Codex to Claude worked in real use.
[tests/e2e/README.md](tests/e2e/README.md) lists the detailed full-team results.

## What to expect from AI behaviour

- **Guaranteed:** approvals, database safety, scope, evidence and cleanup. Scripts and hooks refuse a step that breaks these rules. A run can still stop or fail before it finishes, and hook checks have documented limits.
- **Model-dependent:** report wording, plan details and code quality. These vary from run to run. The end-to-end runs measure them as a rate.
- **Valid differences:** two runs of the same task can differ, and both can be valid.
- **Lead model:** a cheap model can follow the route poorly, most of all as lead. Give the lead a base-level model; `proofline doctor` fails on a resolved model below base. Details: [roles](docs/concepts/roles.md#the-lead-model).

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

Windows: use WSL or Git Bash (the control plane is POSIX `sh`); no symlinks needed.

## Quick start (5 minutes)

```sh
cd your-project
proofline init            # asks runtimes, profile, task adapter, protected branches, push approval
proofline doctor          # live probes: hooks, runtimes, config, commit identity, every enforced rule, CI vs local language versions
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
approve every commit and push. A plan that adds an entry point taking external input (an endpoint, form, CLI argument,
queue consumer or webhook) must state how that input is validated, and the QA plan must try an invalid input there
([details](docs/concepts/workflow.md#input-validation-at-entry-points)). A diff that adds a log call naming a sensitive word (password, token, cookie, ...) opens a `logging` security review; the project's own log standard lives in `AGENTS.md` ([details](docs/concepts/gates.md#risk-signals)). `proofline status` shows the next step at any time.

Pushes from visual git clients (VS Code, GitHub Desktop) work: the hooks tell an agent session from a person by the session's environment markers, not by a terminal.

## Commands

`proofline <command>` in a terminal, `/proofline <command>` in an agent session. `proofline help` prints the same list.

```text
init, upgrade, doctor, version        install, update, verify, version
status, resume, queue                 state of the active run, the task queue
task, design, docs, explain           write a task, design documents, documentation, an explanation page
design ui <mode> <target>             focused UI change of one target (bolder, quieter, polish, ...), run like any task
run <TASK>                            take a task through the whole workflow
review, audit, debug                  proof-review, test-trust and debug-proof standalone
wiki ingest|query|lint                keep the project wiki in docs/wiki/
product prd|review|split <slug>    PRD with you, an independent review, the split into tasks
product discover|assess|outcome <step> <slug>  sourced discovery, locked probes, a decision and the measured outcome
trace <FR-n|TASK-ID>                  follow a requirement or task to its tests and pull request, plus the evidence and decision behind it
knowledge <TASK>                      knowledge step of a finished run
reopen <TASK>                         take a FAILED or BLOCKED run back into the workflow, with your approval
deliver <TASK>                        commit, push, pull request, merge and cleanup after one approval
batch <ID...|all>                     night mode: one approval of one summary for several tasks, run in this session; batch status
debt                                  list the shortcut comments in the code (read-only, needs no run)
clean, merge, insights                clean up, the only allowed merge, cost and recurring failures
```

**Platforms.** GitHub, GitLab, Azure DevOps; a private host is named by `git.platform` and `git.platform_host`; else you merge ([details](docs/concepts/workflow.md#delivery-on-other-platforms)).

**The next step.** Every command ends with one line, `Next step: ...`: the one command (or action of yours) that follows, never an internal one. One table in the control plane (`next-user.sh`) holds it; the entry skill lists it; see [details](docs/concepts/workflow.md#the-next-step).

**Night mode.** `/proofline batch <ID...|all>` shows one summary of the order and of what one approval covers; your reply "approve batch" is bound to it. The same session then runs and delivers each task in dependency order, the next one only after the previous is merged, each in its own git worktree. Keep the computer awake and the session open; `/proofline batch` continues after an interruption. What the approval does not cover (waiver, scope expansion, new dependency, reopen, destructive data change) parks that task with its question. `proofline batch status` is the morning table. A worktree gets copies of the main tree's dependency folders (`node_modules`, `vendor`, ...) and its git-ignored `.env*` files (`worktree.copy_files`), so an install in a task never changes the main tree ([night mode](docs/concepts/night-mode.md)).

**Shortcut debt.** A corner cut on purpose is marked `shortcut: <limit>, <when to improve>`; `proofline debt` lists those comments ([workflow](docs/concepts/workflow.md#shortcut-debt)).

**Observations and unrelated changes.** The implementer lists out-of-scope issues it saw but did not touch; a task is written only after you approve it. A change that serves no acceptance criterion fails plan review ([workflow](docs/concepts/workflow.md#observations-and-unrelated-changes)).

**Language of run files.** Run files are English; a project in another language quotes its own product text as it is (inline code, "double quotes", a `> ` line or a JSON string found in the task or a project file), never transliterated ([details](docs/concepts/workflow.md#language-of-run-files)).

**Project layout.** No layout is assumed. One ecosystem definition drives `init`: a command per ecosystem, built from the workspace member list in the definition if there is one (`go.work`); `commands.build|test|lint` may be a list. An ambiguous one gets none; the run asks once ([ecosystems](docs/concepts/ecosystems.md)).

**Processes.** An agent stops only a process it started itself, by its own PID: the runtime hook denies `pkill`, `killall`, `kill` by pattern and mass kills. A tripwire against an honest mistake, not a sandbox: [process rules](docs/concepts/enforcement-layers.md#process-rules).

## Real output

An end-to-end run's final message, unedited (STANDARD bug fix, headless, 2026-10-09): [workflow](docs/concepts/workflow.md#real-output). All results: [tests/e2e/README.md](tests/e2e/README.md).

## Documentation

- Concepts: [workflow](docs/concepts/workflow.md), [night mode](docs/concepts/night-mode.md), [roles](docs/concepts/roles.md), [gates](docs/concepts/gates.md), [evidence](docs/concepts/evidence.md), [metrics](docs/concepts/metrics.md), [failover](docs/concepts/failover.md), [enforcement layers](docs/concepts/enforcement-layers.md), [testing](docs/concepts/testing.md), [ecosystems](docs/concepts/ecosystems.md), [product](docs/concepts/product.md)
- Guides: [daily use](docs/guides/daily-use.md), [existing project](docs/guides/existing-project.md), [task templates](docs/guides/task-templates.md), [writing an adapter](docs/guides/writing-an-adapter.md), [prompt catalogue](docs/guides/prompt-catalogue.md)
- Turkish: [gunluk kullanim](docs/guides/tr/gunluk-kullanim.md), [prompt katalogu](docs/guides/tr/prompt-katalogu.md)
- Reference: [skills](docs/reference/skills.md), [roles](docs/reference/roles.md), [design decisions](docs/decisions.md)

## Community adapters

Other agents are added through small adapters. See [adapters/README.md](adapters/README.md) and
[writing an adapter](docs/guides/writing-an-adapter.md). Untested adapters must be labelled "not tested". PRs welcome.

## Versioning and license

Version **0.0.33**: full scope, not yet proven on real projects. Until 1.0.0, 0.0.x is fixes and 0.x.0 is new features or behaviour changes. See [CHANGELOG.md](CHANGELOG.md).

MIT License, 2026 Furkan SARIKAYA. See [LICENSE](LICENSE).

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md) to report a vulnerability.
