# Review: Monthly orders export

verdict: ship-with-conditions
round: 1

## Completeness

- error and empty states: covered (AC-2)
- permissions and roles: not applicable
- personal data and retention: covered (Q-1; the file holds totals only)
- security: not applicable
- performance: covered (NFR-1)
- accessibility: not applicable
- multilingual: not applicable
- analytics events: covered (M-1)
- rollout and migration: not applicable
- dependencies: covered (FR-1)

## Never mentioned

- Time zone of the month boundary: an order at 23:30 on the last day may fall in either month, so the PRD must name the zone.
- Orders edited after export: finance may export twice, and the second file can differ from the first.
- Very large months: NFR-1 stops at 10000 orders, so the behaviour above that limit is undefined.

## Conditions

- Q-1 is answered before the task for FR-2 starts.
