// Builds the plan-contract fixture repository in an empty directory given as <target-dir> and places the
// task the runner plans at TASK.md (git-excluded). Deterministic, no network, no installs.
import path from 'node:path';
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  f.init();
  f.git(['config', 'user.name', 'Fixture']);
  f.git(['config', 'user.email', 'fixture@example.invalid']);
  f.git(['config', 'commit.gpgsign', 'false']);
  f.git(['config', 'core.hooksPath', '.git/hooks']);
  f.mkdir('src/legacy', 'config', 'test');

  f.w('package.json', `{
  "name": "cart-fixture",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
`);

  f.w('config/shop.json', `{
  "currency": "EUR"
}
`);

  f.w('src/config.js', `import { readFileSync } from "node:fs";

export function loadConfig(path = new URL("../config/shop.json", import.meta.url)) {
  return JSON.parse(readFileSync(path, "utf8"));
}
`);

  f.w('src/cart.js', `export const SHIPPING_CENTS = 499;

export function cartTotal(cart) {
  const subtotal = cart.items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
  return { subtotal, shipping: SHIPPING_CENTS, total: subtotal + SHIPPING_CENTS };
}
`);

  f.w('src/receipt.js', `const money = (cents) => (cents / 100).toFixed(2);

export function renderReceipt(totals) {
  return [
    \`Subtotal: \${money(totals.subtotal)}\`,
    \`Shipping: \${money(totals.shipping)}\`,
    \`Total: \${money(totals.total)}\`,
  ].join("\\n");
}
`);

  f.w('src/legacy/shipping-old.js', `// Old shipping calculator with free shipping. Not used since the cart rewrite.
export function calcShipping(subtotal) {
  return subtotal > 50 ? 0 : 4.99;
}
`);

  f.w('test/cart.test.js', `import { test } from "node:test";
import assert from "node:assert/strict";
import { cartTotal } from "../src/cart.js";

test("cartTotal adds shipping", () => {
  assert.deepEqual(cartTotal({ items: [{ priceCents: 1000, qty: 2 }] }), { subtotal: 2000, shipping: 499, total: 2499 });
});
`);

  f.w('test/receipt.test.js', `import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReceipt } from "../src/receipt.js";

test("renderReceipt prints three lines", () => {
  assert.equal(renderReceipt({ subtotal: 2000, shipping: 499, total: 2499 }), "Subtotal: 20.00\\nShipping: 4.99\\nTotal: 24.99");
});
`);

  f.cp(path.join(import.meta.dirname, 'TASK.md'), 'TASK.md');
  f.append('.git/info/exclude', 'TASK.md\n.agents/\n.claude/\n');
  f.git(['add', '-A']);

  f.git(['add', '-A']);
  f.git(['commit', '-q', '-m', 'cart: totals and receipt'], { env: { GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z' } });
}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });

