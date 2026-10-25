# Reports

## 1. Lead status block

At every stop point and at the end of a run the lead's message starts with this block (English keys, the
table rows in English, questions as relayed):

```
ROLE: lead
TASK: <ID>
RESULT: <DONE|BLOCKED|NEEDS_INPUT>
CONFIDENCE: <high|medium|low>
FINGERPRINT: <A fingerprint <ID>>
ARTIFACT: <COMPLETION_REPORT.md or PLAN.md> <sha256>

| id | severity | path:line | finding | evidence |
|---|---|---|---|---|
| <open finding, waiver or failover> | blocking\|info | ... | ... | gates/<file>, waivers/<file> or the ledger row |
```

- `NEEDS_INPUT`: a relayed specialist question, an approval request or a lead question, followed by
  `QUESTIONS:` verbatim. `BLOCKED`: followed by `BLOCKED_REASON: <one line>`. `DONE`: the run reached DONE
  (or the user's requested stop) with nothing pending.
- After the block: at most three lines in the user's language: what happened, what the user must do next.
- It is not recorded; `record` rejects any `lead` verdict.

## 2. Completion report

`COMPLETION_REPORT.md` in the run, from [assets/COMPLETION_REPORT.md](../assets/COMPLETION_REPORT.md).
`A publish-completion-report <ID>` rejects it when a section the run needs is missing. Every statement comes
from run evidence; nothing is inferred or invented.

| Section | Source |
|---|---|
| Implementation Summary | PLAN.md scope paths and the final diff stat against `repository.base_sha` |
| Root cause | the implementer's `reports/NNN-debug.md` (defect tasks only) |
| TDD Evidence | `worker-evidence/` (RED/GREEN per scope path, exemptions from PLAN.md) |
| Verification | `VERIFY.md` header (result, confidence) and `## Verification commands` |
| Assumptions | `A verify-assumptions <ID>`: every assumption whose status is not `verified`: id, risk, text, `unverified` or `accepted-by-user` with the answer file (`questions/NNN.answer.md`); the status word stands on the same line as the id; `none` when all are verified |
| Review Result | `A pipeline <ID>` final statuses; per gate: result, confidence, fix round, and the id of every finding row of the gate record, info rows included (`none` only when the gate record has no finding row at all; `publish-completion-report` refuses a report that omits an id, A130); `pass_low` is listed as not counted. Per `not_rerun.<GATE>:<focus>=` line of `A pipeline <ID>` (a gate that re-ran nothing): one line of its own, `- <GATE>:<focus>: not reproduced (NOT_RERUN)`; such a gate is never described as reproduced proof. Fix-round counts and gate labels come from `A pipeline <ID>` and the gate records, never from memory; `A next <ID>` lists the ids and lines the report must carry |
| QA Result | `QA_REPORT.md` header (STANDARD and up); when the `visual` focus ran, the `SUMMARY:` line of `reviews/visual-proof/REPORT.md` (result, cells, measured pass/fail, judged, screenshots, criteria; the screenshots are deleted with the run) |
| Unsupported Checks | every `unsupported.<GATE>:<focus>=` line of `A pipeline <ID>` (A98): one line each, `- <GATE>:<focus>: <reason>; not proven: <what the check would have proven>`; never written as verified or passed, also when the user waived it |
| Waivers | `waivers/*.yaml`: finding id, gate, the user's reason, approval |
| Execution | `decisions/*.decision` and ledger `decide` / `failover` rows: role, focus, runtime, model, effort, signals, escalations, failovers |
| Amendments, Reopen History | `amendments/`, ledger |
| Known Limitations / Follow-up | open `info` findings, follow-up tasks from waivers, every TASK `## Pre-existing defects` entry with `decision: report` (named, left unchanged; A105) |

### Facts block (A143)

Counts and statuses are not yours to write. `A report-facts <ID>` prints the Facts block (class, required gates
with status and finding ids, fix rounds, refreezes, files changed, worker-evidence test runs), and
`A publish-completion-report <ID>` appends it verbatim as the last section; a block you wrote by hand is replaced.
No record carries the number of individual tests, so no such number is stated. In your own text do not write a number
beside the words tests, gates, fix rounds or refreezes unless it equals the Facts block (write "all gates passed",
"the project test command passed", not "7 tests"). `publish-completion-report` refuses a report with another number
and names the line. The same numbers go into the final message to the user: copy them from the Facts block.

### Assumptions (A79)

`## Assumptions` is always present. It lists, from `A verify-assumptions <ID>`, each assumption of PLAN.md and
EVIDENCE.md that is not `verified`: `unverified` ones (low and medium risk, which did not block) and
`accepted-by-user` ones (high risk, accepted by the user's answer, with its `questions/NNN.answer.md`
reference), one line each with id, risk and text; `none` when every assumption is verified. A listed one is
never described as verified. `A publish-completion-report` rejects a report that omits an id.

### Root cause (defect tasks)

When `reports/NNN-debug.md` exists (the implementer's debug-proof result, A35: the task fixes a defect),
`COMPLETION_REPORT.md` has a `## Root cause` section of exactly one sentence that names the function or
symbol at fault and what it did wrong (for example: `parse_range` treats the end index as exclusive where
the caller passes an inclusive one). The sentence comes from the debug-proof result, not from the diff; the
report is English. The regression test and the gates stay in their own sections. The final message to the
user repeats the same sentence in the user's language (symbol names untranslated), then the regression
test, the gates, and that commit and push await the user's approval. `A publish-completion-report` requires
the section when `reports/NNN-debug.md` exists.

## 3. Final report to the user

In the user's language, after cleanup or at a terminal state: outcome (DONE, FAILED, BLOCKED), branch,
gates (each: pass, waived with id, failed with open finding ids), fix rounds used, which model on which
runtime did what (from `## Execution`), waivers, failovers, and the next action the user can take
(deliver, review the open findings, answer a question). For a defect task it also gives the one-sentence
root cause of section 2 and the regression test. No raw output.

**Commands proposal.** If `commands.build`, `commands.test` or `commands.lint` are empty in
`.agents/config.yaml` and the run discovered a command for one of them and proved it (the exact command passed
in a recorded implementer, QA or verifier step), ask the user ONE question at the end of the run, after cleanup
(the config is locked during a run): the command per key, recommended answer "write them". On yes, edit only
those empty keys in `.agents/config.yaml`; on no or no answer, change nothing. Never propose an unproven
command or replace a configured one.

A key can hold a list (A173, a project with several stacks). When the run proved several commands for one key (for example
a .NET build and an npm build), propose them as one list and write a block list (`build:` then one `    - command` line
each); one proven command stays a single `build: command`. The same question covers a key that is not empty but lacks a
command the run proved for another project of the repository (discovery proposes nothing for an ambiguous target, for
example two solutions): offer to append it to the key (the configured command first, the proven one after it, turning a
single command into a list); never reorder or remove a configured command. Run `agent.sh config-check` after the edit.
