// Builds the qa-plan fixture repository in <target-dir>: a free-shipping rule whose
// implementation passes the happy-path tests but uses an exclusive threshold
// and accepts an empty cart. Deterministic and offline.
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  f.init({ config: [['commit.gpgsign', 'false'], ['core.autocrlf', 'false']] });
  let n = 0;
  /** @param {string} message @param {string} [date] */
  const commit = (message, date) => {
    n++;
    const d = date ?? `@${1767261600 + n * 86400} +0000`;
    f.git(['add', '-A']);
    f.git(['commit', '-q', '-m', message], { env: { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } });
  };
  f.append('.git/info/exclude', '.agents/\n');

  f.mkdir('src', 'test');
  f.w('package.json', `{
  "name": "cart-fixture",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
`);
  f.w('src/cart.js', `// A cart is an array of lines { sku, qty, unitCents }; all amounts are integer cents.
export function subtotalCents(cart) {
  return cart.reduce((sum, line) => sum + line.qty * line.unitCents, 0);
}
`);
  f.w('test/cart.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtotalCents } from '../src/cart.js';

test('sums lines', () => {
  assert.equal(subtotalCents([{ sku: 'a', qty: 2, unitCents: 250 }, { sku: 'b', qty: 1, unitCents: 99 }]), 599);
});
`);
  commit('feat: cart subtotal');

  f.w('TASK.md', `# Task: FX-QA — Free shipping threshold

## Goal
Customers whose order reaches the free-shipping threshold pay no shipping.

## Context
\`src/cart.js:subtotalCents\` computes the cart subtotal. Amounts are integer cents.

## Acceptance criteria
- AC-1: \`shippingCents(cart)\` returns \`0\` when the cart subtotal is 50.00 (5000 cents) or more.
- AC-2: \`shippingCents(cart)\` returns \`499\` when the cart subtotal is below 50.00.
- AC-3: \`shippingCents(cart)\` throws an \`Error\` with the message \`cart is empty\` when the cart has no
  lines.

## Out of scope
Currencies other than the default, per-region rates, coupons.

## Constraints
Amounts are integer cents. No dependencies.

## Suggested class
STANDARD (bounded behaviour change in one module)

## Verification commands
- \`node --test\`
`);
  commit('chore: add task FX-QA');

  f.w('src/shipping.js', `import { subtotalCents } from './cart.js';

export const FREE_SHIPPING_CENTS = 5000;
export const FLAT_SHIPPING_CENTS = 499;

export function shippingCents(cart) {
  if (!Array.isArray(cart)) throw new TypeError('cart must be an array');
  if (!cart) throw new Error('cart is empty');
  return subtotalCents(cart) > FREE_SHIPPING_CENTS ? 0 : FLAT_SHIPPING_CENTS;
}
`);
  f.w('test/shipping.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shippingCents } from '../src/shipping.js';

test('AC-1: free shipping for large orders', () => {
  assert.equal(shippingCents([{ sku: 'tv', qty: 1, unitCents: 60000 }]), 0);
});

test('AC-2: flat rate for small orders', () => {
  assert.equal(shippingCents([{ sku: 'pen', qty: 3, unitCents: 150 }]), 499);
});
`);
  commit('feat: free shipping threshold (FX-QA)');

}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });

