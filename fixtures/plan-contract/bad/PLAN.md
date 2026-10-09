---
scope:
  - path: src/**/*.js
    criteria: [AC-1]
  - path: src/cart.js
    criteria: [AC-1, AC-2]
  - path: src/cart.js
    criteria: [AC-2]
  - path: src/shipping.js
    criteria: [AC-1]
  - path: src/receipt.js
    criteria: [AC-9]
  - path: test/cart.test.js
    criteria: []
  - path: config/shop.json
    new: true
    criteria: [AC-3]
    tdd_exemption: "not needed"
  - path: src/legacy
    criteria: [AC-1]
    tdd_exemption: "configuration change for this change"
---

# Plan: T-7

## Behavior

Free shipping above the threshold.

## Tests

- AC-4: the receipt looks right

## Verification commands

npm test

## Data

The threshold lives in a config file.

## Dependencies

TBD
