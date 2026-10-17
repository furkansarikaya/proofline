# Protocols: result (D12) and handoff (D13)

## Result

A specialist reports its result with `agent.sh submit` (below); it never types the header. The script builds
the header, stores the message as `reports/NNN-<role>.result.md` and validates it with `record`'s rules, so a
format error cannot be made. The header, one key per line, no blank line inside, in this order:

```
ROLE: <role id>
TASK: <TASK-ID>
FOCUS: <plan|rules|tests|data|rules+tests>     reviewer gate results only
RESULT: <PASS|FAIL|BLOCKED>                    gate results: reviewer, security_reviewer, verifier, qa
RESULT: <DONE|BLOCKED|NEEDS_INPUT>             task results: every other role, and qa's QA-plan step
CONFIDENCE: <high|medium|low>
FINGERPRINT: <output of agent.sh fingerprint <TASK-ID>>
ARTIFACT: <run-relative path, e.g. reviews/proof-review/small/REPORT.md> <sha256>
```

Then the findings table (header row always present, zero rows allowed), then optional lines:
With no findings, output only the table header row.

```
| id | severity | path:line | finding | evidence |
|---|---|---|---|---|
| REVIEW_RULES-1 | blocking | src/cart.ts:42 | total ignores the discount | traced: applyDiscount() result unused |

BLOCKED_REASON: <one line>                     with RESULT: BLOCKED
QUESTIONS:                                     with RESULT: NEEDS_INPUT (format below)
```

- `severity` is `blocking` or `info`. `info` never fails a gate (suspicions, pre-existing failures).
- Finding ids: `<GATE>-<n>` for gate results (`SECURITY-1`), `<role>-<n>` otherwise (`explorer-2`).
- `FINGERPRINT` is the git tree id of the working tree including untracked files, excluding `.agents/runs/`
  and `.agents/local/`; any byte change produces another value.
- `ARTIFACT` may use an absolute path or a project-relative `.agents/runs/<TASK-ID>/...` path that resolves inside the run directory; `record` normalizes it to a
  run-relative path before checking role ownership and writing the gate record.

### Submitting (`agent.sh submit <ID>`)

```
AGENT_ROLE=<role> sh .agents/scripts/agent.sh submit <ID> --agent <token> [--focus F] [--result R] \
  --confidence high|medium|low [--artifact PATH] [--findings FILE|-] [--reason TEXT] [--questions FILE] \
  [--evidence PATH[@SHA256]]... [--validator-result PASS|FAIL]
```

- The script supplies `ROLE` (from `AGENT_ROLE`), `TASK`, `FINGERPRINT` (current content) and the artifact's
  run-relative path and sha256. `--artifact` may be given as an absolute path, `.agents/runs/<ID>/...`,
  `./...` or run-relative; it may be omitted where the role and focus have one report path
  (reviewer focus, `SECURITY`, `QA`, `VERIFY`, the QA plan step).
- `--findings` rows are `severity|path:line|finding|evidence` (an id column and a markdown table are
  tolerated); ids are assigned (`<GATE>-<n>` or `<role>-<n>`). For a gate role `RESULT` follows from the
  findings (FAIL exactly when a `blocking` row exists); a contradicting `--result` is rejected. `BLOCKED` takes
  `--reason`; if the report does not exist the script writes the reason into it.
- `--findings none` is zero rows. Only one of `--report`/`--findings` may read stdin (`-`); two stdin sources are refused
  before stdin is read, except one document with the report, a line `=== FINDINGS ===`, then the rows (A104).
- Evidence is re-derived, never taken on the report's word (A107). `submit` runs the skill's own validator
  for the role and focus (verifier: `validate-verify.mjs`; reviewer `tests`: test-trust `gate.mjs`; reviewer
  `plan`, `rules`, `rules+tests`: proof-review `validate-findings.mjs` and `gate.mjs` over its `findings.json`)
  and uses its result; a `--validator-result` that differs, or a PASS the validator computes as FAIL, is
  refused naming both. Every cited evidence file (`--evidence PATH[@SHA256]`, or `PATH@<sha256>` in a row's
  evidence column or the report) must exist inside the run, in a folder the role reports in (or `reports/`,
  `worker-evidence/`), with the cited hash; the result records `EVIDENCE: <path> <sha256>` and `record` checks
  it again. A PASS then re-runs the recorded `reproduced` items (the verifier's `## Commands` entries, or a
  cited file with `command:`, `exit:`, `output:` lines) when the command is the configured
  `commands.build|test|lint` or a frozen PLAN `## Verification commands` entry (AC-cited commands always, the
  rest up to three); a different exit status, a missing recorded output line or an output line that is not a
  whole line of the re-run output makes the result FAIL with a blocking finding. A gate that re-ran nothing
  records `NOT_RERUN` (info) and is not reproduced proof; a mapped focus whose installed validator cannot
  run refuses a PASS.
- `--focus` is required for a reviewer unless the artifact's directory implies it (also `PROOFLINE_FOCUS`).
- A rejection prints `submit rejected: <reason>` and exits 1 immediately, so the specialist fixes and submits
  again. The outcome (ok or rejected, with the reason) is also written to
  `.agents/local/submissions/<token>.status`; `<token>` is `PROOFLINE_AGENT` (set by `dispatch.sh`), unless the typed `--agent` id is a registered subagent (the hook wrote `<id>.started`); without `PROOFLINE_AGENT` it is `--agent` (A127).
- Runtime hooks and `dispatch.sh` read that status and never parse a final message. A specialist that stops
  without a recorded submission is sent back once with the last rejection (Claude SubagentStop block;
  `dispatch.sh` reruns the step once with the rejection in the prompt); a second miss is reported to the lead
  as "no result" and nothing is recorded.

### Recording (`agent.sh record <ID> [--file F]`, else stdin)

`record` is the validator `submit` calls with the header it built; it is also the stable low-level interface
for a message that already has the header. It is never the lead's. It records nothing and exits non-zero when:

- the message does not start with the header, or the header has unknown or duplicate keys, or lacks a
  required key;
- `ROLE` (aliases accepted) is not `AGENT_ROLE`, or `TASK` is not the run;
- `RESULT` is not valid for the role (the lead never records PASS/FAIL; reviewer, security_reviewer and
  verifier never return DONE or NEEDS_INPUT); a reviewer gate result has no valid `FOCUS`;
- `FINGERPRINT` differs from the current content (`stale`);
- `ARTIFACT` is not a registered file inside the run, its sha256 differs, or it lies outside the paths of
  the role and focus (reviewer `plan` -> `reviews/proof-review/plan/`, `rules` -> `reviews/proof-review/rules/`,
  `rules+tests` -> `reviews/proof-review/small/`, `tests` -> `reviews/test-trust/tests/`, `data` ->
  `reviews/data-design/`; security_reviewer -> `security/`; qa gate -> `QA_REPORT.md`, qa task ->
  `QA_PLAN.md`, `reports/`, `reviews/test-trust/qa/`; verifier -> `VERIFY.md`, `design/SYNC.md`; implementer
  -> `reports/`, `worker-evidence/`; task_author -> `TASK.md`, `design/INTENT.md`, `reports/`; explorer ->
  `reports/`; architect, data_architect, designer -> `design/`, `reports/`), so one focus never voids another;
- a finding row is malformed, has another id prefix or severity, or ids repeat; a FAIL has no blocking row; a
  PASS has a blocking row; BLOCKED has no `BLOCKED_REASON`; NEEDS_INPUT has no `QUESTIONS:` block;
- a gate result does not meet the gate preconditions (open run, required gate, handoff IMPLEMENTED,
  freshness, scope, seal, attested tree).

On success it keeps the raw message as `reports/NNN-<role>.result.md` (skills own `reports/NNN-<role>.md`),
and:

| Result | Effect |
|---|---|
| gate PASS, CONFIDENCE high/medium | gate record `pass` |
| gate PASS, CONFIDENCE low | gate record `pass_low` (does not satisfy the gate) |
| gate FAIL | gate record `fail` with findings and `fix_scope` (the bounded fix contract) |
| BLOCKED | no gate; the lead resolves it or terminates the run BLOCKED |
| NEEDS_INPUT | `questions/NNN.md` (verbatim) and `execution.awaiting_input: true` |
| DONE | stored only |

Every record is ledgered with the raw result sha256 and appends a metrics line.

`agent.sh gate <ID> <GATE> <pass|fail> [ARTIFACT]` remains for compatibility: same role and precondition
rules; the artifact needs exactly one `Verdict: PASS|FAIL` line matching the result; stdin `summary`, and
for a fail `findings` and `fix_scope`.

## Handoff (questions, D13)

A task role that needs the user writes its state to its artifacts and returns `RESULT: NEEDS_INPUT` with:

```
QUESTIONS:
1. Which default does an empty key return?
   options: nil | empty string
   recommended: nil
   why: AC-1 and the QA scenarios depend on it
```

1. `agent.sh questions <ID>` prints every pending question verbatim. The lead relays it unchanged; it never
   answers, summarizes or applies the recommended option by default.
2. `agent.sh answer <ID> <N>` reads the answer on stdin and writes `questions/NNN.answer.md` with
   `answered_by: user` only when the latest captured user prompt is not older than the question
   (`asked_at`, epoch seconds), its sha256 matches its text, and the answer text (whitespace-normalized,
   at least 3 characters) is contained in it; else `answered_by: lead`. When no question is pending, `awaiting_input` becomes false.
3. The lead restarts the specialist on the same run with an `ANSWERS` block; it resumes from its artifacts.

One round (C-14): a role gathers every open question first and returns them together, numbered, in one
NEEDS_INPUT result. `submit` (and `record`) reject a second NEEDS_INPUT from the same role in the same run (a
reviewer focus counts separately): after the first round the role, and any later instance of it, decides with the
recommended option it offered and says so, or returns BLOCKED with the reason. The script rule covers results
submitted inside a run (after `agent.sh start`); the pre-run intake (task author, intent-grill's own rounds) is
bound only by its own protocol. The lead's own `ask` is not limited. intent-grill's interview is exempt (A75): a
NEEDS_INPUT that the task author (only that role) submits with `--artifact design/INTENT.md` while that file's `## Status` is `in-progress`, through `submit` (the
check covers the snapshot `submit` makes of it), is neither counted nor refused, so the interview may run any number
of rounds, one question each, and does not use up the task author's own round.

The lead's own questions use the same format. Approvals (plan, destructive, scope, budget, waive, commit,
push): `request-approval` prints the question (`GATES.md` "Approvals"). Any other question of the lead (a
choice between plans, a scope change with options) and `dispatch.sh`'s failover question under
`failover: ask`: `agent.sh ask <ID> [--file F]` (lead only; stdin or the file; a leading `QUESTIONS:` line
is dropped; at least one `N. ` question) stores `questions/NNN.md` with `from` and `asked_at`, sets
`awaiting_input: true` and ledgers it, so `questions`, `answer` and `next` treat it like a specialist's.
While a question is pending, `CODE_DONE` FAILS and `next` points to it.
