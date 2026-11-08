// Builds the concurrency-proof fixture repository in <target-dir>: a base commit (tag `base`: an async record
// store, a payment gateway stand-in, a mutex) and one feature commit on top that plants three proven
// concurrency problems (a lost update, a check-then-act double shipment, a retry that charges twice) next
// to three look-alikes that are correct (a mutex-guarded reservation, a retry with an idempotency key, a
// synchronous cache check-and-set). Deterministic and offline; installs nothing.
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  f.init({ config: [['commit.gpgsign', 'false'], ['core.autocrlf', 'false']] });
  f.append('.git/info/exclude', '.agents/\n');
  let n = 0;
  const commit = (/** @type {string} */ msg) => { n++; f.commit(msg, `@${1767261600 + n * 86400} +0000`); };
  // 1: base
  f.mkdir(`src`, `test`);
f.w(`package.json`, `{
  "name": "shop-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`);
f.w(`src/store.js`, `// In-memory record store with asynchronous I/O, standing in for a database client.
// Every call yields to the event loop before it touches the data, like a network round trip.
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

export function createStore(initial = {}) {
  const rows = new Map(Object.entries(initial).map(([id, row]) => [id, { ...row }]));
  return {
    async get(id) {
      await tick();
      const row = rows.get(id);
      return row ? { ...row } : undefined;
    },
    async put(id, row) {
      await tick();
      rows.set(id, { ...row });
    },
  };
}
`);
f.w(`src/gateway.js`, `// Payment gateway client: an in-memory stand-in with the provider's documented semantics.
// A request whose idempotencyKey was already seen returns the first result and has no new effect.
// A request without an idempotencyKey always creates a new charge or refund; \`reference\` is free text
// shown on statements and is never used for deduplication.
export function createGateway({ latencyMs = 1 } = {}) {
  const seen = new Map();
  const ledger = [];
  const effect = (kind, cents, idempotencyKey) => {
    if (idempotencyKey !== undefined && seen.has(idempotencyKey)) return seen.get(idempotencyKey);
    const result = { id: \`\${kind}-\${ledger.length + 1}\`, kind, cents };
    ledger.push(result);
    if (idempotencyKey !== undefined) seen.set(idempotencyKey, result);
    return result;
  };
  const later = (fn) => new Promise((resolve) => setTimeout(() => resolve(fn()), latencyMs));
  return {
    ledger,
    charge: ({ cents, reference, idempotencyKey }) => later(() => effect('charge', cents, idempotencyKey)),
    refund: ({ cents, reference, idempotencyKey }) => later(() => effect('refund', cents, idempotencyKey)),
  };
}
`);
f.w(`src/mutex.js`, `// A minimal async mutex: callers run one at a time, in arrival order.
export function createMutex() {
  let tail = Promise.resolve();
  return {
    async runExclusive(fn) {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
`);
f.w(`test/base.test.js`, `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createGateway } from '../src/gateway.js';

test('store round trip', async () => {
  const store = createStore({ a: { n: 1 } });
  await store.put('a', { n: 2 });
  assert.deepEqual(await store.get('a'), { n: 2 });
});

test('gateway deduplicates by idempotency key only', async () => {
  const gw = createGateway();
  await gw.charge({ cents: 5, idempotencyKey: 'k' });
  await gw.charge({ cents: 5, idempotencyKey: 'k' });
  await gw.charge({ cents: 5, reference: 'r' });
  await gw.charge({ cents: 5, reference: 'r' });
  assert.equal(gw.ledger.length, 3);
});
`);
  commit("feat: record store and payment gateway client");
  f.git(["tag", "base"]);
  // 2: the change under review
