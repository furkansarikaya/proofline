#!/bin/sh
# Builds the plan-contract fixture repository in an empty directory given as $1 and places the
# task the runner plans at TASK.md (git-excluded). Deterministic, no network, no installs.
set -eu
[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
TARGET=$1
HERE=$(cd "$(dirname "$0")" && pwd)
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $TARGET" >&2; exit 1
fi
mkdir -p "$TARGET"
cd "$TARGET"
git init -q
git symbolic-ref HEAD refs/heads/main
git config user.name Fixture
git config user.email fixture@example.invalid
git config commit.gpgsign false
git config core.hooksPath .git/hooks
mkdir -p src/legacy config test

cat > package.json <<'EOF'
{
  "name": "cart-fixture",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF

cat > config/shop.json <<'EOF'
{
  "currency": "EUR"
}
EOF

cat > src/config.js <<'EOF'
import { readFileSync } from "node:fs";

export function loadConfig(path = new URL("../config/shop.json", import.meta.url)) {
  return JSON.parse(readFileSync(path, "utf8"));
}
EOF

cat > src/cart.js <<'EOF'
export const SHIPPING_CENTS = 499;

export function cartTotal(cart) {
  const subtotal = cart.items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
  return { subtotal, shipping: SHIPPING_CENTS, total: subtotal + SHIPPING_CENTS };
}
EOF

cat > src/receipt.js <<'EOF'
const money = (cents) => (cents / 100).toFixed(2);

export function renderReceipt(totals) {
  return [
    `Subtotal: ${money(totals.subtotal)}`,
    `Shipping: ${money(totals.shipping)}`,
    `Total: ${money(totals.total)}`,
  ].join("\n");
}
EOF

cat > src/legacy/shipping-old.js <<'EOF'
// Old shipping calculator with free shipping. Not used since the cart rewrite.
export function calcShipping(subtotal) {
  return subtotal > 50 ? 0 : 4.99;
}
EOF

cat > test/cart.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { cartTotal } from "../src/cart.js";

test("cartTotal adds shipping", () => {
  assert.deepEqual(cartTotal({ items: [{ priceCents: 1000, qty: 2 }] }), { subtotal: 2000, shipping: 499, total: 2499 });
});
EOF

cat > test/receipt.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReceipt } from "../src/receipt.js";

test("renderReceipt prints three lines", () => {
  assert.equal(renderReceipt({ subtotal: 2000, shipping: 499, total: 2499 }), "Subtotal: 20.00\nShipping: 4.99\nTotal: 24.99");
});
EOF

cp "$HERE/TASK.md" TASK.md
printf '%s\n' TASK.md .agents/ .claude/ >> .git/info/exclude
git add -A
GIT_AUTHOR_DATE=2026-01-01T10:00:00Z GIT_COMMITTER_DATE=2026-01-01T10:00:00Z git commit -q -m "cart: totals and receipt"
