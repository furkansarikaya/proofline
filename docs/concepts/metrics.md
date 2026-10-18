# Metrics and cost

The control plane records what each run and each specialist step cost, locally and best effort.
Everything lives in `.agents/local/metrics/` (git-ignored); `metrics: off` in `.agents/config.yaml`
disables all of it. A metrics failure never blocks a command.

Two files:

- `history.tsv` — one flat line per recorded specialist step and per finished run
  (`time task role runtime model duration_s outcome`). Kept for simple readers.
- `records.jsonl` — versioned records, one JSON object per line. This is the schema consumed by
  `proofline insights` (see below).

## Who writes a record

The control plane, from its own state and the runtime's structured output; no model-written text is copied into a
record. `dispatch` records come from the lead's `dispatch.sh` call by convention: `agent.sh metrics-dispatch` is a
lead-only command, but `AGENT_ROLE` is a declared claim, so the trust is the same as for `ledger-note`.

| `kind` | Written by | When |
|---|---|---|
| `dispatch` | `dispatch.sh` through `agent.sh metrics-dispatch` | one per `dispatch.sh` call once its first attempt has started (submitted, failed, timeout, blocked, needs_input); a call that exits on a usage error before any attempt writes none |
| `step` | `agent.sh` (`submit` / `record`) | one per recorded specialist result |
| `run` | `agent.sh` (`handoff DONE`, `terminate`) | once when the run ends |

## Record schema (`proofline.metrics/1`)

Every record has exactly these keys, in this order. A key that does not apply to the record kind, or whose value
the control plane did not observe, is `null`. The `schema` value changes when a key is renamed, removed or changes
meaning; adding a key keeps the version number only if existing keys are untouched and the new key is last.

| Key | Type | Meaning |
|---|---|---|
| `schema` | string | always `proofline.metrics/1` |
| `kind` | string | `dispatch`, `step` or `run` |
| `time` | string | UTC ISO-8601 time the record was written |
| `task` | string | run id (`[A-Za-z0-9_-]+`) |
| `role` | string or null | role (`reviewer`, `implementer`, ...); `lead` for `run` |
| `focus` | string or null | focus of the step (`rules`, `rules+tests`, ...) |
| `gate` | string or null | gate the role/focus belongs to (`REVIEW_RULES`, `SECURITY`, ...); null when none |
| `runtime` | string or null | `claude`, `codex` or a configured command-template runtime; for a failed-over dispatch, the runtime of the last attempt |
| `model` | string or null | model of the (last) decision |
| `duration_s` | integer or null | wall-clock seconds: `dispatch` = the whole `dispatch.sh` call including retries; `step` = decision to recorded result; `run` = first ledger entry to end |
| `tokens_in` | integer or null | `input_tokens` plus `cache_creation_input_tokens` of the run's own `usage` (not one turn of its `iterations`). Excludes cache-read tokens. A `step` record of a Claude subagent gets it from the subagent's session log (one count per message id) |
| `tokens_out` | integer or null | `output_tokens` the runtime reported (Claude: the run's own `usage`; a subagent step: its session log) |
| `tokens_total` | integer or null | total the runtime reported (Codex; the number after its `tokens used` line, in any local format such as 285.242 or 285,242), or `tokens_in + tokens_out` when both were reported |
| `turns` | integer or null | `num_turns` the runtime reported, summed over attempts |
| `retries` | integer or null | `dispatch` only: extra attempts of this dispatch (resubmission after no valid submission, or a failover re-run). `0` = first attempt succeeded or failed outright |
| `delegations` | integer or null | `run` only: number of specialist decisions (`decisions/NNN-*.decision`) in the run, i.e. delegated steps including repeats |
| `fix_rounds` | integer or null | `run` only: failing fix rounds used (`fix_rounds_used`) |
| `result` | string or null | `dispatch`: `submitted`, `failed`, `timeout`, `needs_input` or `blocked`; `step`: the recorded result lowercased (`pass`, `fail`, `done`, `blocked`, `needs_input`, ...) with the gate in `gate`; `run`: `done`, `failed` or `blocked` |

Example (one line each, wrapped here):

```json
{"schema":"proofline.metrics/1","kind":"dispatch","time":"2026-10-13T16:23:43Z","task":"ABC-1","role":"reviewer","focus":"rules","gate":"REVIEW_RULES","runtime":"claude","model":"sonnet","duration_s":212,"tokens_in":18420,"tokens_out":3105,"tokens_total":21525,"turns":6,"retries":0,"delegations":null,"fix_rounds":null,"result":"submitted"}
{"schema":"proofline.metrics/1","kind":"step","time":"2026-10-13T16:23:44Z","task":"ABC-1","role":"reviewer","focus":"rules","gate":"REVIEW_RULES","runtime":"claude","model":"sonnet","duration_s":215,"tokens_in":null,"tokens_out":null,"tokens_total":null,"turns":null,"retries":null,"delegations":null,"fix_rounds":null,"result":"pass"}
{"schema":"proofline.metrics/1","kind":"run","time":"2026-10-13T16:40:02Z","task":"ABC-1","role":"lead","focus":null,"gate":null,"runtime":"claude","model":null,"duration_s":1810,"tokens_in":null,"tokens_out":null,"tokens_total":null,"turns":null,"retries":null,"delegations":7,"fix_rounds":1,"result":"done"}
```

Join `dispatch` and `step` records of the same `task`, `role` and `focus` by order and time; the `dispatch`
record carries cost, the `step` record carries the gate verdict.

## Rules

- **Tokens and turns are never estimated.** Claude's `--output-format json` result (`usage`, `num_turns`) and Codex's
  `tokens used` trailer (the last non-empty lines of the log, after the final message when the log ends with it) are read when present. Numbers are never carried across runtimes: after a failover the record holds the last runtime's own. A runtime that reports nothing (a command-template runtime, a
  crashed process, a runtime version without the field) leaves the keys `null`. `null` is not zero: sum only the
  non-null values and report how many records had none.