f.w(`src/retry.js`, `// Retries an operation that may be slow: each attempt gets a longer timeout.
export function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export async function retry(operation, { attempts = 3, timeoutMs = 50 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withTimeout(operation(), timeoutMs * attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`);
f.w(`src/wallet.js`, `// Deposits add to an account balance.
export async function deposit(store, accountId, cents) {
  const account = await store.get(accountId);
  const balance = account.balance + cents;
  await store.put(accountId, { ...account, balance });
  return balance;
}
`);
f.w(`src/orders.js`, `// Ships a paid order once; called by every worker that receives the order's "paid" message.
export async function fulfil(store, shipper, orderId) {
  const order = await store.get(orderId);
  if (order.status === 'shipped') return 'already shipped';
  await shipper.ship(orderId, order.address);
  await store.put(orderId, { ...order, status: 'shipped' });
  return 'shipped';
}
`);
f.w(`src/payments.js`, `import { retry } from './retry.js';

// Charges an order; a slow gateway call is retried.
export async function chargeOrder(gateway, orderId, cents) {
  return retry(() => gateway.charge({ cents, reference: \`order \${orderId}\` }));
}
`);
f.w(`src/refunds.js`, `import { retry } from './retry.js';

// Refunds a request; a slow gateway call is retried with the same idempotency key.
export async function refundRequest(gateway, requestId, cents) {
  return retry(() => gateway.refund({ cents, reference: \`refund \${requestId}\`, idempotencyKey: \`refund:\${requestId}\` }));
}
`);
f.w(`src/inventory.js`, `import { createMutex } from './mutex.js';

const mutex = createMutex();

// Reserves stock; the read-modify-write runs under the module's mutex.
export async function reserve(store, sku, qty) {
  return mutex.runExclusive(async () => {
    const item = await store.get(sku);
    if (item.stock < qty) return false;
    await store.put(sku, { ...item, stock: item.stock - qty });
    return true;
  });
}
`);
f.w(`src/rates.js`, `// Exchange rates are cached per currency pair for the life of the process.
const cache = new Map();
let lookups = 0;

export function rateFor(table, from, to) {
  const key = \`\${from}:\${to}\`;
  if (!cache.has(key)) {
    lookups++;
    cache.set(key, table[key]);
  }
  return cache.get(key);
}

export const lookupCount = () => lookups;

export async function convert(store, accountId, to, table) {
  const account = await store.get(accountId);
  return Math.round(account.balance * rateFor(table, account.currency, to));
}
`);
f.w(`test/features.test.js`, `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createGateway } from '../src/gateway.js';
import { deposit } from '../src/wallet.js';
import { fulfil } from '../src/orders.js';
import { chargeOrder } from '../src/payments.js';
import { refundRequest } from '../src/refunds.js';
import { reserve } from '../src/inventory.js';
import { convert } from '../src/rates.js';

test('deposit adds to the balance', async () => {
  const store = createStore({ a: { balance: 100 } });
  assert.equal(await deposit(store, 'a', 10), 110);
  assert.equal(await deposit(store, 'a', 20), 130);
});

test('fulfil ships once', async () => {
  const shipped = [];
  const store = createStore({ o1: { status: 'paid', address: 'x' } });
  const shipper = { ship: async (id) => { shipped.push(id); } };
  assert.equal(await fulfil(store, shipper, 'o1'), 'shipped');
  assert.equal(await fulfil(store, shipper, 'o1'), 'already shipped');
  assert.deepEqual(shipped, ['o1']);
});

test('charge and refund go through the gateway', async () => {
  const gw = createGateway();
  assert.equal((await chargeOrder(gw, 'o1', 500)).kind, 'charge');
  assert.equal((await refundRequest(gw, 'r1', 500)).kind, 'refund');
  assert.equal(gw.ledger.length, 2);
});

test('reserve refuses more than the stock', async () => {
  const store = createStore({ s: { stock: 3 } });
  assert.equal(await reserve(store, 's', 2), true);
  assert.equal(await reserve(store, 's', 2), false);
});

test('convert uses the rate table', async () => {
  const store = createStore({ a: { balance: 1000, currency: 'EUR' } });
  assert.equal(await convert(store, 'a', 'USD', { 'EUR:USD': 1.5 }), 1500);
});
`);
  commit("feat: deposits, fulfilment, charges, refunds, reservations and rates");

}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });
