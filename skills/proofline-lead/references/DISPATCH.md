# Dispatch: runtime choice, assignment, results

`A` = `.agents/scripts/agent.sh`, `D` = `.agents/scripts/dispatch.sh`. One dispatch = one specialist step on
one runtime. Specialists never dispatch anyone (no swarm, no recursion).

## 1. Which path (D6)

1. Role runtime: `A config-get runtime.roles.<role>`; empty -> the group key:
   `runtime.reviewers` for `reviewer security_reviewer qa verifier`, `runtime.worker` for every other
   specialist (`task_author explorer architect data_architect designer implementer`). Empty -> `claude`.
2. Path:

| Lead | Role runtime | Path |
|---|---|---|
| Claude Code | `claude` | **Agent path**: `A decide <ID> <role> [--focus F]` exactly once; take `model=` (and `effort=`) from its output; call the Agent tool with `subagent_type` = `proofline-<role>` with `_` written as `-` (`proofline-security-reviewer`; plugin install: `proofline:proofline-security-reviewer`; use the name the Agent tool lists), `model` = the decided model, `prompt` = the assignment. |
| Claude Code | `codex` or a command-template runtime | **dispatch path**: `D <ID> <role> [--focus F] --prompt-file <assignment file>`. |
| Codex, terminal agent | any | **dispatch path**. |

- Never call `A decide` before `D` (also not for a failover from the Agent path): dispatch.sh decides
  itself, and a second decision is ledgered and can spend the escalation budget twice. Never run both
  paths for one step.
- Recording: Agent path -> the SubagentStop hook pipes the subagent's last message to `A record` with
  `AGENT_ROLE` from the subagent type. dispatch path -> dispatch.sh records. The lead records nothing.
- Exit codes of `D`: 0 recorded, 1 task failure or record rejected, 2 usage/config, 5 NEEDS_INPUT, 6
  BLOCKED, 124 timeout. 5 -> the question is already pending (`A ask` by dispatch.sh or the specialist's
  NEEDS_INPUT): [HANDOFF.md](HANDOFF.md); 6 -> read `BLOCKED_REASON` from check-result; 124 -> re-dispatch
  once, then BLOCKED.
- Parallel: explorers (up to `pipelines.<CLASS>.max_explorers`) and gate roles (up to
  `budgets.max_parallel_reviewers`) in one message / as background commands. Everything else is sequential.
- `A decide` is lead-only and is never re-run to obtain a different model; overrides
  (`--model`, `--effort`, `--runtime`) only on the user's instruction, passed to `decide` or `D` once.

## 2. The assignment

The whole prompt a specialist gets after its role instructions. Keys in this order, one per line; a key
that does not apply is omitted, never left empty. Plain text, at most what the step needs. On the dispatch
path the file goes to `.agents/local/assignments/<ID>/<NNN>-<role>[-<focus>].md` (never inside the run
directory, never `$TMPDIR`: the runtime hook lets the lead write inside `.agents/local/` only under
`.agents/local/assignments/`) and the first four keys are omitted because dispatch.sh writes them.

```
TASK: <ID>
ROLE: <role id>
FOCUS: <plan|rules|tests|data|rules+tests>          reviewer only (REVIEW_RULES = rules, run as proof-review focus rules+bugs)
RUN_DIR: .agents/runs/<ID>
OBJECTIVE: <one sentence: what this step must produce>
ALLOWED_SCOPE: <space-separated repo paths>          explorer: read scope; implementer: frozen scope or the round's fix_scope; others: omit (role default)
READ: <space-separated run artifacts>                 only those the role's `reads:` names and that exist
WRITE: <run-relative path>                            the one owned artifact (implementer: "product code in ALLOWED_SCOPE" + worker-evidence)
SKILL: <skill name> team mode
FIX_ROUND: <n>                                        fix rounds only
FINDINGS:                                             fix rounds and gate re-runs only: the failing rows verbatim
| id | severity (blocking\|info) | path:line | finding | evidence |
|---|---|---|---|---|
| ... |
FILES_CHANGED: <paths changed in the previous round>  fix rounds and gate re-runs only
ANSWERS:                                              restart after NEEDS_INPUT only: the user's answers verbatim, numbered as the questions
1. <user's answer text>
STOP: <one sentence: when to stop and return>
USER_LANGUAGE: <BCP 47 code of the user's language>
```

Rules:

- Never include: the lead's conversation, another specialist's result body or transcript, raw logs, a
  diff, file contents, or an opinion about the expected verdict. Artifacts are named, not pasted.
- `FINDINGS` carries only table rows (never a reviewer's prose). A re-run gate role gets its own previous
  rows; the implementer gets the union of the failing gates' rows.
- `USER_LANGUAGE` is always present: specialists write `QUESTIONS:` in it; every other line stays English.
- Defaults per role (from the role sources):

| Role | OBJECTIVE / WRITE / STOP default |
|---|---|
| task_author | write TASK.md for the request / `TASK.md` (+ `design/INTENT.md` with intent-grill) / canonical sections complete or questions |
| explorer | answer one evidence question / `results/NNN-explorer.md` / the evidence-map stop condition |
| architect | `## Architecture` text / `design/ARCHITECTURE.md` / sections drafted |
| data_architect | `## Data` text / `design/DATA.md` / migration plan classified |
| designer | `## UI` text / `design/UI.md` / spec complete |
| qa (plan) | QA scenarios for each AC / `QA_PLAN.md` / every AC covered |
| implementer | implement the frozen plan / product code in scope / every scope path has RED+GREEN or the round's findings are fixed |
| reviewer | gate `REVIEW_<FOCUS>` / `reviews/proof-review/<dir>/REPORT.md`, `reviews/test-trust/tests/REPORT.md` or `reviews/data-design/REVIEW.md` / gate rule applied |
| security_reviewer | gate `SECURITY` / `security/REPORT.md` / gate rule applied |
| qa (gate) | gate `QA` / `QA_REPORT.md` / every frozen scenario run |
| verifier | gate `VERIFY` / `VERIFY.md` / every AC proven or failed |

## 3. Implementer

Exactly one per run at a time, and only in this worktree.

- The implementer's write window is opened and closed by the runtime, never by the lead: Agent path ->
  the SubagentStart / SubagentStop hooks; dispatch path -> `dispatch.sh`. The lead calls neither
  `window-open` nor `window-close` and makes the dispatch call exactly once per step. The designer's
  writes are bracketed the same way.
- A failed implementer's partial edits stay for inspection; undoing them is destructive (user approval).
- Fix rounds: a new implementer call with `FIX_ROUND`, `FINDINGS`, `FILES_CHANGED`, `ALLOWED_SCOPE` = the
  union `fix_scope` (codex runtime: dispatch.sh continues the same thread when it supports it).

## 4. Consuming a result

- Agent path: the subagent's final message is the header + table; read nothing else. dispatch path:
  `node <skill-dir>/scripts/check-result.mjs .agents/runs/<ID>/results/dispatch-<NNN>-<role>-<runtime>.md
  --role <role> --task <ID>` and read only its JSON.
- Whether it counted: `A pipeline <ID>` (gate status) or `A next <ID>`; never the result's own words.
- check-result exit 1 (malformed): the record was rejected too; re-dispatch once with the messages in
  `FINDINGS`-free form ("your last result was rejected: <messages>"); a second failure is BLOCKED.
