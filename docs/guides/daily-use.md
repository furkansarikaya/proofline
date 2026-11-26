# Daily use

The commands and habits for working with proofline once it is installed: the loop from a request to a merged change, what each command does, and what to check. For anyone who has run `proofline init` and wants the routine; installation is in [existing project](existing-project.md).

Turkish translation (this English page is authoritative; the translation records which version it follows, and CI warns when it lags): [tr/gunluk-kullanim.md](tr/gunluk-kullanim.md).

## The loop

1. `proofline status` - the active run and its next step (the default command).
2. Describe the work. Small and clear: just say it. Vague or large: `proofline task --grill "<text>"` interviews you first and writes a task file.
3. `proofline run <TASK>` - the lead takes the task through the full workflow. Typing the command is itself your approval to start a TRIVIAL run (no "reply yes"); a bare "fix this" with no run is still proposed first, and the commit, push and delivery approvals stay separate (A326).
4. Answer the questions the lead relays (they are verbatim from the specialist). Approve the plan when asked (COMPLEX and CRITICAL).
5. When the run reaches CODE_DONE, read the completion report, then `proofline deliver <TASK>` to see what delivery will do.
6. `/proofline deliver <TASK>` in the agent session shows one summary (commit, push, pull request, merge when green, cleanup). Reply `approve delivery` to approve every step of it; any change before a step stops the chain and asks again.

The words that count as an approval are configurable: `approval.phrases` in the project's `.agents/config.yaml` is a comma-separated list, and the defaults are English (`approve`, `yes`, `lgtm`, ...) and Turkish (`onay`, `evet`, `tamam`, ...). Your reply must contain one of the phrases and a kind word (`plan`, `commit`, `delivery`, ...), and every word in it must belong to some phrase, be a kind word or be a filler such as `the` or `please`; anything else is ambiguous and the question is asked again. Two exceptions (A350): when several runs wait, the id of a run that waits (or of the run being approved) may follow the kind word (`approve scope TASK-004 TASK-010` approves those two runs and no other); and one message may approve several kinds, separated by `;`, `,` or lines (`approve scope; approve budget`), or in one phrase that names each kind (`approve plan and scope`; `approve all` approves nothing). The answer to a pending question (`soru 1: a`) may stand in the same message and is recorded as your answer. `agent.sh config-get approval.phrases` prints the list in force.

Inside Claude Code the same commands are `/proofline status`, `/proofline run <TASK>`, and so on. In a terminal, the commands that need an agent (`task`, `run`, `design`, `review`, `audit`, `debug`, `docs`, `explain`, `wiki`, `knowledge`, `reopen`, `product`, `trace`, `batch`) print the exact instruction for your runtime and do nothing else; the state commands below run on their own. Checked in a scratch project with `proofline 0.0.135`: `task`, `run`, `review` and `design system` printed `This step needs an agent session`, `status`, `queue`, `debt`, `insights`, `clean`, `doctor` and `doctor --scale` ran and exited 0.

## Commands

The control plane is Node code; `.agents/scripts/agent.sh` is a thin launcher that starts it (see [ADR 0001](../adr/0001-node-control-plane.md)). `proofline help` prints the full list; this table is the short form.

