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

<Only when UI changes: the Designer's text. Delete the section otherwise.>

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
