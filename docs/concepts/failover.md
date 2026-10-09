# Failover

All run state is in `RUN.yaml`, the ledger and the run artifacts, written after every transition. That is what
makes switching runtimes safe.

## Lead: resume

If the lead's runtime runs out of limit, open the other runtime in the same project and run:

```sh
proofline resume
```

It prints the run state, the ledger tail, freshness and the next step. The new session continues from the last
completed transition. An interrupted step restarts from its beginning, never from the middle.

## Specialist failover

Configured with `failover: auto | ask | off` in `.agents/config.yaml`; the default is `auto` when both
runtimes are installed.

- Switching happens only at step boundaries.
- The switch and its reason are written to the ledger and shown in the completion report.
- With `ask`, `dispatch.sh` asks you through the standard question mechanism first.
- With `off`, a failing runtime blocks the step.

This is not a silent fallback: it is allowed by config and recorded.

## Capability floor

Each role has a `tier_floor` (1 to 3) and each profile names a required model. If the other runtime cannot meet
a role's requirement under the active profile (for example the security reviewer's model), there is no switch and
that gate is BLOCKED. Security is never silently downgraded.

Related: [roles](roles.md), [gates](gates.md), [workflow](workflow.md).
