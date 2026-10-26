# Daily use

Turkish version: [gunluk-kullanim.md](tr/gunluk-kullanim.md).

## The loop

1. `proofline status` - the active run and its next step (the default command).
2. Describe the work. Small and clear: just say it. Vague or large: `proofline task --grill "<text>"` interviews you first and writes a task file.
3. `proofline run <TASK>` - the lead takes the task through the full workflow.
4. Answer the questions the lead relays (they are verbatim from the specialist). Approve the plan when asked (COMPLEX and CRITICAL).
5. When the run reaches CODE_DONE, read the completion report, then `proofline deliver <TASK>` to see what delivery will do.
6. `/proofline deliver <TASK>` in the agent session shows one summary (commit, push, pull request, merge when green, cleanup). Reply `approve delivery` to approve every step of it; any change before a step stops the chain and asks again.

Inside Claude Code the same commands are `/proofline status`, `/proofline run <TASK>`, and so on.

## Commands

| Command | Use |
|---|---|
| `proofline init`, `upgrade`, `doctor`, `version` | install, update (keeps your edits, reports conflicts), verify, version |
| `proofline status`, `resume`, `queue` | state without an agent session; `resume` after a pause or runtime switch |
| `proofline task [--grill] <text>` | write a task file |
| `proofline run <TASK>` | full workflow |
| `proofline design system\|data\|api\|ui [--check]` | design documents; `--check` reports drift |
| `proofline review`, `audit`, `debug` | proof-review, test-trust and debug-proof standalone |
| `/proofline wiki ingest\|query\|lint` | persistent project wiki (llm-wiki skill; slash command only); the wiki lives in `docs/wiki/`, which is in the default `knowledge_scope_root`, so the run's Knowledge step, which always runs (see `control-plane/agents/KNOWLEDGE.md`), may update it |
| `proofline knowledge <TASK>`, `reopen <TASK>` | knowledge step of a finished run (wiki, ADRs, lesson candidates, proposed tasks from the implementer's observations); take a FAILED or BLOCKED run back into the workflow with your approval |
| `proofline debt` | list the `shortcut: <limit>, <when to improve>` comments in the code with `file:line`; read-only, needs no run |
| `proofline deliver <TASK>` | delivery check; never commits (`/proofline deliver` in the session delivers after one `approve delivery`) |
| `proofline clean [--yes]` | remove `.agents/local` state and finished runs |
| `proofline merge <PR> [--squash\|--rebase] [--delete-branch]` | the only allowed merge: merges the pull request only when every check is green on its current head (A136); the hook denies `gh pr merge` and the other merge paths |
| `proofline insights [--run ID] [--json]` | read-only report: cost per run, role and model (tokens only where the runtime reported them) and recurring failures with suggestions; changes nothing |

## Good habits

- One task, one run, one branch. Tasks queue; parallel tasks need separate git worktrees.
- Say "finish this without asking" to run a COMPLEX task autonomously; stop points for questions, destructive operations, scope changes and delivery still apply.
- When a gate FAILS, let the fix loop work (2 rounds by default). A waiver needs your explicit message per finding; security and secret findings cannot be waived.
- After a runtime limit, open the other runtime and run `proofline resume`. See [failover](../concepts/failover.md).
- Run `proofline doctor` after changing config or upgrading.
- Read the completion report's `## Unsupported Checks` and `## Assumptions`: an UNSUPPORTED check was never a pass, and an unverified assumption is a risk you accepted or still carry. Evidence classes and their meaning: [evidence](../concepts/evidence.md).
- Know what is verified: the scripts are tested, and each Claude-only scenario has passed an independent end-to-end evaluation at some point (2026-10-13 to 2026-10-17; STANDARD.tr several times), but none has been re-verified on the current version, Codex as implementer and failover from Codex to Claude worked in real use (2026-10-23 to 25), and the other Codex roles are not yet verified in real use. The dated results are in [tests/e2e/README.md](../../tests/e2e/README.md#current-results).
- Run `proofline insights` now and then: it reports where cost and repeated failures concentrate and changes nothing.

More prompts: [prompt catalogue](prompt-catalogue.md). Concepts: [workflow](../concepts/workflow.md), [gates](../concepts/gates.md).
