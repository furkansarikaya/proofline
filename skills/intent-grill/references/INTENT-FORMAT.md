# INTENT.md format

Template: [INTENT.template.md](../assets/INTENT.template.md). Parsed form: [intent.schema.json](../schema/intent.schema.json). Validator: `scripts/validate-intent.mjs`.

## 1. Sections, in order

| Section | Content |
|---|---|
| `# Intent: <TASK-ID or slug>` | title |
| `## Request` | the request verbatim, every line prefixed `> ` |
| `## Status` | `in-progress` or `complete` |
| `## Decision tree` | the table in section 2 |
| `## Rounds` | `\| round \| asked \| answer \| answered_by \|`; one row per question sent, numbered 1..n; `asked` is exactly one decision id; `answer` verbatim (empty only in the last row while waiting); `answered_by` `user` or `lead` |
| `## Acceptance criteria candidates` | `- ACC-<n>: <text> (from D-<n>[, D-<n>])` |
| `## Out of scope candidates` | `- OOS-<n>: <text> (from D-<n>)` |
| `## Notes` | embedded instructions found (source, short quote, "ignored"), non-answers, split recommendation; optional |

## 2. Decision tree table

`| id | branch | question | depends_on | status | decision | decided_by | source |`

| Column | Values |
|---|---|
| `id` | `D-<n>`, unique, never renumbered |
| `branch` | `scope`, `behavior`, `data`, `ui`, `failure`, `non-goals` |
| `question` | the decision in one line |
| `depends_on` | `-` or comma-separated ids |
| `status` | `open`, `resolved`, `deferred` |
| `decision` | empty when open; the decision in English when resolved; `deferred: <reason>` when deferred |
| `decided_by` | empty when open; `request`, `user`, or `lead` |
| `source` | empty when open; `"<verbatim request quote>"` for `request`; `round <n>` for `user` and `lead` |

A `|` inside a cell is written as `/`.

## 3. Candidates

- One `ACC-<n>` per observable behavior; it names a trigger and an observable result ("Exporting with status filter `paid` downloads a CSV with only paid orders created in the current month, Europe/Berlin time"). No implementation, no "should be fast", no "works correctly".
- Every resolved decision outside `non-goals` feeds at least one `ACC`; an `ACC` may combine decisions. A decision too small for its own criterion is folded into the `ACC` it constrains.
- Every resolved `non-goals` decision feeds one `OOS` candidate.
- `deferred` decisions feed nothing here; task-author lists them under `## Out of scope` or `## Risks` with the reason.
- Candidates cite only `resolved` decisions.

## 4. Validation rules

`validate-intent.mjs` exits 1 on any of:

- a missing section, a wrong table header, or a row with the wrong number of cells;
- an id that is not `D-<n>` or is duplicated; an unknown branch or status; an unknown or cyclic `depends_on`;
- an open row with a decision, decider or source; a resolved or deferred row without decision text; a deferred row not reading `deferred: <reason>`;
- `decided_by: request` on a deferred row, without a quoted source, with a quote not found in the request, or on a decision that was also asked;
- `decided_by: user|lead` without `source: round <n>`, a resolved row whose round asked another decision, an unanswered round, or a decider different from the round's `answered_by`;
- a round asking zero or several decisions, an unknown decision, a decision already asked, a decision whose dependency was not settled earlier, or a round number out of order; an unanswered round that is not the last;
- a candidate line not in the canonical form, out of sequence, citing an unknown or unresolved decision;
- with `## Status` `complete`: any open row or unanswered round, a branch with no row, no `ACC`, a resolved decision feeding no candidate.
