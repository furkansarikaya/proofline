---
scope:
  - path: <repo-relative file>
    criteria: [AC-1]
  # Optional `kind: code|test|content|doc` after criteria: a claim only; the script derives the kind and treats a different or unknown one as code.
  # A document or content path has no RED/GREEN to show: give it a specific reason (20+ characters) instead of a test (A200):
  # - path: docs/guides/setup.md
  #   criteria: [AC-2]
  #   tdd_exemption: "documentation page, verified by the docs link check; there is no executable behavior to test first"
---

# Plan: <TASK-ID>

## Architecture

<COMPLEX/CRITICAL only: the Architect's text. Delete the section otherwise.>

## Data

<Only when persistence changes. First line: destructive: yes|no. destructive: yes needs the step table with expand/backfill/switch steps before the contract steps (or `single_step: yes` with the user's approval). Delete the section otherwise.>

## UI

<Only when UI changes: the Designer's text, including the line "visual_proof: <AC ids|none>" (required for COMPLEX/CRITICAL) and, for every class but TRIVIAL, the line "visual_writes: <how the data the page writes is thrown away>" (QA visual proof runs; the plan must declare this up front). Delete the section otherwise.>

## Behavior

- AC-1: <trigger, input → observable result; `path:symbol` that changes>

## Tests

- AC-1: `<test file>` "<test name>" — <what it asserts>

## Verification commands

- `<project test command>`

## Dependencies

none

## Contracts

none

## Validation

<Only when a new or changed entry point that takes external input (HTTP endpoint, form handler, CLI argument, queue consumer, webhook) is listed in `## Contracts`, its name in backticks. One line per entry point, server side: `- <entry point>: accepts <what>; limits <limits>; rejected at <where>`. Delete the section otherwise.>

## Risk

<Only the flags the design implies, one line each (the architect's text, A78): `contract_change: yes|no`, `concurrency: yes|no`, `performance_critical: yes|no`. COMPLEX and CRITICAL also write `rollback: <feature flag, migration reversal, first step if production breaks>` here, a few lines at most (the validator and the freeze warn when it is missing). Delete the section when nothing applies.>

## Assumptions

<`none`, or the register: one row per fact the plan relies on without a verified claim. risk is low|medium|high, status verified|unverified (never accepted-by-user: the run records the user's answer). A verified row names the check; a high-risk unverified row stops the freeze until the user answers it.>

| id | assumption | source | risk | verification | status | decisions |
|---|---|---|---|---|---|---|
| AS-1 | <what is taken as true> | <E-n, TASK.md, INTENT.md or user> | <low\|medium\|high> | <the check that was or can be run> | <verified\|unverified> | <AC-n or section it affects> |
