# Amendment: <sequence>-<reason>

Written by the lead to `amendments/<file>`; one amendment authorizes exactly one `agent.sh refreeze`.

## Trigger

What was missing or what failed (finding ids, evidence).

## Change

Added or changed scope paths (`new: true` where they do not exist yet), criteria, constraints.

## Authorization

Who authorized it. Added scope paths need a `scope` approval (`agent.sh request-approval <ID> scope`).

## Effect

A refreeze from IMPLEMENTED returns the run to IMPLEMENTING, voids every gate and starts a fresh fix budget.
