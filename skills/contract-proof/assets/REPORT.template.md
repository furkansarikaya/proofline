# Contract compatibility: <target>

**Verdict:** <PASS|FAIL|UNSUPPORTED|BLOCKED> · **Confidence:** <high|medium|low>
(printed by `validate-contract.mjs`; never edited by hand)

## Blocking
- `<path:line>` <rule> <element> (<side>): <rule text>; <before> -> <after>. Not covered by PLAN.md `## Contracts`.
  In-repo consumers: <path:line, ... | none found statically>; outside the repository: unknown.

## Covered by the plan
- `<path:line>` <rule> <element>: covered by PLAN.md:<line> "<bullet>".

## Non-breaking
| file | rule | element | side | change |
|---|---|---|---|---|

## Consumer nuance (CP-N04, CP-N07)
- `<path:line>` <element>: the new value reaches <consumers>; non-breaking only if they tolerate unknown values.

## Unsupported
- `<path>` (<format>): <reason>. No compatibility proof for this file; never counted as a pass.

## Judged (never closes the gate alone)
- J-<n> `<location>`: <observation>; violates: <criterion written in the spec or plan | no written criterion>

## Evidence
- Differ: `node <skill-dir>/scripts/diff-contract.mjs ...` (measured)
- Tools: <name, command, exit | none detected>
- Consumers: `node <evidence-map-dir>/scripts/impact.mjs ...` (validated, exit 0), or the search used instead

<next step>
