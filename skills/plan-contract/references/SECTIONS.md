# Sections

## 1. Which sections

| Section | Required when | Written by |
|---|---|---|
| `## Architecture` | class COMPLEX or CRITICAL | Architect (system-design / api-design text), pasted by the lead |
| `## Data` | a scope path is persistence (`migrations/`, `schema`, `db/`, `*.sql`, `prisma`), or the task changes stored data | Data Architect (data-design text) |
| `## UI` | (not for TRIVIAL) a scope path is UI (`*.html`, `*.css`, `*.jsx`, `*.tsx`, `*.vue`, `*.svelte`, `components/`, `pages/`, `views/`, `templates/`), or the task changes what a user sees | Designer (ui-design text) |
| `## Risk` | optional: only flag lines `contract_change: yes\|no`, `concurrency: yes\|no`, `performance_critical: yes\|no` (a trailing note after a space is allowed). In a proofline team run they are frozen with the plan and select extra review checks; a contract file changed without `contract_change: yes` fails review | Architect, pasted by the lead |
| `## Behavior` | always | lead |
| `## Tests` | always | lead |
| `## Verification commands` | always | lead |
| `## Dependencies` | always (`none` when none) | lead |
| `## Contracts` | always (`none` when none) | lead |
| `## Assumptions` | always (`none` when none) | lead |

The validator detects Data and UI from scope paths. When the task changes stored data or UI through a path the pattern does not catch, add the section anyway; the reviewer checks it against the diff. A section that does not apply is omitted, never left as a placeholder.

## 2. Content

- **Behavior:** one bullet per criterion or decision: trigger, input, observable result, edge cases from TASK/INTENT (`AC-1: subtotal 5000 with threshold 5000 → shipping 0`). Name the functions that change as `path:symbol`.
- **Tests:** one bullet per test to add or change, `- AC-<n>: `test/file` "<test name>" — <what it asserts>`. Existing tests that must keep passing (regression surface from EVIDENCE `risk`) as `- regression: `test/file``. A criterion proven only by an existing, unchanged test is listed here; that line is its mapping. A text-only criterion may instead use a verification command when every mapped scope path has `tdd_exemption`; name the command and expected output under Verification commands.
- **Verification commands:** the project's own commands in backticks, in run order (`npm test`). Never invented; taken from TASK.md, CI config or package scripts. Every command must exit 0 when the change is right: an absence check is written `! grep -rn libary . --exclude-dir=.agents` (plain `grep` exits 1 when nothing matches, the verifier records a failed command and the run needs an amendment).
- **Dependencies:** `none`, or `- <package>@<version> — <criterion it serves>`. A dependency not listed here is a FAIL at review.
- **Contracts:** `none`, or `- <contract> <old version> → <new version> — <who consumes it>` for versioned API, schema, file-format or event changes. An unlisted versioned change is a FAIL at review.
- **Assumptions** (A79): `none`, or the table `| id | assumption | source | risk | verification | status | decisions |`, one row per fact the plan relies on that no verified EVIDENCE claim or TASK criterion supports. `id` is `AS-<n>` (an assumption EVIDENCE.md already registers keeps its id); `risk` is `low|medium|high` (what breaks if it is wrong: `high` = data loss, security, a public contract, or most of the change); `verification` is the check that was run (a claim id, a command) or the one that could be run; `status` is `verified` or `unverified` (never `accepted-by-user`: the run records that when the user answers); `decisions` names the criteria or sections it affects. A `verified` row needs a named check, a `high` row needs a method in either status. An unverified `high` row stops `agent.sh freeze` until the user answers the question the lead raises for it (`accept` or the corrected fact); it is never accepted silently, and the completion report lists every unverified or accepted-by-user assumption.
- **Data:** first line `destructive: yes` or `destructive: no`, then the migration plan (expand/contract steps, backfill, reversibility, lock risk, rollback). `yes` when any step drops, truncates or rewrites existing data irreversibly.
- **Architecture / UI:** the specialist's text, unchanged except removing anything that references paths outside scope (which instead becomes a scope question).
- **UI visual proof** (A81): the designer's text carries one line `visual_proof: AC-1, AC-3` (the criteria that need visual evidence, comma-separated) or `visual_proof: none`. Required for COMPLEX and CRITICAL plans with a `## UI` section, validated whenever present (ids must be TASK criteria). The proof skills read this line from the frozen plan; a marked criterion without visual evidence is unproven.

## 3. Size

A STANDARD plan typically fits in 40–80 lines. A plan that needs more than 15 scope paths, or several pages of Behavior, is a sign the task should be split; say so instead of writing it.
