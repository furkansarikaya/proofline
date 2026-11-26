# proofline

**No evidence, no claim.** A deterministic engineering team for coding agents: a task is not "done" until scripts have checked the evidence, whatever the model says.

proofline is for developers who let Claude Code or Codex change real code and want more than "trust me". Your main agent session becomes the **lead**: it takes each task through one fixed lifecycle (classify, freeze a plan, dispatch one implementer, run independent gates, report) and stops before commit and push to ask you. Eleven **roles** (the lead is one) and 28 **skills** (the `/proofline` entry skill, the lead's lifecycle skill and 26 method skills; the 26 method skills can each be installed alone) do the work; scripts and git hooks, not prompts, enforce the rules (runtime hooks are tripwires, see the limits below).

## Why proofline

With a plain session, "done" is the model's word. proofline makes it show why:

- **No "done" without evidence.** A run cannot reach CODE_DONE until every required gate has passed for the current content, or you have explicitly waived it.
- **The test fails first.** The implementer records RED, then GREEN evidence, and the gates reproduce it independently.
- **Whoever wrote a change never reviews it.** Reviews, QA and security run in separate roles.
- **Approvals come only from your own message.** The prompt hook records them; no agent can approve or waive for you. A design rationale or a waiver of a finding that was already there is kept for the project only when you add the word `standing` to the approval, and is then carried while its line, file and finding stay the same (`agent.sh standing` lists it; "revoke <rule>" removes it).
- **Secret and security gates cannot be waived.** They run on every round that changes code, dependencies or configuration.

These restate five of the six [core invariants](CONTRIBUTING.md#core-invariants); each has at least one test that attempts the forbidden action against the real scripts, and the test headers name any part that is not yet mechanical.

## Proof, not promises

Every number below has its source on [docs/proof.md](docs/proof.md), with what it does not prove.

- 5,837 test results (5,661 distinct tests) in one CI run of `main` (run 44051436515), counted from the run's duration reports.
- 323 recorded design decisions, each saying what changed; 216 also mention what they rejected ([docs/decisions.md](docs/decisions.md)).
- Control plane moved from 175 shell files (44,842 lines) to 4 launchers (42 lines); recording one gate result went from 7.56 s (shell form, measured on 0.0.48) to 0.21 s ([ADR 0001](docs/adr/0001-stages.md#stage-15-exit-criteria-record-a251)).
- Independent security reviews found bypasses before release; one added layer was removed because the review showed it failed open (A292).
- The real-session smoke run for a recent change failed on its first attempt, which exposed a false positive that parked a task (PR #293, A293).

## Status

Version 0.0.186 is an early release.
It is not yet proven on real projects. In the newest end-to-end team runs (2026-11-16 to 18) no scenario passes in every run (TRIVIAL passed once and failed once on `900c2852`): one COMPLEX run reached DONE on `98f49400` (a single sample, FAIL 37/38 invariants, C-22 only) and STANDARD reached DONE with one unmet item (36 of 37); the other four scenarios were last run on `900c2852`, and the unmet items are recorded as accepted limits ([tests/e2e/README.md](tests/e2e/README.md)).
Codex as implementer is supported (real use, 2026-10-23 to 25); other Codex roles are not yet verified in real use.
A cheap model follows the route poorly, most of all as lead; give it a base-level model ([roles](docs/concepts/roles.md#the-lead-model)).
Guaranteed: approvals, database safety, scope, evidence and cleanup. Model-dependent: report wording, plan details and code quality ([limits](docs/concepts/enforcement-layers.md#what-is-guaranteed)). Every accepted limit, with its reason: [docs/limits.md](docs/limits.md).

## Install

Requirements: Git, Node.js 22.13 or newer; POSIX `sh` for the 4 launchers.

**Claude Code (plugin marketplace)**

```text
/plugin marketplace add furkansarikaya/proofline
/plugin install proofline@proofline
```

**Codex / terminal**

```sh
git clone https://github.com/furkansarikaya/proofline
node proofline/adapters/codex/install.mjs       # links bin/proofline onto your PATH; options: --dir DIR, --yes
```

**Skills only** (no team, no enforcement): `npx skills add furkansarikaya/proofline --skill <name>`

## Quick start

In your project (a git repository):

```sh
proofline init            # installs the control plane, agents, skills and hooks; --yes takes the defaults
proofline doctor          # live probes of hooks, runtimes, config, identity, enforced rules
proofline status          # no run yet; prints the next step
```

`doctor` ends with `N FAIL, N WARN`; fix any FAIL before you go on. Then, in your Claude Code session (inside Claude Code: `/proofline init` does the first step):

```text
/proofline task --grill Add rate limiting to the login endpoint
/proofline run TASK-001
```

From a terminal, `proofline task` and `proofline run` print these same two lines for your agent session. The lead classifies the task, freezes a `PLAN.md` with a `scope:` file list, and dispatches one implementer. Gates run on the exact content; a FAIL goes back for at most `max_fix_rounds` (default 2, COMPLEX and CRITICAL 3). A content or docs task with no code, dependency, configuration or CI change runs a light profile (no mutation budget approval and an instruction that mutation testing is not required; every gate stays required, [weight](docs/concepts/gates.md#weight-by-work-type)). You approve the plan for COMPLEX and CRITICAL tasks and every commit and push ([lifecycle](docs/concepts/workflow.md)).

On Codex, open it once in the project and approve the hooks with `/hooks`; without this the Codex-side protections do not run (`doctor` warns). Run a role on another runtime with `proofline init --role implementer=codex`. `ast-grep` and `rtk` are used when installed, never required.

## What it supports

- **Runtimes:** Claude Code (primary); Codex (implementer verified); any agent that reads `AGENTS.md` and runs shell commands gets the protocol tier ([adapters](adapters/README.md)).
- **Ecosystems:** ten definitions (npm, Python, Go, JVM, Cargo, .NET, PHP, Ruby, Swift, Dart) in one data file. Test-output recognition was checked against the real runner for node:test, bun, vitest, jest, tsc, unittest, pytest, go test, Minitest, test-unit, swift test and the .NET SDK; mocha, Maven, Gradle, JUnit, cargo, PHPUnit, RSpec and dart/flutter test are from documentation only. The other touch points were read in code and tried on hand-made layouts ([matrix](docs/concepts/ecosystems.md#ecosystem-matrix)).
- **Task trackers:** markdown files (default), GitHub, Jira, Linear; Jira, Linear, `glab` and `az` were tried against fakes only. **Hosts:** GitHub, GitLab, Azure DevOps; else you merge.
- **Platforms:** macOS and Linux supported. Linux runs on every pull request; macOS and Windows run nightly, and the Windows hook leg also on pull requests touching hook code ([CI results](docs/proof.md#ci-legs)). Not tried: Codex sandbox on Windows, `.cmd` shims, `taskkill /T`, WSL, Git Bash as a shell ([limits](docs/concepts/workflow.md#not-tried)).

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

Every command ends with `Next step: ...` ([details](docs/concepts/workflow.md#the-next-step)). More: [night mode](docs/concepts/night-mode.md), [task model and types](docs/guides/task-templates.md), [known issues and waivers](docs/concepts/gates.md#approvals), [risk signals](docs/concepts/gates.md#risk-signals) and [what tests each check](docs/concepts/testing.md), [UI craft](docs/concepts/design-surfaces.md#craft-by-visitor-mode), [product skills](docs/concepts/product.md), [project layout and ecosystems](docs/concepts/ecosystems.md), [process rules](docs/concepts/enforcement-layers.md#process-rules).

## Documentation

- Concepts: [workflow](docs/concepts/workflow.md), [roles](docs/concepts/roles.md), [gates](docs/concepts/gates.md), [evidence](docs/concepts/evidence.md), [metrics](docs/concepts/metrics.md), [failover](docs/concepts/failover.md), [enforcement layers](docs/concepts/enforcement-layers.md), [testing](docs/concepts/testing.md)
- Guides: [daily use](docs/guides/daily-use.md), [existing project](docs/guides/existing-project.md), [writing an adapter](docs/guides/writing-an-adapter.md), [prompt catalogue](docs/guides/prompt-catalogue.md); Turkish translations: [daily use](docs/guides/tr/gunluk-kullanim.md), [prompt catalogue](docs/guides/tr/prompt-katalogu.md)
- Evidence: [proof, not promises](docs/proof.md); real output of a run: [workflow](docs/concepts/workflow.md#real-output); end-to-end results: [tests/e2e/README.md](tests/e2e/README.md)
- Reference: [skills](docs/reference/skills.md), [roles](docs/reference/roles.md), [design decisions](docs/decisions.md)

## Versioning and license

Version **0.0.186**: full scope, not yet proven on real projects. Until 1.0.0, 0.0.x is fixes and 0.x.0 is new features or behaviour changes. See [CHANGELOG.md](CHANGELOG.md).

MIT License, 2026 Furkan SARIKAYA. See [LICENSE](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md) to report a vulnerability.
