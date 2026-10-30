# proofline

**No evidence, no claim.** A deterministic engineering team for coding agents: nothing is "done" because a model said so.

## What it is

- A **lead** (your main agent session) runs one deterministic lifecycle per task: classify, freeze a plan, dispatch, gate, report, stop before delivery.
- Eleven **roles** (lead, task author, explorer, architect, data architect, designer, QA, implementer, reviewer, security reviewer, verifier); only the lead dispatches.
- Twenty-four method **skills** plus the `/proofline` command entry skill, each usable on its own, each producing runnable or traceable evidence.
- Independent **gates** (secrets, reviews, security, QA, verify) judged by scripts on the exact content, never by the lead.
- **Risk signals** (contract, migration, UI, dependency and config paths, plan flags) add script-chosen checks inside those gates; one that cannot run is UNSUPPORTED, never a pass ([what tests each check](docs/concepts/testing.md)).
- Visual verification works on native apps with the project's own test tools.
- UI craft: each surface gets a visitor mode (persuade, operate, read, experience); persuade and experience surfaces need real imagery, motion and a characterful type voice, and generated-UI looks a written reason ([details](docs/concepts/design-surfaces.md#craft-by-visitor-mode)).
- **Enforcement** lives in `agent.sh` and git hooks, so it works with any agent; runtime hooks only block earlier.
- Claude Code is the primary runtime; any agent that reads `AGENTS.md` and runs shell commands gets the protocol tier (see the [adapters](adapters/README.md)).
- proofline works alongside ecosystem-specific skills; the gates verify the result whichever skill produced it ([details](docs/concepts/ecosystems.md#skills-specific-to-your-ecosystem)).

## Status

Version 0.0.39 is an early release.
Scripts and hooks enforce the guarantees listed below; more than 900 automated tests and enforcement tests check them.
Codex as implementer is supported (real use, 2026-10-23 to 25).
Other Codex roles are not yet verified in real use; failover from Codex to Claude worked in real use.
[tests/e2e/README.md](tests/e2e/README.md) lists the detailed full-team results.

## What to expect from AI behaviour

- **Guaranteed:** approvals, database safety, scope, evidence and cleanup: scripts and hooks refuse a step that breaks these rules ([limits](docs/concepts/enforcement-layers.md#what-is-guaranteed)).
- **Model-dependent:** report wording, plan details and code quality; two runs of the same task can differ and both be valid. The end-to-end runs measure this as a rate.
- **Lead model:** a cheap model follows the route poorly, most of all as lead; give it a base-level model ([roles](docs/concepts/roles.md#the-lead-model)).

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

Windows: use WSL or Git Bash (POSIX `sh`; no symlinks needed).

## Quick start (5 minutes)

```sh
cd your-project
proofline init            # asks runtimes, profile, task adapter, branch and push settings
proofline doctor          # live probes of hooks, runtimes, config, identity, enforced rules, language versions
proofline insights        # later: cost and recurring failures across runs (read-only report)
```

Run a role on another runtime with `proofline init --role implementer=codex` (repeatable; sets `runtime.roles.<role>`).

- **Optional tools:** `ast-grep` (structural search) and `rtk` (output compression) are used when installed, never required; `doctor` shows them. With rtk, commands that produce evidence run with `RTK_DISABLED=1`. `doctor` also warns when the plugin and the project's install are different versions (`/proofline upgrade`).
- **Codex:** open Codex once in the project folder and approve the hooks with `/hooks`. Without this, the Codex-side protections do not run. `proofline doctor` warns about it when Codex is a runtime.

Give the agent a task in plain words, or write it first:

```sh
proofline task --grill "Add rate limiting to the login endpoint"
proofline run TASK-001
```

What happens: the lead classifies the task (TRIVIAL to CRITICAL), gathers evidence on a task branch, freezes a
`PLAN.md` with a `scope:` file list ([lifecycle](docs/concepts/workflow.md)), and dispatches one implementer
that must show RED then GREEN evidence. Gates then run in parallel on the exact content; a FAIL goes back to the
implementer for at most `max_fix_rounds` (default 2). You approve the plan for COMPLEX and CRITICAL tasks, and you
approve every commit and push. A plan with an entry point taking external input (endpoint, form, CLI argument, queue consumer, webhook) must state how it is validated, and QA tries an invalid input there ([details](docs/concepts/workflow.md#input-validation-at-entry-points)). A log call naming a sensitive word opens a `logging` security review ([details](docs/concepts/gates.md#risk-signals)). Pushes from visual git clients work ([details](docs/concepts/enforcement-layers.md#visual-git-clients)).

## Commands

`proofline <command>` in a terminal, `/proofline <command>` in an agent session. `proofline help` prints the same list.

```text
init, upgrade, doctor, version        install, update, verify (doctor --scale, --commands), version
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
clean, merge, insights                clean up, the only allowed merge, cost, failures, calibration
```

**Platforms.** GitHub, GitLab, Azure DevOps; a private host is named by `git.platform_host`; else you merge ([details](docs/concepts/workflow.md#delivery-on-other-platforms)).

**The next step.** Every command ends with `Next step: ...`, the one command (or action of yours) that follows. One table in the control plane (`next-user.sh`) holds it; the entry skill lists it; see [details](docs/concepts/workflow.md#the-next-step).

**Night mode.** `/proofline batch <ID...|all>` shows one summary and takes one approval ("approve batch") for several tasks. The same session runs and delivers each in dependency order, each in its own git worktree. Keep the computer awake; `/proofline batch` continues after an interruption. What the approval does not cover parks that task; `proofline batch status` is the morning table ([night mode](docs/concepts/night-mode.md)).

**Shortcut debt.** A corner cut on purpose is marked `shortcut: <limit>, <when to improve>` and listed by `proofline debt` ([workflow](docs/concepts/workflow.md#shortcut-debt)). **Observations.** Out-of-scope issues the implementer saw are listed, not fixed, and become tasks only after you approve ([workflow](docs/concepts/workflow.md#observations-and-unrelated-changes)). **Language.** Run files are English; other-language project text is quoted as is ([details](docs/concepts/workflow.md#language-of-run-files)).

**Product skills.** `product-discovery`, `product-assess` and `product-spec` propose assumptions, risks, opportunities, edge cases and questions themselves; you accept, change or reject each one, and the checkers count a minimum (5 pre-mortem items, 5 assumptions, 3 never-mentioned topics in the review). Facts still need a source. The PRD carries a ten-topic completeness list; files from before 0.0.34 need a migration ([details](docs/concepts/product.md)).

**Project layout.** No layout is assumed: one ecosystem definition drives `init` (a command per ecosystem, workspaces included); `commands.build|test|lint` may be a list; an ambiguous one gets none and the run asks once ([ecosystems](docs/concepts/ecosystems.md)).

**Faster, not looser (A200).** Gates re-run when their inputs changed, batch questions come before the approval, empty `commands.*` are proposed by `proofline doctor --commands` and written only after your yes. Six core invariants ([CONTRIBUTING](CONTRIBUTING.md#core-invariants)) bound every change and are tested in CI ([gates](docs/concepts/gates.md#repeating-gates-after-a-fix-round-a200)).

**The task model (A202).** A task has a type (`feature|bug|refactor|content|docs|chore`; `bug` needs repro steps, `content` and `docs` a written test-first exemption that never covers code), a name `<ID>-<slug>.md` and optional scope limits, pattern references, `priority`, `origin`. One status block per task is updated in place; a finding the task does not touch can become a user-approved known issue; one message may hold several approvals; limits scale with `proofline doctor --scale` ([types](docs/guides/task-templates.md), [status](docs/concepts/workflow.md#live-status-block-a202), [known issues](docs/concepts/gates.md#known-issues-a202), [timeouts](docs/concepts/timeouts.md)).

**Processes.** An agent stops only a process it started, by its PID; the hook denies kill-by-name and mass kills (a tripwire, not a sandbox: [process rules](docs/concepts/enforcement-layers.md#process-rules)).

## Documentation

- Concepts: [workflow](docs/concepts/workflow.md), [night mode](docs/concepts/night-mode.md), [roles](docs/concepts/roles.md), [gates](docs/concepts/gates.md), [evidence](docs/concepts/evidence.md), [metrics](docs/concepts/metrics.md), [failover](docs/concepts/failover.md), [enforcement layers](docs/concepts/enforcement-layers.md), [testing](docs/concepts/testing.md), [ecosystems](docs/concepts/ecosystems.md), [product](docs/concepts/product.md)
- Guides: [daily use](docs/guides/daily-use.md), [existing project](docs/guides/existing-project.md), [task templates](docs/guides/task-templates.md), [writing an adapter](docs/guides/writing-an-adapter.md), [prompt catalogue](docs/guides/prompt-catalogue.md); Turkish: [gunluk kullanim](docs/guides/tr/gunluk-kullanim.md), [prompt katalogu](docs/guides/tr/prompt-katalogu.md)
- Other agents: small [adapters](adapters/README.md); PRs welcome, an untested adapter is labelled "not tested"
- Real output (an unedited end-to-end final message, 2026-10-09): [workflow](docs/concepts/workflow.md#real-output); all results: [tests/e2e/README.md](tests/e2e/README.md)
- Reference: [skills](docs/reference/skills.md), [roles](docs/reference/roles.md), [design decisions](docs/decisions.md)

## Versioning and license

Version **0.0.39**: full scope, not yet proven on real projects. Until 1.0.0, 0.0.x is fixes and 0.x.0 is new features or behaviour changes. See [CHANGELOG.md](CHANGELOG.md).

MIT License, 2026 Furkan SARIKAYA. See [LICENSE](LICENSE).

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md) to report a vulnerability.
