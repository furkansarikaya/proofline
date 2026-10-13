#!/bin/sh
# Proves the planted facts of the concurrency-proof fixture built in $1: the three planted problems
# show up under concurrent or retried calls, the three look-alikes do not, and the suite passes at HEAD.
set -eu
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM

[ "$(git rev-list --count HEAD)" -eq 2 ] || fail "expected 2 commits"
[ "$(git rev-parse base)" = "$(git rev-parse HEAD~1)" ] || fail "tag base is not HEAD~1"
changed=$(git diff --name-only base HEAD | tr '\n' ' ')
[ "$changed" = "src/inventory.js src/orders.js src/payments.js src/rates.js src/refunds.js src/retry.js src/wallet.js test/features.test.js " ] || fail "unexpected changed files: $changed"
[ -z "$(git status --porcelain)" ] || fail "working tree not clean"

# The planted lines EXPECTED.md cites.
line() { grep -n -F -- "$2" "$1" | head -1 | cut -d: -f1; }
[ "$(line src/wallet.js 'const account = await store.get(accountId);')" = 3 ] || fail "wallet.js:3"
[ "$(line src/wallet.js 'await store.put(accountId, { ...account, balance });')" = 5 ] || fail "wallet.js:5"
[ "$(line src/orders.js 'const order = await store.get(orderId);')" = 3 ] || fail "orders.js:3"
[ "$(line src/orders.js "if (order.status === 'shipped')")" = 4 ] || fail "orders.js:4"
[ "$(line src/orders.js "await store.put(orderId, { ...order, status: 'shipped' });")" = 6 ] || fail "orders.js:6"
[ "$(line src/orders.js 'await shipper.ship(orderId, order.address);')" = 5 ] || fail "orders.js:5"
[ "$(line src/payments.js 'gateway.charge({ cents, reference:')" = 5 ] || fail "payments.js:5"
[ "$(line src/retry.js 'return await withTimeout(operation(), timeoutMs * attempt);')" = 13 ] || fail "retry.js:13"
[ "$(line src/gateway.js 'if (idempotencyKey !== undefined && seen.has(idempotencyKey))')" = 9 ] || fail "gateway.js:9"
[ "$(line src/rates.js 'if (!cache.has(key)) {')" = 7 ] || fail "rates.js:7"
[ "$(line src/rates.js 'cache.set(key, table[key]);')" = 9 ] || fail "rates.js:9"
# Trap: nothing between the cache check and the set can yield to the event loop.
! sed -n '5,12p' src/rates.js | grep -Eq '\b(await|yield)\b|\.then\(' || fail "rates.js check-and-set must be synchronous"

# The suite at HEAD passes: no test exercises concurrency.
node --test >/dev/null 2>&1 || fail "HEAD test suite must pass"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/facts.mjs" <<'X'
const root = process.argv[2];
const m = async (f) => import(`${root}/src/${f}`);
const [{ createStore }, { createGateway }, { deposit }, { fulfil }, { chargeOrder }, { refundRequest }, { reserve }, rates] =
  await Promise.all(['store.js', 'gateway.js', 'wallet.js', 'orders.js', 'payments.js', 'refunds.js', 'inventory.js', 'rates.js'].map(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) { console.error(msg); process.exit(1); } };

// 1. Lost update: two concurrent deposits on one account; sequential deposits are the control.
let s = createStore({ a: { balance: 100 } });
await Promise.all([deposit(s, 'a', 10), deposit(s, 'a', 20)]);
check((await s.get('a')).balance !== 130, 'lost update not shown: concurrent deposits summed correctly');
s = createStore({ a: { balance: 100 } });
await deposit(s, 'a', 10); await deposit(s, 'a', 20);
check((await s.get('a')).balance === 130, 'control: sequential deposits must sum');

// 2. Double processing: two workers receive the same "paid" message.
const shipped = [];
const shipper = { ship: async (id) => { await sleep(1); shipped.push(id); } };
s = createStore({ o1: { status: 'paid', address: 'x' } });
await Promise.all([fulfil(s, shipper, 'o1'), fulfil(s, shipper, 'o1')]);
check(shipped.length === 2, `double shipment not shown: shipped ${shipped.length}`);

// 3. Retry side effect: a gateway slower than the first timeout charges twice; a fast one once.
let gw = createGateway({ latencyMs: 80 });
await chargeOrder(gw, 'o1', 500); await sleep(200);
check(gw.ledger.filter((e) => e.kind === 'charge').length === 2, `retry duplicate not shown: ${gw.ledger.length} charges`);
gw = createGateway({ latencyMs: 1 });
await chargeOrder(gw, 'o1', 500); await sleep(100);
check(gw.ledger.length === 1, 'control: a fast gateway charges once');

