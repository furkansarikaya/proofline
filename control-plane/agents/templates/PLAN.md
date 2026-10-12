---
scope:
  - path: path/to/existing/file
    criteria: [AC-1]
  - path: path/to/new/file
    criteria: [AC-2]
    # new: true — the path does not exist at freeze (freeze FAILS if it exists; a path without it must exist).
    new: true
    # Optional, only when RED/GREEN evidence does not apply (docs, metadata, configuration). Specific:
    # at least 20 characters, no stock phrase; agent.sh rejects anything else.
    # tdd_exemption: why RED/GREEN does not apply here, specifically
---

# Plan: <TASK-ID>

Owner: lead (plan-contract). The YAML `scope:` is the complete path boundary (paths are unquoted literals);
every path maps to acceptance criteria. Run artifacts are control metadata, not scope.

## Architecture

COMPLEX and CRITICAL only (architect). The smallest valid design: components mapped to repository paths,
boundaries, compatibility, migration, the tradeoffs that matter. Delete the section otherwise.

## Data

destructive: no

When persistence or schema changes (data_architect). The first non-blank line is `destructive: yes` or
`destructive: no`. Then: model change, invariants, migration plan (expand/contract, backfill,
reversibility, lock risk, rollback). `destructive: yes` forces class CRITICAL at freeze and needs a
`destructive` approval, and the step table must separate expand from contract: a non-destructive step in
phase `expand`, `backfill` or `switch`, every destructive step in phase `deferred`. Only the
user's explicit single-step approval allows one step: the line `single_step: yes` plus a `single_step` approval. Delete the section when nothing persistent changes.

## UI

When the UI changes (designer): screens, flows, states, accessibility. Delete otherwise.

## Behavior

## Tests

## Verification commands

## Dependencies

New dependencies with version and reason, or `none`. A dependency not listed here is a FAIL.

## Contracts

Versioned API or schema contract changes, or `none`. A contract change not listed here is a FAIL.
