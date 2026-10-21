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
| `## Success metrics` | `- M-<n>: <name>; event: <event>; source: <where it is recorded>; baseline: <value>` | id, `event`, `source`, `baseline`; an unknown baseline links `Q-<n>` or `A-<n>` |
| `## Assumptions` | `- A-<n>: <assumption> [assumption: <risk>]` | the marker on every item |
| `## Open questions` | `### Blocking` and `### Non-blocking`, each a list of `- Q-<n>: <question>` or `- none` | both lists present |
| `## Deferred` | optional: `- FR-<n>: <reason>` for a requirement no task covers on purpose | id of this PRD, a reason |

## 2. Rules the check applies

| Rule id | Finding |
|---|---|
| `missing-section`, `structure` | a section of the table above, or the H1, is missing |
| `problem-owner` | `## Problem` has no `Who:` line |
| `empty-non-goals` | `## Non-goals` has no item, or only `none` |
| `story`, `criterion-id` | a story without an id or without criteria; a criterion without `AC-<n>` |
| `vague-word` | a criterion holds an unmeasurable word (list below) |
| `requirement-id` | a requirement item without `FR-<n>`/`NFR-<n>`, with the wrong prefix for its section, or a repeated id |
| `metric-id`, `metric-method` | a metric without `M-<n>`, or without `event`, `source` or `baseline` |
| `unknown-as-fact` | `TBD`, `TODO`, `unknown`, `bilinmiyor`, `belli değil` or `???` outside `## Assumptions` and `## Open questions` without an `A-<n>` or `Q-<n>` link |
| `assumption-marker` | an assumption without `[assumption: <risk>]` |
| `open-questions` | `### Blocking` or `### Non-blocking` is missing |
| `deferred` | a deferred item without an id of this PRD, or without a reason |
| `placeholder` | a template `<...>` remains |
| `claim` | an invalid marker ([EVIDENCE.md](EVIDENCE.md#2-rules)) |

An unmarked claim is a warning, not a finding.

**Unmeasurable words** (built in, matched as whole words, case-insensitive): robust, seamless, seamlessly, etc., etc, and so on, user-friendly, user friendly, fast, faster, quick, quickly, intuitive, easy, easily, simple, simply, scalable, flexible, efficient, efficiently, modern, powerful, smooth, smoothly, properly, appropriate, appropriately, as needed, optimal, reasonable; kullanıcı dostu, hızlı, hızlıca, çabuk, sağlam, kolay, kolayca, sezgisel, basit, esnek, ölçeklenebilir, verimli, sorunsuz, kusursuz, güçlü, uygun, makul, vb., vs., gibi şeyler. Config `product.vague_words` adds words, comma-separated: `vague_words: snappy, anında`.

## 3. Review verdict

The spec review writes `<product.dir>/<slug>/REVIEW.md` ([template](../assets/REVIEW.template.md)). The check reads one line of it:

```text
verdict: ship | ship-with-conditions | do-not-ship
```

`ship-with-conditions` lists the conditions under `## Conditions`; the tasks carry them.

## 4. Readiness

`check-prd.mjs --ready <slug>` exits 0 only when all three hold:

1. the PRD check has no finding;
2. `REVIEW.md` exists and its verdict is `ship` or `ship-with-conditions`;
3. `### Blocking` lists no question.

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

`trace.mjs <FR-n|NFR-n|TASK-ID>` prints the chain from these records only, never from model text:

| Link | Record |
|---|---|
| requirement | `<product.dir>/<slug>/PRD.md` |
| task, criterion | task files under `tasks.dir` (lifecycle folders included) and `.agents/runs/<ID>/TASK.md`: front matter `prd:`, the `Covers:` line |
| test | `.agents/runs/<ID>/PLAN.md` `## Tests`: `` - AC-<n>: `<test file>` "<test name>" `` |
| run evidence | `.agents/runs/<ID>/worker-evidence/*.yaml` whose `target` or `command` names the test file |
| pull request | `.agents/local/deliver/<ID>/PR`, else `.agents/local/batch/merged.tsv` |

Each missing link is a line under `missing links:`, for example `TASK-012 AC-1: no test linked: no .agents/runs/TASK-012/PLAN.md`. The run folder is deleted after delivery, so test and evidence links of a delivered task are reported missing. The script writes nothing.
