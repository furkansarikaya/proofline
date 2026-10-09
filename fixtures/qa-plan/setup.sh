#!/bin/sh
# Builds the qa-plan fixture repository in $1: a free-shipping rule whose
# implementation passes the happy-path tests but uses an exclusive threshold
# and accepts an empty cart. Deterministic and offline.
set -eu
[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
if [ -e "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $1" >&2; exit 1
fi
mkdir -p "$1"
cd "$1"
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
git init -q
git symbolic-ref HEAD refs/heads/main
git config commit.gpgsign false
git config core.autocrlf false
printf '.agents/\n' >> .git/info/exclude

N=0
commit() {
  N=$((N + 1))
  d="@$((1767261600 + N * 86400)) +0000"
  git add -A
  GIT_AUTHOR_DATE=$d GIT_COMMITTER_DATE=$d git commit -q -m "$1"
}

mkdir -p src test
cat > package.json <<'X'
{
  "name": "cart-fixture",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
X
cat > src/cart.js <<'X'
// A cart is an array of lines { sku, qty, unitCents }; all amounts are integer cents.
export function subtotalCents(cart) {
  return cart.reduce((sum, line) => sum + line.qty * line.unitCents, 0);
}
X
cat > test/cart.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtotalCents } from '../src/cart.js';

test('sums lines', () => {
  assert.equal(subtotalCents([{ sku: 'a', qty: 2, unitCents: 250 }, { sku: 'b', qty: 1, unitCents: 99 }]), 599);
});
X
commit "feat: cart subtotal"

cat > TASK.md <<'X'
# Task: FX-QA — Free shipping threshold

## Goal
Customers whose order reaches the free-shipping threshold pay no shipping.

## Context
`src/cart.js:subtotalCents` computes the cart subtotal. Amounts are integer cents.

## Acceptance criteria
- AC-1: `shippingCents(cart)` returns `0` when the cart subtotal is 50.00 (5000 cents) or more.
- AC-2: `shippingCents(cart)` returns `499` when the cart subtotal is below 50.00.
- AC-3: `shippingCents(cart)` throws an `Error` with the message `cart is empty` when the cart has no
  lines.

## Out of scope
Currencies other than the default, per-region rates, coupons.

## Constraints
Amounts are integer cents. No dependencies.

## Suggested class
STANDARD (bounded behaviour change in one module)

## Verification commands
- `node --test`
X
commit "chore: add task FX-QA"

cat > src/shipping.js <<'X'
import { subtotalCents } from './cart.js';

export const FREE_SHIPPING_CENTS = 5000;
export const FLAT_SHIPPING_CENTS = 499;

export function shippingCents(cart) {
  if (!Array.isArray(cart)) throw new TypeError('cart must be an array');
  if (!cart) throw new Error('cart is empty');
  return subtotalCents(cart) > FREE_SHIPPING_CENTS ? 0 : FLAT_SHIPPING_CENTS;
}
X
cat > test/shipping.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shippingCents } from '../src/shipping.js';

test('AC-1: free shipping for large orders', () => {
  assert.equal(shippingCents([{ sku: 'tv', qty: 1, unitCents: 60000 }]), 0);
});

test('AC-2: flat rate for small orders', () => {
  assert.equal(shippingCents([{ sku: 'pen', qty: 3, unitCents: 150 }]), 499);
});
X
commit "feat: free shipping threshold (FX-QA)"
