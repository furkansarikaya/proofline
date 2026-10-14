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

## Suggested class
{{suggested_class}}

## Verification commands
{{verification_commands}}
