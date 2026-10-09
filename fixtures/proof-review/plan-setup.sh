#!/bin/sh
# Builds the proof-review fixture as a proofline run, for focus=plan (D21).
#
# usage: sh plan-setup.sh <go|ts> <target-dir>
#
# Runs the branch-mode fixture (<lang>/setup.sh, which needs bash), then on top of it:
#   - a versioned contract (api/v1/openapi.yaml) in the base commit, edited by the feature branch;
#   - a feature commit that declares two new dependencies, one named in the plan and one not;
#   - a run folder .agents/runs/FIX-1/ with RUN.yaml (repository.base_sha), TASK.md (one
#     acceptance criterion per planted claim) and PLAN.md (scope that leaves some changed
#     paths out), and .agents/local/ACTIVE_RUN.
# Expected results are in EXPECTED.md ("Focus plan inside a run"). The agent must not see it.
set -eu

usage() { echo "usage: sh plan-setup.sh <go|ts> <target-dir>" >&2; exit 2; }
[ $# -eq 2 ] || usage
lang=$1; target=$2
case $lang in go|ts) ;; *) usage ;; esac
here=$(cd "$(dirname "$0")" && pwd)

bash "$here/$lang/setup.sh" "$target" >/dev/null
target=$(cd "$target" && pwd)
g() { git -C "$target" "$@"; }
commit() { # $1 = date, message on stdin
  g add -A
  GIT_AUTHOR_DATE=$1 GIT_COMMITTER_DATE=$1 g commit -q -F -
}

feature=$(g symbolic-ref --short HEAD)

# base: the v1 contract
g checkout -q main
mkdir -p "$target/api/v1"
if [ "$lang" = go ]; then route=/v1/orders; else route=/v1/checkout; fi
cat > "$target/api/v1/openapi.yaml" <<EOF
openapi: 3.0.3
info:
  title: Shop API
  version: v1
paths:
  $route:
    post:
      summary: Place an order
      responses:
        "201":
          description: The saved order
          content:
            application/json:
              schema:
                type: object
                properties:
                  email:
                    type: string
                  total:
                    type: integer
EOF
commit 2026-01-05T11:00:00+00:00 <<'EOF'
Add the v1 API contract
EOF
base=$(g rev-parse HEAD)
g checkout -q "$feature"
g -c core.hooksPath=/dev/null rebase -q main

# feature: the contract changes and dependencies appear
if [ "$lang" = go ]; then
  prop='                  couponCode:'
  cat >> "$target/go.mod" <<'EOF'

require (
	github.com/lib/pq v1.10.9
	golang.org/x/text v0.14.0
)
EOF
else
  prop='                  idempotencyKey:'
  cat > "$target/package.json" <<'EOF'
{
  "name": "shop-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  },
  "dependencies": {
    "ioredis": "^5.4.1",
    "zod": "^3.23.8"
  }
}
EOF
fi
printf '%s\n                    type: string\n' "$prop" >> "$target/api/v1/openapi.yaml"
commit 2026-01-07T10:00:00+00:00 <<'EOF'
Expose the new field in the v1 contract and declare dependencies
EOF

# the run
run=$target/.agents/runs/FIX-1
mkdir -p "$run" "$target/.agents/local"
printf 'FIX-1\n' > "$target/.agents/local/ACTIVE_RUN"
cat > "$run/RUN.yaml" <<EOF
task:
  id: FIX-1
repository:
  base_sha: $base
  canonical_branch: main
  task_branch: $feature
EOF

if [ "$lang" = go ]; then
  cat > "$run/TASK.md" <<'EOF'
# Task: FIX-1

## Objective

Customers can enter a coupon code at checkout.

## Acceptance criteria

- AC-1: Checkout takes a Coupons store and reads the code from Order.CouponCode; codes are case-insensitive and surrounding spaces are ignored.
- AC-2: Percentage coupons (SAVE10, 10% off, rounded down to the whole cent) and fixed-amount coupons (FIVEOFF, 5.00 off) exist; a fixed coupon never takes the total below zero.
- AC-3: The coupon is applied after the automatic 10% discount for orders of 100.00 or more.
- AC-4: Every coupon has a usage limit (max_uses): a coupon with a limit of N can be used by N orders, and the next checkout fails with ErrCouponUsedUp; uses are counted in Postgres by PostgresCoupons.
- AC-5: The receipt email gets a line with the coupon and the amount saved, for example "Coupon FIVEOFF: -5.00 USD".
- AC-6: The saved order records the coupon code and the discount amount (Order.CouponCode, Order.Discount).
- AC-7: Expired coupons are rejected with ErrCouponExpired.
EOF
  cat > "$run/PLAN.md" <<'EOF'
---
scope:
  - path: shop.go
    criteria: [AC-1, AC-3, AC-5, AC-6, AC-7]
  - path: coupon.go
    criteria: [AC-1, AC-2]
  - path: coupon_pg.go
    criteria: [AC-4]
  - path: coupon_test.go
    criteria: [AC-1, AC-2, AC-3, AC-5]
  - path: shop_test.go
    criteria: [AC-1, AC-3]
---

# Plan: FIX-1

## Behavior

Coupon codes are normalized in one place. Case folding may use golang.org/x/text if the standard library is not enough. Usage counts live in Postgres.

## Tests

`go test ./...`.

## Verification commands

- `go test ./...`

## Dependencies

- golang.org/x/text (case folding of coupon codes)

## Contracts

None.
EOF
else
  cat > "$run/TASK.md" <<'EOF'
# Task: FIX-1

## Objective

Make checkout safe to retry.

## Acceptance criteria

- AC-1: checkout takes an optional idempotencyKey and an IdempotencyStore (options.keys); a retry with the same key returns the first order and does not save the order or send the receipt again.
- AC-2: Keys are scoped per customer: the same key sent with two different email addresses creates two separate orders.
- AC-3: Production uses RedisIdempotency so retries are recognised across all API instances; tests and local runs use MemoryIdempotency.
- AC-4: Saved orders record the idempotency key and the time of checkout (idempotencyKey, createdAt).
- AC-5: A retry that reuses a key with a different cart is rejected with IdempotencyConflictError instead of returning the first order.
EOF
  cat > "$run/PLAN.md" <<'EOF'
---
scope:
  - path: src/shop.ts
    criteria: [AC-1, AC-2, AC-4, AC-5]
  - path: src/idempotency.ts
    criteria: [AC-3]
  - path: src/checkout.test.ts
    criteria: [AC-1, AC-2, AC-3]
  - path: src/shop.test.ts
    criteria: [AC-1]
---

# Plan: FIX-1

## Behavior

Keys are claimed before the order is saved. Key shapes may be validated with zod. Redis access goes through the RedisClient interface.

## Tests

`npm test`.

## Verification commands

- `npm test`

## Dependencies

- zod (idempotency key validation)

## Contracts

None.
EOF
fi
echo "fixture ready: $target ($lang, run FIX-1 on $feature, base $base)"
