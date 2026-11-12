# Metrics and cost

The control plane records what each run and each specialist step cost, locally and best effort.
Everything lives in `.agents/local/metrics/` (git-ignored); `metrics: off` in `.agents/config.yaml`
disables all of it. A metrics failure never blocks a command.

Three files:

- `tools.jsonl` — one record per recorded specialist step: how many tool calls the step made and how many bytes of
  tool results entered its context (A235, see "Tool calls and result bytes" below).
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
- **Time and runtime are real (A200).** A step's duration is its working time (`PROOFLINE_DISPATCH_START`, set by `dispatch.sh`), so a resumed agent does not
  inflate it, the runtime label is the runtime the step ran on, and Codex tokens are read from the log whatever the final message looked like.
- **Evidence archive (A200).** `cleanup` and `worktree-remove` put a compressed copy of a run's records under `.agents/local/archive/<ID>/` (git-ignored) before
  they delete them; `archive.keep` in `config.yaml` (default 10, 0 turns it off) is the number of runs kept, and the deletion is refused when archiving fails.
- **`metrics: off`** writes neither file, from `agent.sh` or `dispatch.sh`. Existing files are left alone.
- **Metrics never change a decision.** The execution policy (`cli exec-policy` of the Node core) does not read them (A80):
  routing stays a pure function of class, tier, profile, role and signals, and quality and security rules cannot be
  traded for cost.

## Tool calls and result bytes (`tools.jsonl`, A235)

`records.jsonl` has no tool data and its format does not change (ADR D3). The control plane writes one more file,
`.agents/local/metrics/tools.jsonl`, with one `kind: step` record per recorded specialist result (the same moment as the
`step` record of `records.jsonl`: `submit` / `record`). It is built from the runtime's own session log, the transcript whose path is
line 1 of `.agents/local/submissions/<token>.started` (the file the token counts already come from); for a Codex worker, its rollout log (see "Codex" below). No model-written text is copied.

