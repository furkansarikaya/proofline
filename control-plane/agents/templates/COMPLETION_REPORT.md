# Completion Report: <TASK-ID>

<!-- proofline:summary:begin -->
Changed: <one line, in the user's language: what changed>
Verify: `<one command the user runs on their own machine>`
<!-- proofline:summary:end -->

Owner: lead. Derived from run evidence only; published through the task adapter before DONE. agent.sh
requires the sections that apply to the run; a missing one FAILS `publish-completion-report`. Do not count tests, gates,
fix rounds or refreezes yourself: publish appends the generated Facts block and refuses other numbers (A143).

The summary block above is for the user, in the user's language, at most five lines in all: `Changed:` (what changed) and `Verify:`
(exactly one command). Do not write `Look at:` lines: publish copies QA_REPORT.md `## Human checks` there, once. If the task has a
`## Completion response`, the summary follows its format. The block is not evidence; everything below it stays English.

## Implementation Summary

## Root cause

(defect task: a debug-proof result exists) One sentence: the function or symbol at fault and what it did wrong.

## TDD Evidence

(when worker evidence exists) RED/GREEN per scope path, by the expected implementation owner.

## Verification

## Assumptions

- <AS-n> (<low|medium|high>): <assumption text> — <unverified | accepted-by-user, answer `questions/NNN.answer.md`>
- or "none" when every assumption is verified (`agent.sh verify-assumptions <ID>`)

## Review Result

(when a review or SECURITY gate was required) gate, result, fix rounds.

## QA Result

(STANDARD and up) QA result; when the `visual` focus ran, the visual-proof `SUMMARY:` line.

## Unsupported Checks

(when `agent.sh pipeline <ID>` prints `unsupported.` lines) one line per check; never written as verified (A98):

- <GATE>:<focus>: <reason, the missing tool or capability>; not proven: <what this check would have proven>

## Waivers

(when waivers exist) finding id, gate, reason, approval.

## Execution

(when decisions exist) the control plane writes this table at publish from the decision records (role, runtime, model, effort, signals, failovers); leave it out or write only the heading.

## Amendments

(when amendments exist)

## Reopen History

(after `agent.sh amend`)

## Known Limitations / Follow-up

(open `info` findings, follow-up tasks; every TASK `## Pre-existing defects` entry with `decision: report`, left unchanged)
