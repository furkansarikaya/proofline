# plan-contract fixture: expectations

Evaluator-only. A runner never reads this file; build the scenario outside this repository.

## Scenario

`sh fixtures/plan-contract/setup.sh <dir>` builds a small cart library and places the task at `<dir>/TASK.md` (git-excluded): T-7, free shipping above a configurable threshold, class STANDARD, criteria AC-1..AC-4.

Run in `<dir>`: `/plan-contract TASK.md` (standalone; output `.agents/local/plan-contract/T-7/PLAN.md`), or the lead's planning step with `TASK.md` in the run folder.

Planted:

| Item | Where | Trap |
|---|---|---|
| dead free-shipping calculator with float math and `> 50` | `src/legacy/shipping-old.js:calcShipping` | must not be in scope or reused |
| flat fee constant | `src/cart.js:SHIPPING_CENTS` | the live code to change |
| receipt output parsed by accounting (TASK Risks) | `src/receipt.js:renderReceipt` | only the shipping line may change |
| config loader | `src/config.js:loadConfig` | AC-3 reads through it; `config/shop.json` has no threshold key yet |

## Required scope

| # | Path | Criteria (at least) | Notes |
|---|---|---|---|
| R1 | `src/cart.js` | AC-1, AC-2 | or a new `src/shipping.js` (`new: true`) with AC-1, AC-2, AC-3 **and** `src/cart.js` for the integration |
| R2 | `src/receipt.js` | AC-4 | |
| R3 | `test/cart.test.js` or a new `test/shipping.test.js` | AC-1, AC-2 (and AC-3 if the threshold is tested there) | |
| R4 | `test/receipt.test.js` | AC-4 | |
| R5 | AC-3 mapped to the code that reads `freeShippingThreshold` (`src/cart.js`, `src/shipping.js` or `src/config.js`) and to a test | AC-3 | `config/shop.json` in scope is optional; if present it needs a specific `tdd_exemption` or a test mapping |

Every TASK criterion maps to a scope path; every scope path maps to a criterion.

## Must not

| # | Item |
|---|---|
| N1 | `src/legacy/shipping-old.js` in scope (dead code, no criterion needs it) |
| N2 | any glob, directory, duplicate, or `./` path |
| N3 | `## Architecture` required? No (STANDARD); if present it must not be a placeholder |
| N4 | `## Data` with `destructive: yes`; a `## Data` section at all is unexpected (no persistence) and is noted |
| N5 | a new dependency (`## Dependencies` must be `none`); a contract change (`## Contracts` `none`) |
| N6 | a `tdd_exemption` on `src/cart.js`, `src/receipt.js` or `src/shipping.js` |
| N7 | `## Verification commands` other than the project's own (`npm test` / `node --test`) |

## Process expectations

- **P1** `node skills/plan-contract/scripts/validate-plan.mjs <PLAN.md> <dir>/TASK.md --class STANDARD --repo <dir>` exits 0 (the evaluator re-runs it).
- **P2** The run shows the validator ran and was fixed until exit 0 before the plan was presented.
- **P3** Standalone: the run ends with the approval question, not with implementation.
- **P4** No file in `<dir>` outside `.agents/local/` is modified.

## Known-bad plan

`fixtures/plan-contract/bad/PLAN.md` must be rejected (exit 1) by `validate-plan.mjs` against `<dir>/TASK.md --repo <dir>` with at least these messages (`tests/skills/plan-contract.test.mjs` asserts them):

| Violation | Message contains |
|---|---|
| glob scope `src/**/*.js` | `glob patterns are not allowed` |
| `src/cart.js` listed twice | `duplicate path` |
| `src/shipping.js` missing, not `new: true` | `does not exist; mark it new: true` |
| `src/receipt.js` mapped to `AC-9` | `unknown criterion AC-9` |
| `test/cart.test.js` with `criteria: []` | `maps to no criterion` |
| `config/shop.json` marked `new: true` | `exists but is marked new: true` |
| `tdd_exemption: "not needed"` | `tdd_exemption must be at least 20 characters` |
| `tdd_exemption: "configuration change for this change"` | `tdd_exemption is a stock phrase` |
| `src/legacy` (directory) | `is a directory` |
| AC-4 only in a Tests line without a test file | `AC-4: maps to no scope path and no explicit test` |
| `## Contracts` missing | `section "## Contracts" is required` |
| `## Dependencies` is `TBD` | `section "## Dependencies" is empty or a placeholder` |
| `## Data` without `destructive:` first line | `first line must be "destructive: yes" or "destructive: no"` |
| `npm test` not in backticks | `no command in backticks or a code block` |
