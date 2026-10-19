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
   plan or evidence defect (a row on PLAN.md or another control artifact, e.g. the plan's `## Verification
   commands` do not cover an AC) -> `next` prints `amend PLAN.md ## Verification commands` instead of a fix
   round: write `amendments/<NNN>.md`, edit PLAN.md (the lead owns both; `amend` works from CODE_DONE only),
   `agent.sh refreeze <ID> <AMENDMENT>`. A `scope` approval is needed only if the amendment adds scope
   paths. The refreeze is not the end: the new plan hash voids the worker evidence and every gate, so
   `dispatch.sh <ID> implementer` re-records RED and GREEN (a real failing test, then a real change; a path
   with a `tdd_exemption` needs none), then `handoff <ID> IMPLEMENTED`, then every gate again, VERIFY
   included. A commands-only amendment on a non-exempt path has no honest RED: complete `## Verification
   commands` before freeze. If the verifier merely failed to cite a configured or planned command (A107
   rows), re-dispatch it instead. Never a silent fix; environment -> BLOCKED. A fix round never lists PLAN.md,
   VERIFY.md or another control artifact as a `fix_path` (A127). debug-proof may locate the cause; it never
   edits code.
2. **Reopen:** `A handoff <ID> IMPLEMENTING`.
3. **One implementer round** ([DISPATCH.md](DISPATCH.md#3-implementer)): `FIX_ROUND: <n>`, `FINDINGS:` the
   rows of every failing gate on this content, `FILES_CHANGED:` the paths the previous round changed,
   `ALLOWED_SCOPE:` the union `fix_scope` of those rows (a row without a path allows any frozen scope
   path), plus the frozen plan scope paths that share an acceptance criterion with a path of those rows (A123).
   `next` prints that computed list as `fix_path=<path>` lines (`fix_path=*`: any frozen scope path); paste them
   into `ALLOWED_SCOPE`, do not work them out by hand. The fix must change the tree and stay inside that scope. A path
   the plan never scoped needs the user's scope approval (`A ask` with the D13 block), then a PLAN.md amendment and
   `A refreeze`; `amend` is for CODE_DONE/DONE runs only.
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

## 5. Reopen a FAILED or BLOCKED run

`terminate` is not final (A152). `/proofline reopen <ID>` takes a run that ended FAILED or BLOCKED back to the state
it was in, but only with the user's approval, and `deliver` stays refused until the run is CODE_DONE again.

1. Start with the cause: a fixed tool, a raised budget, a changed environment. Write one specific reason (what
   changed since the run ended): `printf 'reason: <what changed>\n' | A reopen <ID>`.
2. The command asks, in this order, and each time stops with the question: the mutation-budget decision first
   (`mutation_budget`, only when PLAN `## Tests` names more criteria than the budget), then `reopen:<ID>`. Relay
   the question verbatim, STOP; the runtime records the user's reply (the lead never runs `approve`). After each
   reply run the same command again. It refuses when the plan or the task changed since the freeze, when the
   branch is not the task branch, or when files outside the frozen scope changed (the scope check lists them).
3. Reopened: the plan stays frozen and the fix-round allowance restarts at 0 (`review.max_fix_rounds` is
   unchanged). `A next <ID>` then names only the gates that did not pass (failed, BLOCKED, never recorded) or
   whose inputs changed. A gate that passed on unchanged inputs stays. A change confined to `.agents/` (the control
   plane, `proofline upgrade` included) never makes a gate stale.
4. The knowledge step restarts (`not_started`). When every gate passes: `handoff CODE_DONE`, knowledge, report,
   DONE, then `deliver`.
