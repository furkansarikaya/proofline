---
scope:
  - path: path/to/existing/file
    criteria: [AC-1]
  - path: path/to/new/file
    criteria: [AC-2]
    # kind: code|test|content|doc — optional, one column. A claim: agent.sh derives the kind itself and treats a different or unknown
    # kind as code (the scope bound and the gate re-run never trust it). Omit it and the script derives.
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
phase `expand`, `backfill` or `switch`, every destructive step in phase `contract` (a separate, later migration file) or `deferred` (a later task). Only the
user's explicit single-step approval allows one step: the line `single_step: yes` plus a `single_step` approval. Delete the section when nothing persistent changes.

## UI

When the UI changes (designer): screens, flows, states, accessibility, and the line
`visual_proof: <AC ids|none>` naming the criteria that need visual evidence (required for COMPLEX/CRITICAL), and for every class but TRIVIAL the line `visual_writes: <how the data the page writes is thrown away>`
(QA visual proof runs; without it QA ends INCONCLUSIVE and the plan needs an amendment). Delete otherwise.

## Behavior

## Tests

## Verification commands

## Dependencies

New dependencies with version and reason, or `none`. A dependency not listed here is a FAIL.

## Contracts

Versioned API or schema contract changes, or `none`. A contract change not listed here is a FAIL.
A new or changed entry point that takes external input (HTTP endpoint, form handler, CLI argument, queue
consumer, webhook) is listed here too, its name in backticks: `- \`POST /orders\` none -> v1 - web checkout` (A162).

## Validation

Only when `## Contracts` lists an entry point (A162); delete the section otherwise. One line per entry point,
server side: `- <entry point>: accepts <what>; limits <limits>; rejected at <where>`. `agent.sh freeze` refuses
a plan with an entry point and no such line, and the QA plan then needs an `[invalid-input]` scenario for it.

## Risk

Flags the design implies (architect, A78), one line each and nothing else: `contract_change: yes|no`,
`concurrency: yes|no`, `performance_critical: yes|no` (optionally `budget_pct=<n>` on that line: the relative
regression budget performance-proof uses, A87). They are frozen with the plan and select REVIEW focuses.
COMPLEX and CRITICAL plans add `rollback: <feature flag, how a migration is reversed, the first step if production breaks>`
here, a few lines at most (no new section; the freeze warns when it is missing, TRIVIAL and STANDARD are never asked).
Delete the section when no flag applies and the class is TRIVIAL or STANDARD.

## Assumptions

`none`, or the register table (mandatory section): one row per fact the plan relies on without a verified
claim, `| id | assumption | source | risk | verification | status | decisions |`, id `AS-<n>`, risk
`low|medium|high`, status `verified|unverified`. A verified row names the check; an unverified high-risk
assumption blocks the freeze until the user answers it (`agent.sh verify-assumptions <ID>`).