| Key | Type | Meaning |
|---|---|---|
| `schema` | string | always `proofline.tools/1` |
| `kind` | string | `step`, or `lead` (the lead's own session, A258, below) |
| `time` | string | UTC ISO-8601 time the record was written |
| `task`, `role`, `focus`, `gate`, `runtime` | string or null | as in `records.jsonl` (reduced to `[A-Za-z0-9._+:-]`) |
| `log` | string | `ok`, or why the counts are null: `no-log` (the runtime keeps no log the control plane reads: a command-template runtime, a path that is not a `.jsonl` file), `unreadable`, `malformed` (a line that is not JSON) |
| `calls` | integer or null | tool calls in the log at the time of the record (a `tool_use` of an assistant entry; a repeated id counts once) |
| `result_bytes` | integer or null | UTF-8 bytes of the text of the tool results that came back (images and other non-text blocks count 0) |
| `denied` | integer or null | calls whose result is the hook's refusal (`PreToolUse:<Tool> hook error ...`): a call spent and answered with a rule, so a wasted round trip |
| `by_tool` | object or null | per tool name (reduced; at most 40 names, the rest summed as `other`; keys in byte order): `{"calls": n, "bytes": n}` |
| `reason` | string or null | last key (A255); null when `log` is `ok` or `no-log`. Why a log is `unreadable` or `malformed`: `read-error`, `too-large`, `not-a-file`, `line-too-long`, `bad-line`, `no-events`; for Codex also `no-session-id`, `no-codex-home`, `no-rollout` (the log was not found) |

Read the limits before using it: the log is read while the session still runs, so the record counts up to the call that submitted (that call's own result
is not in it), a last half-written line is ignored, and a worker that submits twice (the first was rejected) is counted at its recorded submission only.
A Claude subagent's log holds that subagent only; the lead's own session is a record of its own (below, A258). Counts are never estimated: a log that
cannot be read gives `null` and a `log` value that says so, never `0`; a log over 128 MiB is not read (`unreadable`), and `submit` still succeeds. Every string is cut to 64 characters after the reduction (a tool name included), so one line stays under about 5 KB. `metrics: off` writes nothing.

### Codex (A255)

A Codex worker has no hook that writes a `.started` file, and the dispatcher does not record the rollout path, but the command a Codex model runs (`agent.sh submit`) has `CODEX_THREAD_ID`
(the session id, A211). `submit` therefore looks for `rollout-<local time>-<session id>.jsonl` under `$CODEX_HOME/sessions` (else `$HOME/.codex/sessions`, which is where the dispatcher puts a Codex worker's
home), in the day folders of today and the 3 days before (local and UTC day). The id must be a UUID and the name is matched exactly in a listing, so nothing from a file or an
argument is ever used as a path; a symbolic link is not followed. The log is read line by line (a line over 32 MiB or a log over 128 MiB is `unreadable`). Counted: a `response_item` of type
`function_call`, `custom_tool_call`, `local_shell_call` or `tool_search_call` with a `call_id` is a call (once per id); the first `*_output` item with that id is its result, in UTF-8 bytes of its text. A result that
holds `blocked by PreToolUse hook` in its first 300 characters is a refused call. Limits: Codex runs nearly every command as the tool `exec` (or `wait`), so `by_tool` says little about what the commands were; a
call of another kind without a `call_id` (a web search) is not counted; a session older than 3 days at `submit`, a missing session id (a Codex lead started some other way) or a moved `CODEX_HOME`
gives `unreadable` with the `reason`, never a count; the format was checked on codex-cli 0.163 to 0.167 logs (163 logs on the maintainer's machine, all read, none malformed).

### The lead's own session (A258)

When a run ends (`handoff <ID> DONE`, `terminate`), the control plane appends ONE more record to `tools.jsonl`: `kind: lead`, `role: lead`, the same keys as a step record plus a last key `session` (the session id, a UUID or null). It is a snapshot of the lead's own session log taken at that moment: for Claude, `<CLAUDE_CONFIG_DIR or $HOME/.claude>/projects/<project folder>/<CLAUDE_CODE_SESSION_ID>.jsonl` (the project folder is the working directory with every character outside `[A-Za-z0-9]` replaced by `-`; this tree, the main tree and the working directory are tried); for Codex, the rollout found by `CODEX_THREAD_ID` as above. The session id must be a UUID (so it cannot carry a path), a symbolic link or a non-regular file is refused, nothing outside the runtime's own folder is read, a log over 128 MiB is not read, and nothing of the log is copied. If the log cannot be found or read the record says `unreadable` (or `malformed`) with a `reason` (`no-session-id`, `no-claude-home`, `no-transcript`, `not-a-file`, `too-large`, `bad-line`, ...) and null counts, never zero. `proofline insights` counts one session once (its best snapshot, under the task of that snapshot) and shows it as the role `lead`. Limits: calls after `handoff DONE` (delivery, CI) are in no snapshot; a session that runs several tasks (night mode) is counted once, under the task of its last snapshot; a lead session that started in another working directory than this tree or the main tree is not found (`no-transcript`).

### One COMPLEX end-to-end measurement (A259)

The tool-call economy work (A235, A255 to A258) was measured once end to end: the repository's COMPLEX e2e task run with real agents on v0.0.68 and on v0.0.91, the transcripts read with the same `core/toolstats.mjs` for both. It is n = 1 per version with different final states, so it reports numbers and caveats, not a saving; see A259 in `docs/decisions.md`. To repeat it: `node tests/e2e/run.mjs COMPLEX claude --keep` on each checkout, then `proofline insights` in the kept project (AFTER only; a version before 0.0.88 has no `tools.jsonl`).

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

**Tool calls (A255).** The TOOL CALLS section reads `.agents/local/metrics/tools.jsonl` (only what the control plane wrote; no model text) and shows, per role, per run and overall: jobs, calls per job,
result bytes per job, the sums, calls refused by a hook, and the top tools (the role table is the measurement table of A235). Jobs whose log was not readable are counted apart and their counts
are `n/a` (`12 (2/3)` = two of three jobs had a log); a record of another schema, a corrupt line, a line over 64 KiB and a file over 200000 lines are counted and named, never fatal, and the file is read in chunks
(line count and line size are bounded; the report itself grows with the number of distinct roles, runs and tools, and a file that is not a regular file is not opened). `--run` limits it to one run; `--json` has the same rows under `tools` (`null` when there is no file).

**Estimate calibration (A202).** `proofline insights` ends with a CALIBRATION section: for each size S/M/L with at least 3 finished tasks, the median minutes,
tokens and scope paths from the metrics records (which now carry `size` and `scope_paths`). It is a suggestion for the task-author's size estimate and changes nothing.

**Context size and archives (A202).** `core/contextsize.mjs` (`proofline-core.mjs cli context-size`, shown by `doctor` and `insights`) measures the bytes that load automatically (AGENTS.md block, SessionStart text,
entry skill, each role's skill and agent). `tests/context/budget.tsv` bounds them and `tests/core/contextsize.test.mjs` runs on every pull request; raising a bound needs a
`Context-budget-change:` line. `agent.sh rules list|report|tally` proposes merging duplicate or contradicting rules and removing rules no review cited, against `rules.budget_bytes`;
nothing changes without your approval. `validate-wiki.mjs --archive-log` moves old wiki log entries to `log-archive.md` (nothing is deleted), and finished tasks are read by title and
status only. Every `docs/decisions.md` lookup is a grep, not a full read.

## Friction report and calibration (A149)

**Friction report.** When a run ends (`handoff DONE`, `terminate`), `agent.sh friction report` builds
`.agents/local/friction/latest.md` (and one file per run, `.agents/local/friction/<run id>.md`, so a later run does not replace an earlier run's report) from the run's `LEDGER.log`, its `HOOKS.log` (the hook timings; they are not ledger lines) and `records.jsonl`: how many times the user was
asked (questions plus approval requests), failed gates and blocked steps per gate and role, runtime failovers and
dispatch timeouts, fix rounds and delegated steps, run duration, and tokens (sums of the reported values only,
`n/a` when none). It holds counts and controlled identifiers only: no run id, no path, no name, no free text.
A scrub check refuses to write it when a line has a character outside a small set or mentions the project
directory, the repository user, the repository email or `$USER`. `agent.sh friction show [ID]` prints the latest report, or the one of that run.

Sending is never automatic. `agent.sh friction issue-cmd` prints the `gh issue create` command a send would run.
`agent.sh request-approval - report` asks the user; only after their `report` approval (bound to the sha256 of the
report, single use) does `agent.sh friction send` run that command. A report edited after the request needs a new
approval.

**Calibration.** `agent.sh calibrate` prints suggestions only: `test_trust.mutation_budget` against the largest
criteria count of the plans on disk, `dispatch.timeout_seconds` against the slowest dispatch and recorded timeouts,
and `review.max_fix_rounds` when two or more runs used all of it. It never edits a file.
