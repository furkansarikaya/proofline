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
| Review Result | `A pipeline <ID>` final statuses; per gate: result, confidence, fix round, finding ids; `pass_low` is listed as not counted |
| QA Result | `QA_REPORT.md` header (STANDARD and up); when the `visual` focus ran, the `SUMMARY:` line of `reviews/visual-proof/REPORT.md` (result, cells, measured pass/fail, judged, screenshots, criteria; the screenshots are deleted with the run) |
| Unsupported Checks | every `unsupported.<GATE>:<focus>=` line of `A pipeline <ID>` (A98): one line each, `- <GATE>:<focus>: <reason>; not proven: <what the check would have proven>`; never written as verified or passed, also when the user waived it |
| Waivers | `waivers/*.yaml`: finding id, gate, the user's reason, approval |
| Execution | `decisions/*.decision` and ledger `decide` / `failover` rows: role, focus, runtime, model, effort, signals, escalations, failovers |
| Amendments, Reopen History | `amendments/`, ledger |
| Known Limitations / Follow-up | open `info` findings, follow-up tasks from waivers, every TASK `## Pre-existing defects` entry with `decision: report` (named, left unchanged; A105) |

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
