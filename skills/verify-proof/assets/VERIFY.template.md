# Verification: <TASK-ID>

## Commands

- `<exact command>` | exit=<n>
  output: <the relevant output, one short line>

## AC coverage

| AC | test | status | evidence |
|---|---|---|---|
| AC-1 | <file>::<test name> | PASS | `<command>` exit=0; traces <test path:symbol> -> <code path:symbol> |

## Scope

verify-scope: exit=<n>

## Design sync

design-sync: <PASS | FAIL | SKIPPED (reason)>

## Pre-existing failures

None.

## Failures

None.

Verdict: <PASS | FAIL>
