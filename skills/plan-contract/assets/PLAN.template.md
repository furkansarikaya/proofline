---
scope:
  - path: <repo-relative file>
    criteria: [AC-1]
---

# Plan: <TASK-ID>

## Architecture

<COMPLEX/CRITICAL only: the Architect's text. Delete the section otherwise.>

## Data

<Only when persistence changes. First line: destructive: yes|no. destructive: yes needs the step table with expand/backfill/switch steps before the contract steps (or `single_step: yes` with the user's approval). Delete the section otherwise.>

## UI

<Only when UI changes: the Designer's text, including the line "visual_proof: <AC ids|none>" (required for COMPLEX/CRITICAL). Delete the section otherwise.>

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

## Assumptions

<`none`, or the register: one row per fact the plan relies on without a verified claim. risk is low|medium|high, status verified|unverified (never accepted-by-user: the run records the user's answer). A verified row names the check; a high-risk unverified row stops the freeze until the user answers it.>

| id | assumption | source | risk | verification | status | decisions |
|---|---|---|---|---|---|---|
| AS-1 | <what is taken as true> | <E-n, TASK.md, INTENT.md or user> | <low\|medium\|high> | <the check that was or can be run> | <verified\|unverified> | <AC-n or section it affects> |
