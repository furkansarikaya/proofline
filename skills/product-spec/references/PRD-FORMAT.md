# PRD format

Template: [PRD.template.md](../assets/PRD.template.md). Check: `scripts/check-prd.mjs` (`--json` output: [prd-check.schema.json](../schema/prd-check.schema.json)). Claims follow [EVIDENCE.md](EVIDENCE.md).

Location: `<product.dir>/<slug>/PRD.md` (config `product.dir`, default `docs/product`). `<slug>` is kebab-case and is the PRD's id in task files and in the trace. Headings, ids and field keys stay in English; the text is in the user's language.

## 1. Sections, in order

| Section | Content | Checked |
|---|---|---|
| `# PRD: <title>` | title | present |
| `## Problem` | the problem as claims with markers, and one `Who: <whose problem it is>` line | `Who:` line, markers |
| `## Goals` | `- G-<n>: <outcome>` | present |
| `## Non-goals` | what a reader might assume is included and is not | at least one item that is not `none` |
| `## User stories` | one `### US-<n>: As a <role>, I want <x>, so that <y>` per story, each followed by `- AC-<n>: <criterion>` items | every story has criteria; no unmeasurable word |
| `## Functional requirements` | `- FR-<n>: <requirement>` | every item has an id, ids unique |
| `## Non-functional requirements` | `- NFR-<n>: <requirement with its limit>` | as above |
| `## Completeness` | one line per topic of the list in section 1a | every topic present, each with an id of this PRD or `not applicable to this project` |
| `## Success metrics` | `- M-<n>: <name>; event: <event>; source: <where it is recorded>; baseline: <value>` | id, `event`, `source`, `baseline`; an unknown baseline links `Q-<n>` or `A-<n>` |
| `## Assumptions` | `- A-<n>: <assumption> [assumption: <risk>]`; one the agent proposed and the user accepted ends `[assumption: <risk> source agent accepted by user]`; a number is `estimate "<basis>"` | the marker on every item |
| `## Open questions` | `### Blocking` and `### Non-blocking`, each a list of `- Q-<n>: <question>` or `- none` | both lists present |
| `## Rejected proposals` | optional: `- RP-<n> <proposal> rejected by user: <reason>` | the line shape ([EVIDENCE.md](EVIDENCE.md#1a-proposals)) |
| `## Deferred` | optional: `- FR-<n>: <reason>` for a requirement no task covers on purpose | id of this PRD, a reason |

## 1a. Completeness list

A plain PRD stays short, and still answers ten questions in one line each. The topic names are fixed English words; each line gives the id of this PRD that covers the topic (`FR-n`, `NFR-n`, `US-n`, `AC-n`, `Q-n`, `A-n`, `M-n`) or closes with `not applicable to this project` (a reason after it is welcome).

```markdown
## Completeness

- error and empty states: AC-2
- permissions and roles: Q-2
- personal data and retention: not applicable to this project (the file holds totals only)
- security: NFR-2
- performance: NFR-1
- accessibility: not applicable to this project
- multilingual: not applicable to this project
- analytics events: M-1
- rollout and migration: FR-4
- dependencies: A-1
```

Topics: `error and empty states`, `permissions and roles`, `personal data and retention`, `security`, `performance`, `accessibility`, `multilingual`, `analytics events`, `rollout and migration`, `dependencies`. The spec reviewer checks its "never mentioned" topics against this list.

## 2. Rules the check applies

| Rule id | Finding |
|---|---|
| `missing-section`, `structure` | a section of the table above, or the H1, is missing |
| `problem-owner` | `## Problem` has no `Who:` line |
| `empty-non-goals` | `## Non-goals` has no item, or only `none` |
| `story`, `criterion-id` | a story without an id or without criteria; a criterion without `AC-<n>` |
| `vague-word` | an acceptance criterion or an `FR-<n>`/`NFR-<n>` requirement holds an unmeasurable word (list below) |
| `requirement-id` | a requirement item without `FR-<n>`/`NFR-<n>`, with the wrong prefix for its section, or a repeated id |
| `metric-id`, `metric-method` | a metric without `M-<n>`, or without `event`, `source` or `baseline` |
| `unknown-as-fact` | outside `## Assumptions` and `## Open questions`, without an `A-<n>` or `Q-<n>` link: `TBD`, `TODO` (capitals) or `???` anywhere; `unknown`, `bilinmiyor` or `belli değil` as the whole value of a list item or a `key: value` field (`- FR-3: unknown`, `baseline: unknown`), never as a word inside a sentence ("an unknown currency") |
| `completeness` | `## Completeness` lacks a topic, a topic names no id and is not "not applicable to this project", or an id is not defined in this PRD |
| `assumption-marker` | an assumption without `[assumption: <risk>]` |
| `open-questions` | `### Blocking` or `### Non-blocking` is missing |
| `deferred` | a deferred item without an id of this PRD, or without a reason |
| `placeholder` | a template `<...>` remains outside code; an HTML tag (`<table>`, `</td>`, `<br/>`) and an autolink are none |
| `claim` | an invalid marker ([EVIDENCE.md](EVIDENCE.md#2-rules)) |

An unmarked claim is a warning, not a finding.

**Unmeasurable words** (built in, matched as whole words, case-insensitive): robust, seamless, seamlessly, etc., etc, and so on, user-friendly, user friendly, fast, faster, quick, quickly, intuitive, easy, easily, simple, simply, scalable, flexible, efficient, efficiently, modern, powerful, smooth, smoothly, properly, appropriate, appropriately, as needed, optimal, reasonable; kullanıcı dostu, hızlı, hızlıca, çabuk, sağlam, kolay, kolayca, sezgisel, basit, esnek, ölçeklenebilir, verimli, sorunsuz, kusursuz, güçlü, uygun, makul, vb., vs., gibi şeyler. Config `product.vague_words` adds words, comma-separated: `vague_words: snappy, anında`.

## 3. Review verdict

The spec review writes `<product.dir>/<slug>/REVIEW.md` ([template](../assets/REVIEW.template.md)). The reviewer checks the PRD against the completeness list and lists at least three topics it never mentions. `scripts/check-review.mjs` checks the file (`verdict`, `completeness-review`, `min-never-mentioned`). The readiness check reads one line of it:

```text
verdict: ship | ship-with-conditions | do-not-ship
```

`ship-with-conditions` lists the conditions under `## Conditions`; the tasks carry them.

## 4. Readiness

`check-prd.mjs --ready <slug>` exits 0 only when all four hold:

1. the PRD check has no finding;
2. `REVIEW.md` exists and its verdict is `ship` or `ship-with-conditions`;
3. the review check (`check-review.mjs`) has no finding;
4. `### Blocking` lists no question.

Otherwise it exits 1 and prints one reason per failed condition. A PRD that is not ready is not split into tasks.

## 5. Coverage

A task names its PRD with front matter `prd: <slug>`. A criterion that satisfies requirements ends with a `Covers:` line, indented under it:

```markdown
# Task: TASK-012 - Export the month's orders as CSV

---
prd: orders-export
size: M

---

## Acceptance criteria

- AC-1: Clicking "Export CSV" downloads a file with one row per order of the selected month.
  Covers: FR-1, NFR-1
```

`check-coverage.mjs <slug>` reads every task with `prd: <slug>` under `tasks.dir` and its lifecycle folders. It exits 0 when each `FR-<n>` and `NFR-<n>` is covered by a criterion or listed under `## Deferred` with a reason. A `Covers:` id the PRD does not define is a finding too. A task without `Covers:` stays a valid task.

## 6. Trace

`trace.mjs <FR-n|NFR-n|TASK-ID>` prints the chain from these records only, never from model text. Git is only read (`git log`, `git show`); the script writes nothing.

| Link | Live run (`.agents/runs/<ID>/` exists) | Delivered task (no run folder: cleanup deleted it) |
|---|---|---|
| requirement | `<product.dir>/<slug>/PRD.md` | same |
| task, criterion | task files under `tasks.dir` (lifecycle folders included) and `.agents/runs/<ID>/TASK.md`: front matter `prd:`, the `Covers:` line | the task file in `tasks.dir` (normally `done/`) |
| test | `.agents/runs/<ID>/PLAN.md` `## Tests`: `` - AC-<n>: `<test file>` "<test name>" `` | the test files the delivery commit changes (the commit whose subject holds `(<ID>)`, found with `git log --grep`); a file is tied to one criterion only when a completion report line names both, else it is shown for each criterion as `(task level)` |
| run evidence | `.agents/runs/<ID>/worker-evidence/*.yaml` whose `target` or `command` names the test file | the `## TDD Evidence` and `## Verification` lines of the task file's `## Completion Report` that name the test file |
| pull request | `.agents/local/deliver/<ID>/PR`, else `.agents/local/batch/merged.tsv` | `.agents/local/deliver/<ID>/PR`; else the first `Merge pull request #N` commit on the path from the delivery commit to HEAD, or a squash subject ending `(#N)`; else `.agents/local/batch/merged.tsv` |

Each missing link is a line under `missing links:`, for example `TASK-012 AC-1: no test linked: no run folder and no delivery commit "(TASK-012)" in git log`. Limits: after delivery the plan's per-criterion test map is gone, so tests are task level unless the completion report names the criterion; a commit message or report line that names the test file is the only evidence read, and its text is quoted, not judged.
