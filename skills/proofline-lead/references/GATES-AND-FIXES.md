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

Advisory request (A373): when `A next` prints `agent.sh advisory-check <ID>` before a `--focus dependencies` dispatch (only when the user set `security.advisory_check: on`), run it once before that dispatch. It is the control plane's one counted request (the security reviewer has no network and reads `ADVISORY_CHECK.json`); never run it in the user's name, never edit `security.*` yourself, and tell the user in one line when it says `not_run` and why.

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

`next` prints `agent.sh handoff <ID> IMPLEMENTING (fix round <n>; findings of: <GATES>)`. After a `reopen`, `next` prints a `note=` line instead: the findings recorded before the reopen still describe the unchanged content, and the same `handoff <ID> IMPLEMENTING` opens the fix round from them without dispatching those gates again (A353). To have the same tree reviewed again without a code change, `A handoff <ID> IMPLEMENTED --re-review` with a `reason:` on stdin (once per finding record).

1. **Diagnose** each blocking finding from its row only: implementation defect -> fix round;
   plan or evidence defect (a row on PLAN.md or another control artifact, e.g. the plan's `## Verification
   commands` do not cover an AC) -> `next` prints `amend PLAN.md ## Verification commands` instead of a fix
   round: write `amendments/<NNN>.md`, edit PLAN.md (the lead owns both; `amend` works from CODE_DONE only),
   `agent.sh refreeze <ID> <AMENDMENT>`. A plan test name that still has no duration after GREEN is re-recorded with the project test command (`handoff IMPLEMENTED` says the plan wording is probably wrong) has the same remedy, also from IMPLEMENTING (the `amend` command is CODE_DONE only; the `GREEN rerun` applies only after a REVIEW_TESTS failure): put the real quoted test title before the dash. (A358: at `handoff IMPLEMENTED` the control plane runs the plan-listed Verification commands itself and records the durations under the plan's test names; you re-record GREEN by hand only when a plan test still has no duration after that, and a listed command that fails is a normal fix.) A `scope` approval is needed only if the amendment adds scope
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
   into `ALLOWED_SCOPE`, do not work them out by hand. The fix must change the tree and stay inside that scope. One exception (A325): when the only open finding is a REVIEW_TESTS `not_measured` finding `no_recorded_duration` (a plan-named test has no recorded duration) and the task patch is the reviewed one, the implementer runs `A worker-evidence <ID> GREEN rerun` instead of editing: the control plane runs the plan-listed commands and records the durations itself (a fix round, one per `handoff IMPLEMENTING`, no approval, no gate pass), `A handoff <ID> IMPLEMENTED` is then accepted on the unchanged tree and the reviewer dispatches again. Any other finding (security, secrets, correctness, `command_not_double_run`, verifier, scope) still needs a tree change. A `command_not_double_run` finding (an implementer's GREEN with a command that is neither plan-listed nor the project test command) is cured by recording GREEN again with a plan-listed or project test command and the durations of all the tests the narrow record claimed; the narrow record is then superseded (A336) and no longer demanded. A path
   the plan never scoped needs the user's scope approval (`A ask` with the D13 block), then a PLAN.md amendment and
   `A refreeze`; `amend` is for CODE_DONE/DONE runs only.
4. `A handoff <ID> IMPLEMENTED`, `A tier <ID>`, `A pipeline <ID>`. Every gate is now `stale` or `missing`
   (any byte change); re-run exactly the gates that are not `pass`/`waived`.
5. Round 2 sets `escalation=yes`; `decide` adds `fix_round_2` (a stronger effort step for the implementer and the
   re-run gates; a repeated role never runs above its first attempt or `execution_policy.repeat_model_cap`, A362). Never pass a stronger model by hand.
6. **Exhausted:** after `review.max_fix_rounds` rounds with open findings, `next` prints
   `agent.sh terminate <ID> FAILED`. Run it with stdin `reason: <specific>` and `evidence: <open finding ids
   and the rounds used>`; report every open finding and why it stayed open; commit and push stay locked.
   Never open another round, never ask for a waiver to escape the bound.
7. **Test review cap (A359, A379).** The tests review loop has its own caps: the plan's `## Test review budget` `rounds`
   (else `test_trust.review_rounds`) and `minutes` (else `test_trust.review_minutes`), the minutes counted by the
   control plane from the loop's first recorded tests reviewer dispatch (so record it: `dispatch.sh`, or
   `decide <ID> reviewer --focus tests --agent-path` right before the Agent call). When `handoff <ID> IMPLEMENTING` or `--re-review` says
   `test review cap reached`, REVIEW_TESTS still fails and nothing passes: relay the recorded question
   (`agent.sh questions <ID>`) once, verbatim. A larger cap is an amendment of the plan's `## Test review budget`
   (the usual `amend`/`refreeze` and the user's approval); accepting residual survivors is `agent.sh waive` with
   the user's own words naming each mutant (never SECURITY or SECRETS); otherwise `agent.sh terminate`. Do not
   type a cap yourself, and do not run `raise-budget` for a budget the user already approved: the control plane
   applies it at the freeze and at `handoff IMPLEMENTED`.
8. **Weight (A364).** `agent.sh pipeline <ID>` prints `profile=light|full`, `mutation_testing=on|off` and `design_group=optional|off`
   (with `profile_reason=` when full) and `max_fix_rounds`, `max_mutants` of the class (COMPLEX and CRITICAL 3 and 30, else 2 and 20). Light
   (type content or docs, TRIVIAL or STANDARD, only documentation text and images in the plan and the diff) only removes the mutation budget
   approval need and, by your instruction, the mutation testing of REVIEW_TESTS and the optional design group of QA visual (the control plane does not enforce
   that they skip them): tell the reviewer and QA so in the dispatch, from that output, never from
   your own judgement. Every gate stays. The plan approval request prints a forecast from earlier runs of the class and the test review
   budget: relay both verbatim. `max_scope_paths` does not count tests and fixtures.

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
2. The command checks the plan and the scope, then asks ONE question and stops: the reopen, and in the same
   summary the mutation-budget decision when PLAN `## Tests` names more criteria than the budget ("raise the budget to
   N and reopen the run?"). Relay the question verbatim, STOP; the runtime records the user's one reply as both
   approvals (the lead never runs `approve`). After the reply run the same command again. It refuses when the plan or the task changed since the freeze, when the
   branch is not the task branch, or when files outside the frozen scope changed (the scope check lists them).
3. Reopened: the plan stays frozen and the fix-round allowance restarts at 0 (`review.max_fix_rounds` is
   unchanged). `A next <ID>` then names only the gates that did not pass (failed, BLOCKED, never recorded) or
   whose inputs changed. A gate that passed on unchanged inputs stays. A change confined to the control plane never makes
   a gate stale and never blocks the reopen: `.agents/`, the files `proofline upgrade` installs (`.claude/agents/proofline-*.md`,
   `.codex/agents/proofline-*.toml`, the entry skill) and the proofline block of `AGENTS.md`/`CLAUDE.md` (A154). A path the
   plan scope names stays tracked; edits outside the block (for example `## Project rules`) are product changes.
4. The knowledge step restarts (`not_started`). When every gate passes: `handoff CODE_DONE`, knowledge, report,
   DONE, then `deliver`.
