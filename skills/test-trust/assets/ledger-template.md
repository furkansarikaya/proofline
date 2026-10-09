# test-trust ledger: <scope-slug>

Update after every step. This file is the resume point and the audit trail.

## Scope

- Paths: <paths>
- Commit: <git commit hash, or "no git">
- Uncommitted changes included: <yes/no>
- Started: <date and time>
- Mode: <full / diff>
- Run: <TASK-ID, or "standalone">
- Output folder: <absolute path>
- Sandbox warning: <given on first run / run mode>
- Fingerprint at start: <tree id; diff mode in a run>
- Base (diff mode): <commit sha>
- Thresholds (diff mode): repeat <n>, mutation_budget <n>, slow_ratio <n> (from <config / default>)
- Worktree: <path while the hollow stage runs; "none" otherwise>
- Linked dependency folders: <relative paths symlinked into the worktree, or "none">

## Toolchain probe

| Purpose | Command | Proven by |
|---|---|---|
| Scope run | | |
| Single test | | |
| Repeat | | |
| Shuffle | | |
| Per-test duration | | |

| Capability | Status | Evidence |
|---|---|---|
| Single test | proven / unsupported | |
| Repeat | proven / unsupported | |
| Shuffle | proven / unsupported | |
| Per-test duration | proven / unsupported | |

## Baseline

- Duration: <seconds>
- Test count: <n>
- Timeout rule: 3× baseline of what runs, minimum 30 s
- Red at baseline: <tests, or "none">

## Cost estimate

- Initial: flaky stage 1 <min>, hollow <min> (<n> mutants), total <min>; confirmed by user: <yes/not needed>
- Checkpoint after flaky stage 1: <n> candidates, stage 2 <min>, new total <min>; confirmed by user: <yes/not needed>

## Progress

| Pillar | Status | Resume point |
|---|---|---|
| Flaky stage 1 | pending / in progress / done / skipped | |
| Flaky stage 2 | pending / in progress / done / skipped | |
| Slow | pending / in progress / done / skipped / unsupported | |
| Hollow | pending / in progress / done / skipped | |
| Report | pending / done | |

### Hollow targets

| Unit | Priority | Mutations | Covering tests (flaky ones removed) | Result |
|---|---|---|---|---|
| | | | | |

## Candidates

| Id | Kind | Test | Verdict | Refutation attempt | Evidence |
|---|---|---|---|---|---|
| | | | | | |

## Commands log

| # | Command | Exit code | Duration | Evidence |
|---|---|---|---|---|
| | | | | |
