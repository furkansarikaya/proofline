# Gates, fix loop, waivers (D14, D15, D16)

`A` = `.agents/scripts/agent.sh`.

## 1. Which gates

After `A handoff <ID> IMPLEMENTED`: `A tier <ID>`, then `A pipeline <ID>`. `gates=` lists the required
gates; `gate.<GATE>=` their status. Never compute the tier or the gate set yourself.

| Gate | Required | Run by | Assignment |
|---|---|---|---|
| `SECRETS` | always | `A secret-scan <ID>` (script, by the lead) | none |
| `REVIEW_SMALL` | tier small | reviewer, proof-review `rules+tests` | `FOCUS: rules+tests`; artifact `reviews/proof-review/small/REPORT.md` |
| `REVIEW_PLAN` | tier full | reviewer, proof-review `plan` | `FOCUS: plan`; `reviews/proof-review/plan/REPORT.md` |
| `REVIEW_RULES` | tier full | reviewer, proof-review `rules+bugs` | `FOCUS: rules` (the header says rules); `reviews/proof-review/rules/REPORT.md` |
| `REVIEW_TESTS` | tier full | reviewer, test-trust diff | `FOCUS: tests`; `reviews/test-trust/tests/REPORT.md` |
| `REVIEW_DATA` | tier full and PLAN has `## Data` | reviewer, data-design review | `FOCUS: data`; `reviews/data-design/REVIEW.md` |
| `SECURITY` | tier full | security_reviewer, exploit-proof | none; `security/REPORT.md` |
| `QA` | STANDARD and up | qa | `OBJECTIVE: run the frozen QA plan`; `QA_REPORT.md`; finding ids `QA-<n>` |
| `VERIFY` | always | verifier | none |

Dispatch every non-passing gate role in parallel (at most `budgets.max_parallel_reviewers` at once) after
`A secret-scan`. Gates have no order. Then `A pipeline <ID>` and `A next <ID>`.

## 2. Status -> action

| `gate.<G>=` | Action |
|---|---|
| `pass`, `waived` | none |
| `missing`, `stale` | dispatch the gate role (SECRETS: `A secret-scan`) |
| `pass_low` | re-run the same gate role on the same content; the escalation comes from `A decide` (signal `low_confidence_pass`) on the Agent path or from dispatch.sh. It never counts as a pass, also not in the report. |
| `fail` | the fix loop (section 3) |

A gate role returning `BLOCKED` records no gate: fix the cause and re-dispatch once, else
`A terminate <ID> BLOCKED`. A security reviewer that cannot reach its capability floor is BLOCKED; never
re-run it on a weaker model (D7).

## 3. Fix loop

`next` prints `agent.sh handoff <ID> IMPLEMENTING (fix round <n>; findings of: <GATES>)`.

1. **Diagnose** each blocking finding from its row only: implementation defect -> fix round;
   plan or evidence defect (the frozen plan cannot satisfy the criterion) -> amendment with a `scope`
   approval when paths are added, never a silent fix; environment -> BLOCKED. debug-proof may locate the
   cause; it never edits code.
2. **Reopen:** `A handoff <ID> IMPLEMENTING`.
3. **One implementer round** ([DISPATCH.md](DISPATCH.md#3-implementer)): `FIX_ROUND: <n>`, `FINDINGS:` the
   rows of every failing gate on this content, `FILES_CHANGED:` the paths the previous round changed,
   `ALLOWED_SCOPE:` the union `fix_scope` of those rows (a row without a path allows any frozen scope
   path). The fix must change the tree and stay inside that scope.
4. `A handoff <ID> IMPLEMENTED`, `A tier <ID>`, `A pipeline <ID>`. Every gate is now `stale` or `missing`
   (any byte change); re-run exactly the gates that are not `pass`/`waived`.
5. Round 2 sets `escalation=yes`; `decide` adds `fix_round_2` (stronger model for the implementer and the
   re-run gates). Never pass a stronger model by hand.
6. **Exhausted:** after `review.max_fix_rounds` rounds with open findings, `next` prints
   `agent.sh terminate <ID> FAILED`. Run it with stdin `reason: <specific>` and `evidence: <open finding ids
   and the rounds used>`; report every open finding and why it stayed open; commit and push stay locked.
   Never open another round, never ask for a waiver to escape the bound.

## 4. Waivers

Only on the user's explicit instruction, finding by finding, with a reason; `approve` and `waive` verify it
against the hook-captured user prompt.

1. The user's message names the finding id (e.g. `REVIEW_RULES-2`) and says to waive it, with a reason.
   The lead never proposes a waiver as a way out and never waives on its own; it only runs `A waive`.
2. Refuse at once for any `SECRETS-*` or `SECURITY-*` finding (never waivable) and for a finding that is not
   a blocking finding of a `fail` gate on the current content.
3. `A request-approval <ID> waive:<FINDING-ID>`, relay verbatim; the runtime records the approval from
   the reply (the lead never runs `approve`); then `A waive <ID> <FINDING-ID> --reason "<the user's reason, at least 20 characters>"`.
4. A gate counts as `waived` only when every blocking finding of its record is waived; one unwaived
   finding keeps it closed. Every waiver goes into `## Waivers` of the completion report; with
   `review.waiver_followup: task` agent.sh writes a follow-up task.
