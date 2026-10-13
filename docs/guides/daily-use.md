# Daily use

Turkish version: [gunluk-kullanim.md](tr/gunluk-kullanim.md).

## The loop

1. `proofline status` - the active run and its next step (the default command).
2. Describe the work. Small and clear: just say it. Vague or large: `proofline task --grill "<text>"` interviews you first and writes a task file.
3. `proofline run <TASK>` - the lead takes the task through the full workflow.
4. Answer the questions the lead relays (they are verbatim from the specialist). Approve the plan when asked (COMPLEX and CRITICAL).
5. When the run reaches CODE_DONE, read the completion report, then `proofline deliver <TASK>` to see what a commit or push would do.
6. Tell the agent to commit (and push) in your own words. Each needs your approval in that message and a gate pass for the exact content.

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
| `proofline deliver <TASK>` | delivery check; never commits |
| `proofline clean [--yes]` | remove `.agents/local` state and finished runs |
| `proofline insights [--run ID] [--json]` | read-only report: cost per run, role and model (tokens only where the runtime reported them) and recurring failures with suggestions; changes nothing |

## Good habits

- One task, one run, one branch. Tasks queue; parallel tasks need separate git worktrees.
- Say "finish this without asking" to run a COMPLEX task autonomously; stop points for questions, destructive operations, scope changes and delivery still apply.
- When a gate FAILS, let the fix loop work (2 rounds by default). A waiver needs your explicit message per finding; security and secret findings cannot be waived.
- After a runtime limit, open the other runtime and run `proofline resume`. See [failover](../concepts/failover.md).
- Run `proofline doctor` after changing config or upgrading.
- Read the completion report's `## Unsupported Checks` and `## Assumptions`: an UNSUPPORTED check was never a pass, and an unverified assumption is a risk you accepted or still carry. Evidence classes and their meaning: [evidence](../concepts/evidence.md).
- Run `proofline insights` now and then: it reports where cost and repeated failures concentrate and changes nothing.

More prompts: [prompt catalogue](prompt-catalogue.md). Concepts: [workflow](../concepts/workflow.md), [gates](../concepts/gates.md).
