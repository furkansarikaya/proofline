---
target: markdown
required: goal acceptance_criteria out_of_scope constraints risks
---
## Title
{{title}}

## Goal
{{goal}}

## Context
{{context}}

## Acceptance criteria
{{acceptance_criteria}}

## Out of scope
{{out_of_scope}}

## Constraints
{{constraints}}

## Risks
{{risks}}

## Pre-existing defects

<Defects the work runs into that the user did not ask about, one per line: `- <path:symbol>: <what is wrong> -- decision: report`, or `none`. Required in a COMPLEX or CRITICAL task whose request names no defect while its Context, criteria, constraints or risks speak of a defect or a fix (A105: the freeze refuses it otherwise). `decision: fix` only when the user explicitly asked for the fix in their own words; it then needs their `scope` approval at freeze. An acceptance criterion never depends on a pre-existing defect being fixed.>

## Test exceptions
<!-- Optional (A294): delete this whole section when the task declares none. One line per need, in the grammar of the batch pre-flight: - wait|budget|measure: `<repo-relative test path>` -- <reason, at least 20 characters>. Copy each line exactly as the task file has it: the batch hashes its exact bytes. -->
{{test_exceptions}}

## Suggested class
{{suggested_class}}

## Verification commands
{{verification_commands}}

<!-- Optional (A202); delete what you do not use. Sections, each with one bullet per entry:
## Allowed scope            - `src/billing/` (files, folders or globs the plan may touch; a plan path outside is asked in the batch pre-flight)
## Forbidden scope          - `src/auth/` (the plan may not contain these; the freeze refuses it and nothing waives it)
## Existing pattern references   - `src/orders/list.ts` (do it like this file; explorer reads it first, plan and review check conformity)
## Completion response      the final summary format you want; the lead's last message follows it
Acceptance criteria: 3 to 6, outcome-focused, each with a number, a path or an exact message; an indented `Feasibility: <what you checked in the pinned manifest or docs>` line under a criterion that rests on a library, version or limit (warnings only). In a split, `depends_on` comes from the content (a `## Dependency check` table in the split output; `validate-task.mjs --check-deps <dir>`).
Front matter keys (after the Task line): priority: high|medium|low (batch order among tasks without dependencies); origin is written by the tool. -->
