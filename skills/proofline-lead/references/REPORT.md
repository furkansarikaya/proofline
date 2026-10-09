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
| TDD Evidence | `worker-evidence/` (RED/GREEN per scope path, exemptions from PLAN.md) |
| Verification | `VERIFY.md` header (result, confidence) and `## Verification commands` |
| Review Result | `A pipeline <ID>` final statuses; per gate: result, confidence, fix round, finding ids; `pass_low` is listed as not counted |
| QA Result | `QA_REPORT.md` header (STANDARD and up) |
| Waivers | `waivers/*.yaml`: finding id, gate, the user's reason, approval |
| Execution | `decisions/*.decision` and ledger `decide` / `failover` rows: role, focus, runtime, model, effort, signals, escalations, failovers |
| Amendments, Reopen History | `amendments/`, ledger |
| Known Limitations / Follow-up | open `info` findings, follow-up tasks from waivers |

## 3. Final report to the user

In the user's language, after cleanup or at a terminal state: outcome (DONE, FAILED, BLOCKED), branch,
gates (each: pass, waived with id, failed with open finding ids), fix rounds used, which model on which
runtime did what (from `## Execution`), waivers, failovers, and the next action the user can take
(deliver, review the open findings, answer a question). No raw output.
