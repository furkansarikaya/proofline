# Verification: <TASK-ID>

## Commands

- `<exact command>` | exit=<n>
  output: <the relevant output, one short line>

## AC coverage

| AC | test | status | evidence |
|---|---|---|---|
| AC-1 | <file>::<test name> | PASS | `<command>` exit=0; traces <test path:symbol> -> <code path:symbol> |

For command proof only when every PLAN scope path mapped to the AC has `tdd_exemption`:
`| AC-2 | command: \`<exact command>\` | PASS | \`<exact command>\` exit=0; output: <demonstrating output line> |`

## Scope

verify-scope: exit=<n>

## Design sync

design-sync: <PASS | FAIL | SKIPPED (reason)>

## Runtime

runtime: <name> local=<version|missing> ci=<spec|none> source=<file|-> status=<match|mismatch|unknown>

## Pre-existing failures

None.

## Failures

None.

Verdict: <PASS | FAIL>
