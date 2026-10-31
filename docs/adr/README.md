# Architecture decision records

An architecture decision record (ADR) explains one decision that shapes the whole repository and is carried out over several
releases: the context with measured numbers, the decision, what does not change, the alternatives rejected and the consequences.
Smaller decisions stay in [docs/decisions.md](../decisions.md) as `A<n>` entries; every ADR also has an `A<n>` entry there that links
back to it and states, per decision, which Core invariant of [CONTRIBUTING.md](../../CONTRIBUTING.md#core-invariants) it does not
loosen.

An ADR is changed only by a later decision recorded in `docs/decisions.md`. Companion files (`NNNN-<topic>.md`) hold material that
is too long for the record itself, such as an inventory or a stage plan.

| ADR | title | status | decision entry | companions |
|---|---|---|---|---|
| [0001](0001-node-control-plane.md) | Move the control plane, hooks, CLI and tests from shell and awk to Node | accepted as a plan; carried out in 15 stages | A204 | [inventory](0001-inventory.md), [stages](0001-stages.md) |
