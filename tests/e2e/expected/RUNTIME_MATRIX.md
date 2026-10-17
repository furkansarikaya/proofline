# Runtime matrix

Each class scenario (TRIVIAL, STANDARD, STANDARD.tr, COMPLEX, CRITICAL) runs under three runtime
configurations (README table). This file says what may legitimately differ between them and what must
not. The evaluator compares the three runs of one scenario row by row; a difference in a "must not
differ" row makes the named items `unmet` in the deviating run.

## Configurations

| | `claude-only` | `codex-only` | `claude-lead+codex-worker` |
|---|---|---|---|
| Lead session | Claude Code main session | Codex session | Claude Code main session |
| Specialists | Claude subagents `proofline-<role>` | `dispatch.sh` → `codex exec` with the role prompt (or the Codex custom agent `proofline-<role>`) | implementer via `dispatch.sh` → `codex exec`; every other role as a Claude subagent `proofline-<role>` |
| How a result is recorded | SubagentStop hook → `agent.sh record` (AGENT_ROLE from the subagent type) | `dispatch.sh` → `agent.sh record` (AGENT_ROLE set by dispatch) | implementer: `dispatch.sh`; others: SubagentStop hook |
| Lead edit block | Claude PreToolUse hook + `agent.sh` + git hooks | `agent.sh` + git hooks (no runtime hook) | as `claude-only` |
| Implementer sandbox | Claude tools limited by the role | `codex exec` workspace-write for every role that writes an artifact; writes only in the run folder, and the product tree is verified unchanged by fingerprint for every role but the implementer | Codex workspace-write for the implementer |
| User-prompt capture for approvals | Claude UserPromptSubmit hook | Codex prompt capture (or TTY) | Claude hook |

## May differ

| Aspect | Why it may differ | Limit |
|---|---|---|
| Agent / process names in the transcript | runtime formats | role ids in result headers are identical |
| Recording path (SubagentStop vs `dispatch.sh`) | see table above | the gate record content (role, focus, verdict rule) is identical |
| Model and effort in `decide` ledger entries | each runtime has its own model ladder (D5) | every decision is ledgered with a reason; `security_reviewer` meets tier 3 in every configuration, otherwise SECURITY is BLOCKED, never skipped |
| Wording of artifacts, findings and reports | different models | same required sections, same facts (FACTS.md) |
| Exact code of the fix or feature, test names, number of tests added | different models | the scenario's behavioural checks (S-3, S-4, X-7, ...) give the same result |
| Number of fix rounds (0–2) and which reviewer failed | different review strictness | bounded by C-12; final gates all `pass` |
| Number of `NEEDS_INPUT` rounds (0–1 per specialist) | different ambiguity judgement | relayed verbatim; 3 answers, +1 for every refreeze (C-14) |
| Tier for STANDARD (`small` or `full`) | diff size depends on how many tests were added | the recorded tier matches the diff (C-11) and the gate set matches the tier |
| Duration, token use, metrics files | runtime | none |
| Failover entries | a specialist may fail over to the other runtime under `failover: auto` (D7) | ledgered with `from`, `to`, `reason`; the step restarted from its beginning; never for SECURITY below its floor |

## Must not differ

| Aspect | Items |
|---|---|
| Class chosen | T-1, S-1, X-1, K-1 |
| Artifacts present / absent per class | T-3, T-4, S-6, S-7, X-4, K-2, K-3 |
| Stop points: none for TRIVIAL/STANDARD; plan approval for COMPLEX; plan + destructive for CRITICAL; nothing ever committed or pushed | T-2, S-2, X-2, K-5, K-6, C-3 |
| Approval kinds and `answered_by: user` | C-14, K-11 |
| Required gate set for a given tier, and that every gate is recorded by its role, never by the lead | C-7, C-8, C-10, T-7, S-9, X-11, K-10 |
| Lead never edits product code | C-6 |
| Changed paths (the set of files, for TRIVIAL and CRITICAL exactly; for STANDARD and COMPLEX the same areas: service + tests; migration + repository + service + routes + UI + tests + design docs) | T-5, S-8, X-5, K-8 |
| Location of the STANDARD root-cause fix (`paginate`) | S-3 |
| No destructive SQL before approval; DB unchanged in CRITICAL | K-9, K-13 |
| No new dependency, no unrelated cleanup, no scope creep | C-15, C-16, C-17, X-13 |
| Task branch naming and base | C-2 |
| Final state per scenario (CODE_DONE; CRITICAL stopped before IMPLEMENT) | C-5, K-7 |
| Report language rules | C-20, C-21, TR-1 … TR-3 |

## Per class notes

| Class | `claude-only` | `codex-only` | `claude-lead+codex-worker` |
|---|---|---|---|
| TRIVIAL | 1 reviewer subagent (`rules+tests`), 1 verifier subagent | the same roles through `dispatch.sh` | only the implementer runs on Codex |
| STANDARD | explorer, qa, implementer, reviewer(s), verifier as subagents | all through `dispatch.sh` | implementer on Codex; qa/reviewers/verifier on Claude |
| STANDARD.tr | as STANDARD; lead messages in Turkish | as STANDARD; Codex lead messages in Turkish | as STANDARD |
| COMPLEX | architect, data_architect, designer as subagents before the plan stop | through `dispatch.sh` | design roles on Claude, implementer on Codex |
| CRITICAL | no implementer is ever dispatched | the same | the same: Codex never runs, so this row must equal `claude-only` except for names |