// Decoy 1: the mutex serialises concurrent reservations (stock 5, three requests of 2 -> two succeed).
s = createStore({ k: { stock: 5 } });
const ok = await Promise.all([reserve(s, 'k', 2), reserve(s, 'k', 2), reserve(s, 'k', 2)]);
check(ok.filter(Boolean).length === 2 && (await s.get('k')).stock === 1, `decoy lock: ${ok} stock ${(await s.get('k')).stock}`);
// Decoy 2: the same slow gateway refunds once, because the retry reuses the idempotency key.
gw = createGateway({ latencyMs: 80 });
await refundRequest(gw, 'r1', 500); await sleep(200);
check(gw.ledger.length === 1, `decoy idempotency: ${gw.ledger.length} refunds`);
// Trap: fifty concurrent conversions of one pair look up the rate once.
s = createStore({ a: { balance: 10, currency: 'EUR' } });
await Promise.all(Array.from({ length: 50 }, () => rates.convert(s, 'a', 'USD', { 'EUR:USD': 2 })));
check(rates.lookupCount() === 1, `trap cache: ${rates.lookupCount()} lookups`);
X
node "$tmp/facts.mjs" "$PWD" || fail "planted facts not shown"

# MUST reject (EXPECTED.md 12-15): the agent's own labels never close the traced lost update.
scripts=$(cd "$(dirname "$0")/../../skills/concurrency-proof/scripts" && pwd)
cat > "$tmp/docs.mjs" <<'X'
import { writeFileSync } from "node:fs";
const [scripts, out] = process.argv.slice(2);
const { scan } = await import(`${scripts}/find-shared-state.mjs`);
const n = scan({ repo: ".", base: "base" }).candidates.length;
const read = "const account = await store.get(accountId);", write = "await store.put(accountId, { ...account, balance });";
const st = (k, actor, line, code) => ({ n: k, actor, file: "src/wallet.js", line, code, action: "step" });
const c001 = (over) => ({ id: "C001", category: "lost_update", title: "lost update", status: "open", location: { file: "src/wallet.js", line: 5 },
  shared_state: "balance", evidence: "traced", why_not_reproduced: "selfcheck",
  trace: { actors: ["A", "B"], steps: [st(1, "A", 3, read), st(2, "B", 3, read), st(3, "A", 5, write), st(4, "B", 5, write)], outcome: "120 instead of 130" }, ...over });
const doc = (f, candidates = n) => ({ schema_version: 1, skill_version: "0.0.1", target: { type: "branch", name: "fx", base: "base", head: "HEAD" },
  scope: { changed_files: ["src/inventory.js", "src/orders.js", "src/payments.js", "src/rates.js", "src/refunds.js", "src/retry.js", "src/wallet.js", "test/features.test.js"], candidates, not_reviewed: [] },
  reproduction: { status: "unsupported", reason: "selfcheck" }, findings: [f], unproven_risks: [], judged: [], verdict: { summary: "One proven problem." } });
const docs = {
  open: doc(c001({})),
  pre_existing: doc(c001({ status: "pre_existing" })),
  closed_text: doc(c001({ status: "closed", recheck: "looked again" })),
  closed_own_step: doc(c001({ status: "closed", recheck: { kind: "fix", file: "src/wallet.js", line: 5, code: write } })),
  accepted_code: doc(c001({ status: "accepted", accepted_by: { file: "src/wallet.js", line: 5, quote: write } })),
  accepted_noplan: doc(c001({ status: "accepted", accepted_by: { file: "PLAN.md", line: 1, quote: "Deposits are serialised" } })),
  candidates: doc(c001({}), n + 3),
};
for (const [k, d] of Object.entries(docs)) writeFileSync(`${out}/${k}.json`, JSON.stringify(d));
X
node "$tmp/docs.mjs" "$scripts" "$tmp" || fail "could not write the validator documents"
node "$scripts/validate-concurrency.mjs" "$tmp/open.json" --repo . --base base > "$tmp/open.out" 2>&1 || fail "the honest C001 document must validate: $(cat "$tmp/open.out")"
grep -qx 'RESULT: FAIL' "$tmp/open.out" || fail "the honest C001 document must FAIL"
for k in pre_existing closed_text closed_own_step accepted_code accepted_noplan candidates; do
  if node "$scripts/validate-concurrency.mjs" "$tmp/$k.json" --repo . --base base > /dev/null 2>&1; then fail "$k: the relabelled C001 document validated"; fi
done
echo "selfcheck: concurrency-proof ok"
