# Output

`REPORT.md` (team: `.agents/runs/<TASK-ID>/reviews/performance-proof/REPORT.md`; standalone:
`.agents/local/performance-proof/<target>/REPORT.md`) holds a short human summary and one fenced `json` block,
the report that `scripts/validate-performance.mjs` checks. `compare-bench.mjs` prints that block; you add
`tool.source` (if not passed), further measurements, `judged` items and summary sentences.

## Shape (`schema_version: 1`)

| Key | Content |
|---|---|
| `status` | `PASS`, `FAIL`, `INCONCLUSIVE` or `UNSUPPORTED`; derived, never chosen |
| `unsupported_reason` | UNSUPPORTED only: the missing command or capability |
| `tool` | `{command, source}`: the project's benchmark command and the file that defines it |
| `environment` | `os`, `cpu_count`, `load_avg_before` (and `load_avg_after`), `command`, `warmup_runs`, `runs`, `order: interleaved`, `timer`, `base_rev`, `change_rev`, `started_at`, `finished_at`, `tool_versions` (object); `run-bench.sh` writes all of them |
| `thresholds` | `regression_pct`, `noise_pct`, `min_runs` (>= 5), `confidence`, `source` (`default`, `config`, `plan`) |
| `measurements[]` | `id` `M<n>`, `metric`, `unit`, `direction` (`lower`/`higher`), `base` and `change` (`samples` plus the computed statistics), `delta` (`regression_pct`, `ci_low_pct`, `ci_high_pct`, `ci99_high_pct`, `confidence`, `resamples`, `seed`), `noise_pct`, `status`, `reason` |
| `judged[]` | `id` `J<n>`, `text` (no measured numbers), `path`, `criterion` (the quoted written criterion, or null), `violates_criterion` |
| `summary` | sentences; every performance claim cites an `M<n>` and agrees with its direction ("faster" never cites a regression); INCONCLUSIVE says "INCONCLUSIVE" and "not a FAIL" |
| `next_step` | required for INCONCLUSIVE and UNSUPPORTED |

The validator recomputes every measurement from its samples with the pinned bootstrap constants (seed 1,
2000 resamples, confidence 0.95; a report carrying other values is invalid), refuses a direction the unit
contradicts (a time is lower-is-better, a rate higher-is-better), and rejects a
statistic, a measurement status or a report status that does not follow; a PASS with fewer than `min_runs`
runs, with noise above the threshold, or without any measurement; mixed units; a missing environment block;
a judged item with a number; a claim sentence that cites no measurement of the report or contradicts the
direction of the one it cites; a side whose sample count differs from `environment.runs`; and change samples
identical to the base samples (copied data). With `--config` and `--plan` it also recomputes the thresholds
and their source; without both it prints `thresholds unverified` and `--rows` never submits PASS (UNSUPPORTED instead).
`--rows` prints the gate submission.

## Human part (above the json block)

```
# Performance: <TASK-ID or target>

Status: <STATUS>  (INCONCLUSIVE is not a FAIL / UNSUPPORTED is not a PASS, when it applies)
Command: <command>  (defined in <source>)
Base <rev> vs change <rev>, <runs> runs per side interleaved, <warmup> warmup, <os>, <cpu_count> CPUs, load <before> -> <after>
Threshold: <regression_pct> % (<source>), noise <noise_pct> %, min runs <min_runs>

| id | metric | base median | change median | regression | 95 % interval | noise | status |
|---|---|---|---|---|---|---|---|

Judged (not measured; never closes the gate unless it violates a quoted criterion):
- J1 <path>: <text>

Next step: <for INCONCLUSIVE / UNSUPPORTED>
```

## Completion report

The lead lists an INCONCLUSIVE or UNSUPPORTED performance result under `## Unsupported Checks`
(`REVIEW_RULES:performance` or `REVIEW_SMALL:performance`) with the reason and `not proven: <what>`, stating
that it is not a FAIL and not a PASS, and whether the user waived it. INCONCLUSIVE always blocks until the user
decides; UNSUPPORTED is unproven and reported (blocking only under `risk.unsupported: block`).
