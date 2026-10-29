# Completion Report: <TASK-ID>

<!-- proofline:summary:begin -->
Changed: <one line, in the user's language: what changed>
Verify: `<one command the user runs on their own machine>`
<!-- proofline:summary:end -->

Written by the lead from run evidence only (proofline-lead references/REPORT.md); published through the task
adapter before DONE. Omit a conditional section only when its condition does not hold for the run.

The summary block above is for the user, in the user's language, at most five lines in all: `Changed:` (what changed) and `Verify:`
(exactly one command). Do not write `Look at:` lines: publish copies QA_REPORT.md `## Human checks` there, once. If the task has a
`## Completion response`, the summary follows its format. The block is not evidence; everything below it stays English.

## Implementation Summary

- Delivery: nothing is committed; commit and push each need the user's explicit approval (`commit`, `push`)
- Task: <TASK-ID> — <title>; class <CLASS>; tier <docs|small|full>; branch `<task branch>`
- Changed: <scope path> (<AC ids>), ...

## Root cause

(defect task: a debug-proof result exists) <one sentence: `<function or symbol>` <what it did wrong>; the regression test stays in TDD Evidence>

## TDD Evidence

(when worker evidence exists)

| path | RED | GREEN/FIX | owner |
|---|---|---|---|
| <scope path> | <command> fails: <expected_failure> | <command> passes | implementer |

## Verification

- VERIFY: <PASS|FAIL> (<confidence>); commands: `<command>`, ...

## Assumptions

- <AS-n> (<low|medium|high>): <assumption text> — <unverified | accepted-by-user, answer `questions/NNN.answer.md`>
- or "none" when every assumption is verified (`agent.sh verify-assumptions <ID>`)

## Review Result

(when a review or SECURITY gate was required)

| gate | status | confidence | fix round | findings |
|---|---|---|---|---|
| <GATE> | <pass\|waived\|fail\|pass_low (not counted)> | <high\|medium\|low> | <n> | <ids or none> |

Fix rounds used: <n> of <review.max_fix_rounds> (the numbers of the Facts block; publish refuses others, A143).

The findings column names every finding id of the gate record, info rows included; `none` only when the gate record has no finding row (A130).
For each `not_rerun.<GATE>:<focus>=` line of `A pipeline <ID>` (the gate re-ran nothing), one line of its own, never called reproduced proof:

- <GATE>:<focus>: not reproduced (NOT_RERUN)

## QA Result

(STANDARD and up) QA: <PASS|FAIL> (<confidence>); scenarios <passed>/<total>.
Visual (when the `visual` focus ran): <the `SUMMARY:` line of `reviews/visual-proof/REPORT.md`>.

## Unsupported Checks

(when `A pipeline <ID>` prints `unsupported.` lines) never written as verified (A98):

- <GATE>:<focus>: <reason, the missing tool or capability>; not proven: <what this check would have proven>

## Waivers

(when waivers exist)

| finding | gate | reason (the user's) | approval |
|---|---|---|---|
| <FINDING-ID> | <GATE> | <reason> | <approvals file>, answered_by: user |

## Execution

(when decisions exist)

| role | focus | runtime | model | effort | signals | note |
|---|---|---|---|---|---|---|
| <role> | <focus or -> | <claude\|codex> | <model> | <effort> | <signals or none> | <escalated, failover from=.. to=.. reason=..> |

## Amendments

(when amendments exist) <amendment file>: <what changed>, approval <kind>.

## Reopen History

(after `agent.sh amend`) <when>, <reason>, <authorized_by>.

## Known Limitations / Follow-up

- <open info finding or follow-up task, or "None.">
- Pre-existing defect (TASK `## Pre-existing defects`, `decision: report`): <path:symbol>: <what>, left unchanged.
