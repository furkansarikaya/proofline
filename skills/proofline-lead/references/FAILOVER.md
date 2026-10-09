# Failover, resume, queue and concurrency (D4, D7)

`A` = `.agents/scripts/agent.sh`.

## 1. Lead failover and resume

All state is in `RUN.yaml`, `LEDGER.log` and the run artifacts, written by `agent.sh` after every
transition. Nothing the lead remembers is state.

`resume` (`/proofline resume`, `proofline resume`, or a new session of either runtime):

1. Boot ([SKILL.md](../SKILL.md#boot-every-session-proofline-resume)); `A status`.
2. `A freshness <ID>` and `A verify-handoff <ID>`. A failure is reported verbatim; the run is not
   continued until it is resolved (an amendment, or `terminate BLOCKED`).
3. `A next <ID>` and continue in the Flow table. The interrupted step restarts from its beginning, never
   from the middle:
   - an interrupted dispatch -> dispatch the same step again with the same assignment;
   - an interrupted implementer -> its partial edits are on disk: `A next` decides (an unattested change
     fails the next transition; report it and ask the user before any undo, which is destructive);
   - an interrupted lead write (EVIDENCE.md, PLAN.md, COMPLETION_REPORT.md) -> rewrite it from its inputs.
4. A pending question or approval request stays pending: re-print it (`A questions`, or the
   `request-approval` question) and STOP.

## 2. Specialist failover

`dispatch.sh` owns it, by config `failover`:

| `failover` | On a runtime limit / unavailable / auth error |
|---|---|
| `auto` | re-runs the same step from its beginning on the other runtime when it is installed and meets the role's `tier_floor`; ledgered as `failover from=.. to=.. reason=..` |
| `ask` | stores the question with `A ask` (pending, ledgered) and exits 5 with `RESULT: NEEDS_INPUT`: `A questions`, relay verbatim, STOP ([HANDOFF.md](HANDOFF.md)); on the user's yes re-run `D` with `--runtime <other>` |
| `off` | BLOCKED |

- On the Agent path (Claude subagent) a runtime limit means the subagent did not return a result. The lead
  never calls `A decide` for the other runtime: dispatch.sh decides and checks the floor itself (exit 6
  BLOCKED when unmet). `failover: auto` and codex installed: `A ledger-note <ID> "failover from=claude
  to=codex reason=<...>"`, then `D <ID> <role> [--focus F] --runtime codex --prompt-file
  .agents/local/assignments/<ID>/<file>` with the same assignment. `ask`: `A ask <ID>` with the D13 block
  (re-run on codex? options yes | no), relay `A questions`, STOP; on the user's yes, the `auto` steps.
  `off`: the step is BLOCKED.
- Never silent: every failover shows in the completion report's `## Execution`.
- Capability floor: a role whose floor no available runtime meets (always the case for a downgraded
  `security_reviewer`) is BLOCKED; the gate is never run on a weaker model.

## 3. Queue and concurrency

- One active run per worktree (the active run file); one implementer per run; a task queue runs
  sequentially, each task in its own run; the next task starts only after the previous run is cleaned up.
- `queue`: list `tasks.dir` (`todo/` before `backlog/`, then file order); show the list and run the first
  on the user's go; after each run's final report, ask before starting the next one when the previous run
  ended FAILED or BLOCKED.
- Parallel runs only in separate git worktrees, each with its own `.agents/local/ACTIVE_RUN`, at most
  `max_parallel_runs` (default 1), and only when their frozen `scope:` paths do not overlap. The lead never
  starts a run whose scope overlaps a running one.