- **No free text.** Findings, prompts, results and file paths are never written. Identifier strings (task, role,
  focus, gate, runtime, model, result) are reduced to the characters `[A-Za-z0-9._+:-]`, so a record holds short
  identifiers and numbers only. This limits what can leak; it is not a secret scanner. The directory is
  git-ignored (`.agents/local/`) and `proofline clean` removes it.
- **`metrics: off`** writes neither file, from `agent.sh` or `dispatch.sh`. Existing files are left alone.
- **Metrics never change a decision.** The execution policy (`exec-policy.sh`) does not read them (A80):
  routing stays a pure function of class, tier, profile, role and signals, and quality and security rules cannot be
  traded for cost.

## Reading it: `proofline insights`

`proofline insights [--run <ID>] [--json]` prints a report from `records.jsonl` and, per run, `LEDGER.log`, the
gate records and the recorded results the ledger binds. It is read-only: it never changes a rule, skill, config
file, ledger or metrics file, and it never applies its own suggestions (A89). It works from a read-only checkout.

**Cost.** One row per run, one per role and model, one per model, and totals: duration, runtime-reported tokens,
retries, and (from the `run` record) delegations and fix rounds. Tokens are shown as in, out and total, because a
Codex-style record carries only `tokens_total` (in and out null) while a Claude-style record carries all three; the
total is never derived from in and out here. A token cell is the sum of the recorded values only.
`n/a` means none was recorded; `6000 (2/3)` means two of three dispatches reported. A null is never shown as zero and
nothing is estimated. Durations of `dispatch` records (cost of a call, retries included) and of `run` records (the
whole run) are different measures and are reported separately, never added together. If a task has more than one
`run` record (a retried write), only the first counts and the report says how many were ignored. Blank lines are
skipped silently; a non-JSON line and a record of another `schema` are counted and named separately.

**Recurring failures.** A pattern needs at least two occurrences; each is printed with its count, the run ids and a
plain-language suggestion:

| Pattern | Source | Counted when |
|---|---|---|
| `repeated-finding` | gate records bound in the ledger | the same blocking finding (same gate, same file, identical text after whitespace is collapsed) appears in two or more gate records, across fix rounds or runs. Line numbers are ignored; similar but different text is a different finding; `info` findings are not counted |
| `gate-fail` | ledger `gate:<GATE>:fail` | the same gate failed two or more times |
| `scope` | gate findings | blocking findings whose text names a scope violation (out of scope, outside the frozen scope, unmapped path), two or more |
| `unsupported` | recorded results | the same line naming `UNSUPPORTED` appears in two or more recorded results |
| `approval` | ledger `approval-request` and `approval` | per run and kind, a request was made at least twice and was granted fewer times than asked |

Limits, stated in the report: a refused command (a blocked scope check, a rejected approval phrase) leaves no
ledger entry, so scope and approval patterns come from what findings and request/grant rows state, not from every
attempt. `scope` is a text match on findings, a judged signal, not a measurement. Gate records and results count
only when a ledger row binds them, as in the control plane itself. `metrics: off` writes no records, so the cost
part reports "no metrics recorded"; the failure part still reads the ledgers.

`--json` prints the same data as one object, `proofline.insights/1`.
