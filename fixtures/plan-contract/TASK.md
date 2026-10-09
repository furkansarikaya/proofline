# Task: T-7 — Free shipping above a threshold

## Goal

Carts at or above a configurable subtotal ship for free.

## Context

`src/cart.js:cartTotal` adds a flat 499-cent shipping fee to every cart. Shop settings are read by `src/config.js:loadConfig` from `config/shop.json`.

## Acceptance criteria

- AC-1: A cart whose subtotal is at or above the threshold is charged 0 shipping.
- AC-2: A cart whose subtotal is below the threshold is charged 499 cents shipping.
- AC-3: The threshold is read from the `freeShippingThreshold` key (cents) of `config/shop.json`; without the key it is 5000.
- AC-4: The receipt shows the line "Shipping: free" when the shipping charge is 0.

## Out of scope

- Per-country shipping rates.
- Changing the 499-cent fee.

## Constraints

- Money is integer cents.
- No new dependencies.

## Risks

- `src/receipt.js:renderReceipt` output is parsed by the accounting import; only the shipping line may change.

## Suggested class

STANDARD (two modules and their tests; no persistence, no public API)

## Verification commands

- `npm test`
