# Reporting

## concurrency.json

Schema: [concurrency.schema.json](../schema/concurrency.schema.json). Unknown keys are rejected at every level.

| Field | Content |
|---|---|
| `target` | `type` (`working_tree`, `branch`, `pull_request`, `run`), `name`, `base`, `head` (null for the working tree) |
| `scope` | `changed_files` (repository-relative), `candidates` (count from `find-shared-state.mjs`), `not_reviewed` ({path, reason}) |
| `reproduction` | `status` `ran` (+ `runner`, `worktree`), `unsupported` (+ `reason`), `none_needed` (+ `reason`; only with no finding and no unproven risk) |
| `findings[]` | `id` `C001`, `category`, `title`, `status` (`open`, `accepted`, `closed`, `pre_existing`), `location` {file, line}, `shared_state`, `evidence` (`traced`, `reproduced`), `trace` ([INTERLEAVING.md](INTERLEAVING.md)), then `why_not_reproduced` (traced) or `reproduction` {command, runs, failures, observed, saved_copy} (reproduced), `accepted_by` {file, line, quote} (accepted), `recheck` (closed) |
| `unproven_risks[]` | `id` `U001`, `category`, `location`, `reason`, `why_unproven` |
| `judged[]` | `id` `J001`, `location`, `note`, optional `violates` {file, line, quote}: the written spec or plan criterion it breaks |
| `verdict.summary` | one or two sentences: what was proven. Never a safety claim |

Categories: `race`, `deadlock`, `lost_update`, `double_processing`, `idempotency`, `retry_side_effect`,
`ordering`, `redelivery`, `timeout`, `transaction_boundary`, `lock_lifecycle`.

## What the validator checks

`node <skill-dir>/scripts/validate-concurrency.mjs <concurrency.json> [--repo DIR [--base REF]] [--report REPORT.md] [--rows]`

- shape, enums, unique ids, statuses with their required fields;
- every trace: at least 2 distinct actors, each with a step; steps numbered 1..n; every step `file:line`;
  the finding's `location` is a step; a finding in changed code has its file in `scope.changed_files`;
- `reproduced`: reproduction status `ran`, `runs` >= 2, 1 <= `failures` <= `runs`, observed output, a copy
  under `evidence/`; `traced`: `why_not_reproduced`, no reproduction;
- `--repo`: every cited file exists inside the repository, the line exists, `code` and `accepted_by.quote`
  are on their lines;
- `--base`: each non `pre_existing` finding has a trace step on a line changed since `REF` (untracked files
  count as changed);
- no safety claim in `verdict.summary` or in the `## Verdict` and `## Summary` sections of REPORT.md
  (`--report`): the words `safe`, `safely`, `thread-safe`, `race-free`, `deadlock-free`, `concurrency-safe`,
  case-insensitive, as whole words, after removing fenced code blocks, `inline code` and "double-quoted"
  text. `unsafe`, `safety` and identifiers such as `safeParse`, `is_safe` or `thread_safe` never match.

Exit 0 prints `RESULT`, `CONFIDENCE` and `REPRODUCTION` (`ran`, `UNSUPPORTED (<reason>)` or
`none_needed (<reason>)`); `--rows` prints only the submit rows. Exit 1 lists the problems; exit 2 is a usage
or read error.

What it does **not** prove: that a schedule is possible in the runtime, that a guard really fails, or that
nothing was missed. Those are the reviewer's reading of the code; the cited lines make them checkable.

## REPORT.md

```markdown
# concurrency-proof: <target>

## Summary
<what was examined (files, candidates, actors) and what was proven; never a safety claim>

## Findings
| id | category | location | evidence | status | schedule (actor@file:line ...) | outcome |
|---|---|---|---|---|---|---|

## Unproven risks
| id | category | location | reason | what is missing |
|---|---|---|---|---|
<or: none>

## Judged
<items, each with its location; "violates" names the spec/plan line; or: none>

## Reproduction
<ran: runner, worktree, per finding runs/failures/observed | UNSUPPORTED: reason | none_needed: reason>

## Verdict
RESULT: <PASS|FAIL>, CONFIDENCE: <...>. <PASS: "No proven concurrency problem in the change." FAIL: the open findings.>
```

## Rows (team mode)

`--rows` gives one line per row for `agent.sh submit --findings -`:

- `blocking|<file:line>|C00n <category>: <title>|traced: 1.A@f:l -> 2.B@f:l ...; <outcome>` (or `reproduced: ...`)
- `blocking|<file:line>|J00n judged: <note>|violates <file:line> "<quote>"`
- `info|...` for pre-existing findings, unproven risks and an UNSUPPORTED reproduction.