| Command | Use |
|---|---|
| `proofline init`, `upgrade`, `doctor`, `version` | install, update (keeps your edits, reports conflicts), verify, version |
| `proofline status`, `resume`, `queue` | state without an agent session; `resume` after a pause or runtime switch |
| `proofline task [--grill] <text>` | write a task file |
| `proofline task --import <issue-url\|number>` | recommended: a GitHub issue becomes the task; the completion report is posted as a comment on the issue ([task sources](../concepts/task-sources.md)) |
| `proofline run <TASK>` | full workflow |
| `proofline design system\|data\|api\|ui [--check]` | design documents; `--check` reports drift |
| `proofline design ui <mode> <target>` | focused change of one UI target as a normal run; modes: `bolder quieter polish animate typeset colorize layout delight harden adapt`; it keeps the existing design system and touches only the target |
| `proofline review`, `audit`, `debug` | proof-review, test-trust and debug-proof standalone |
| `proofline docs create\|update\|audit`, `proofline explain <topic\|TASK-ID>` | write, update from a diff or audit documentation; one offline HTML page that explains a topic or a task |
| `proofline trace <FR-n\|TASK-ID>` | follow a requirement or task to its tests, run evidence and pull request (read-only) |
| `proofline product prd\|review\|split <slug>`, `product discover ...`, `product assess ...`, `product outcome <slug>` | product requirements, discovery, assumption tests and the measured outcome of a shipped change ([product](../concepts/product.md)) |
| `/proofline wiki ingest\|query\|lint` | persistent project wiki (llm-wiki skill; there is no on/off setting, start it with `/proofline wiki ingest README.md`); the wiki lives in `docs/wiki/`, which is in the default `knowledge_scope_root`, so the run's Knowledge step, which always runs (see `control-plane/agents/KNOWLEDGE.md`), may update it |
| `proofline knowledge <TASK>`, `reopen <TASK>` | knowledge step of a finished run (wiki, ADRs, lesson candidates, proposed tasks from the implementer's observations); take a FAILED or BLOCKED run back into the workflow with your approval |
| `proofline debt` | list the `shortcut: <limit>, <when to improve>` comments in the code with `file:line`; read-only, needs no run |
| `proofline deliver <TASK>` | delivery check; never commits (`/proofline deliver` in the session delivers after one `approve delivery`); a FAILED or BLOCKED run is refused |
| `proofline batch <ID...\|all>` | night mode, see below |
| `proofline clean [--yes]` | remove `.agents/local` state and finished runs |
| `proofline merge <PR> [--merge\|--squash\|--rebase] [--delete-branch]` | the only allowed merge: merges the pull request only when every check is green on its current head (A136); `--admin` and `--auto` are refused and the hook denies `gh pr merge` and the other merge paths |
| `proofline insights [--run ID] [--json]` | read-only report: cost per run, role and model (tokens only where the runtime reported them), tool calls per role and run, and recurring failures with suggestions; changes nothing |
| `proofline doctor --scale`, `--apply-scale` | measure this machine and propose `timeouts.scale`; written only after your `approve scale` ([timeouts](../concepts/timeouts.md)) |
| `proofline doctor --commands`, `--apply-commands` | find the empty `commands.build\|test\|lint`, prove each by one run and write the proposal after your yes |

## Several tasks in one night (batch)

`/proofline batch <ID...|all>` shows one summary of the listed tasks in dependency order. One reply, `approve batch`, bound to that summary, stands in for the plan and delivery approvals of those tasks; CRITICAL tasks are left out, and a waiver, a scope expansion, a new dependency, a reopen or a destructive data change is never covered (the task is parked, its dependents are skipped, independent tasks go on). The lead runs in your session, so keep the computer awake and the session open; after an interruption `/proofline batch` continues and never runs a merged task again. `proofline batch status` prints the morning table from records only.

- The batch reads `depends_on` from the task files and treats two tasks as sharing a file only when both list it in `## Expected scope` (a document or an address in the Context never counts); a parked task stops only what depends on it or shares a listed file. When you plan a changed batch with `--replace`, your own split and scope answers are carried to it if the task and its scope list are unchanged, and asked again if not (A355).
- The summary also lists the `## Test exceptions` lines that task files declare; approving the batch accepts exactly those lines (A285), and an exception nobody declared parks the task.
- The knowledge step of a batch task never asks where a note should go: with no knowledge page it records `not_applicable` with the reason `batch default (A291)` and adds a suggestion to the morning table (A291).
- An empty `commands.lint` is shown in the batch summary with the proposal of `proofline doctor --commands` and a WARNING; write `commands.lint: none` to say on purpose that there is no lint (A366).
- A project with no CI check on pull requests still runs a batch: each pull request is merged only after build and test pass in a clean copy of its commit and says "verified locally, no CI".

Details and limits: [night mode](../concepts/night-mode.md).

## Good habits

- One task, one run, one branch. Tasks queue; parallel tasks need separate git worktrees.
- Merge only with `proofline merge <PR>`. It reads the checks of the pull request on its current head and refuses when one is not green; a pull request with no check at all is merged only after build and test pass in a clean copy of its commit.
- Say "finish this without asking" to run a COMPLEX task autonomously; stop points for questions, destructive operations, scope changes and delivery still apply.
- When a gate FAILS, let the fix loop work (`review.max_fix_rounds`, 2 by default). A waiver needs your explicit message per finding; security and secret findings cannot be waived.
- When a test must wait for real time or a slow measurement cannot be avoided, the plan states it in `## Test exceptions`; a line clears a finding only when you approved that exact line (A284, A285), at the plan approval or in the batch summary.
- After a runtime limit, open the other runtime and run `proofline resume`. See [failover](../concepts/failover.md).
- Run `proofline doctor` after changing config or upgrading.
- Read the completion report's `## Unsupported Checks` and `## Assumptions`: an UNSUPPORTED check was never a pass, and an unverified assumption is a risk you accepted or still carry. Evidence classes and their meaning: [evidence](../concepts/evidence.md).
- Know what is verified: the scripts are tested, and each Claude-only scenario has passed an independent end-to-end evaluation at some point (2026-10-13 to 2026-10-17; STANDARD.tr several times), but none has been re-verified on the current version. Codex as implementer and failover from Codex to Claude worked in real use (2026-10-23 to 25), and the other Codex roles are not yet verified in real use. Changes to hooks, skills, roles or the control plane also run a real-session smoke test (a cheap model through `run`, `deliver` and a two-task `batch` in a throwaway repository) before they merge; it is a spot check, not a scenario evaluation. The dated results are in [tests/e2e/README.md](../../tests/e2e/README.md#current-results).
- Run `proofline insights` now and then: it reports where cost and repeated failures concentrate and changes nothing.

More prompts: [prompt catalogue](prompt-catalogue.md). Concepts: [workflow](../concepts/workflow.md), [gates](../concepts/gates.md).
