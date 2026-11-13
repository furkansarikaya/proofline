// Proves the planted facts of the concurrency-proof fixture built in <dir>: the three planted problems
// show up under concurrent or retried calls, the three look-alikes do not, and the suite passes at HEAD.
// usage: node selfcheck.mjs <built-dir>
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, repoRoot, run } from '../../tests/lib/fixture.mjs';

const root = path.resolve(process.argv[2] ?? fail('usage: node selfcheck.mjs <built-dir>'));
process.chdir(root);
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (/** @type {string[]} */ ...a) => run('git', a, { cwd: root, env }).out.trim();

if (Number(git('rev-list', '--count', 'HEAD')) !== 2) fail('expected 2 commits');
if (git('rev-parse', 'base') !== git('rev-parse', 'HEAD~1')) fail('tag base is not HEAD~1');
const changed = `${git('diff', '--name-only', 'base', 'HEAD').split('\n').join(' ')} `;
if (changed !== 'src/inventory.js src/orders.js src/payments.js src/rates.js src/refunds.js src/retry.js src/wallet.js test/features.test.js ') fail(`unexpected changed files: ${changed}`);
if (git('status', '--porcelain') !== '') fail('working tree not clean');

// The planted lines EXPECTED.md cites.
const line = (/** @type {string} */ file, /** @type {string} */ text) => { const i = readFileSync(path.join(root, file), 'utf8').split('\n').findIndex((l) => l.includes(text)); return i < 0 ? '' : String(i + 1); };
/** @type {[string, string, number][]} */
const planted = [
  ['src/wallet.js', 'const account = await store.get(accountId);', 3], ['src/wallet.js', 'await store.put(accountId, { ...account, balance });', 5],
  ['src/orders.js', 'const order = await store.get(orderId);', 3], ['src/orders.js', "if (order.status === 'shipped')", 4],
  ['src/orders.js', "await store.put(orderId, { ...order, status: 'shipped' });", 6], ['src/orders.js', 'await shipper.ship(orderId, order.address);', 5],
  ['src/payments.js', 'gateway.charge({ cents, reference:', 5], ['src/retry.js', 'return await withTimeout(operation(), timeoutMs * attempt);', 13],
  ['src/gateway.js', 'if (idempotencyKey !== undefined && seen.has(idempotencyKey))', 9], ['src/rates.js', 'if (!cache.has(key)) {', 7], ['src/rates.js', 'cache.set(key, table[key]);', 9],
];
for (const [file, text, n] of planted) if (line(file, text) !== String(n)) fail(`${path.basename(file)}:${n}`);
// Trap: nothing between the cache check and the set can yield to the event loop.
if (/\b(await|yield)\b|\.then\(/.test(readFileSync(path.join(root, 'src/rates.js'), 'utf8').split('\n').slice(4, 12).join('\n'))) fail('rates.js check-and-set must be synchronous');

// The suite at HEAD passes: no test exercises concurrency.
if (run('node', ['--test'], { cwd: root }).status !== 0) fail('HEAD test suite must pass');

const tmp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'concurrency-selfcheck-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// --- the planted facts, shown under concurrent or retried calls ---------------------------------------------------------------------------------
const m = (/** @type {string} */ f) => import(pathToFileURL(path.join(root, 'src', f)).href);
const [{ createStore }, { createGateway }, { deposit }, { fulfil }, { chargeOrder }, { refundRequest }, { reserve }, rates] =
  await Promise.all(['store.js', 'gateway.js', 'wallet.js', 'orders.js', 'payments.js', 'refunds.js', 'inventory.js', 'rates.js'].map(m));
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const check = (/** @type {boolean} */ ok, /** @type {string} */ msg) => { if (!ok) { console.error(msg); fail('planted facts not shown'); } };

// 1. Lost update: two concurrent deposits on one account; sequential deposits are the control.
let s = createStore({ a: { balance: 100 } });
await Promise.all([deposit(s, 'a', 10), deposit(s, 'a', 20)]);
check((await s.get('a')).balance !== 130, 'lost update not shown: concurrent deposits summed correctly');
s = createStore({ a: { balance: 100 } });
await deposit(s, 'a', 10); await deposit(s, 'a', 20);
check((await s.get('a')).balance === 130, 'control: sequential deposits must sum');

// 2. Double processing: two workers receive the same "paid" message.
const shipped = [];
const shipper = { ship: async (/** @type {string} */ id) => { await sleep(1); shipped.push(id); } };
s = createStore({ o1: { status: 'paid', address: 'x' } });
await Promise.all([fulfil(s, shipper, 'o1'), fulfil(s, shipper, 'o1')]);
check(shipped.length === 2, `double shipment not shown: shipped ${shipped.length}`);

// 3. Retry side effect: a gateway slower than the first timeout charges twice; a fast one once.
let gw = createGateway({ latencyMs: 80 });
await chargeOrder(gw, 'o1', 500); await sleep(200);
check(gw.ledger.filter((/** @type {any} */ e) => e.kind === 'charge').length === 2, `retry duplicate not shown: ${gw.ledger.length} charges`);
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

// MUST reject (EXPECTED.md 12-16): the agent's own labels never close the traced lost update.
const scripts = path.join(repoRoot, 'skills/concurrency-proof/scripts');
const { scan } = await import(pathToFileURL(path.join(scripts, 'find-shared-state.mjs')).href);
const n = scan({ repo: '.', base: 'base' }).candidates.length;
const read = 'const account = await store.get(accountId);'; const write = 'await store.put(accountId, { ...account, balance });';
const st = (/** @type {number} */ k, /** @type {string} */ actor, /** @type {number} */ ln, /** @type {string} */ code) => ({ n: k, actor, file: 'src/wallet.js', line: ln, code, action: 'step' });
const c001 = (/** @type {object} */ over) => ({ id: 'C001', category: 'lost_update', title: 'lost update', status: 'open', location: { file: 'src/wallet.js', line: 5 },
  shared_state: 'balance', evidence: 'traced', why_not_reproduced: 'selfcheck',
  trace: { actors: ['A', 'B'], steps: [st(1, 'A', 3, read), st(2, 'B', 3, read), st(3, 'A', 5, write), st(4, 'B', 5, write)], outcome: '120 instead of 130' }, ...over });
const doc = (/** @type {object} */ finding, candidates = n) => ({ schema_version: 1, skill_version: "0.0.97", target: { type: 'branch', name: 'fx', base: 'base', head: 'HEAD' },
  scope: { changed_files: ['src/inventory.js', 'src/orders.js', 'src/payments.js', 'src/rates.js', 'src/refunds.js', 'src/retry.js', 'src/wallet.js', 'test/features.test.js'], candidates, not_reviewed: [] },
  reproduction: { status: 'unsupported', reason: 'selfcheck' }, findings: [finding], unproven_risks: [], judged: [], verdict: { summary: 'One proven problem.' } });
/** @type {Record<string, object>} */
const docs = {
  open: doc(c001({})),
  pre_existing: doc(c001({ status: 'pre_existing' })),
  closed_text: doc(c001({ status: 'closed', recheck: 'looked again' })),
  closed_own_step: doc(c001({ status: 'closed', recheck: { kind: 'fix', file: 'src/wallet.js', line: 5, code: write } })),
  accepted_code: doc(c001({ status: 'accepted', accepted_by: { file: 'src/wallet.js', line: 5, quote: write } })),
  accepted_noplan: doc(c001({ status: 'accepted', accepted_by: { file: 'PLAN.md', line: 1, quote: 'Deposits are serialised' } })),
  candidates: doc(c001({}), n + 3),
  closed_comment: doc(c001({ status: 'closed', recheck: { kind: 'fix', file: 'src/wallet.js', line: 1, code: '// Deposits add to an account balance.' } })),
  closed_repro_traced: doc(c001({ status: 'closed', recheck: { kind: 'reproduction', command: 'node --test', runs: 10, failures: 0, observed: 'ok', saved_copy: 'evidence/x.txt', sha256: '0'.repeat(64) } })),
};
for (const [k, d] of Object.entries(docs)) writeFileSync(path.join(tmp, `${k}.json`), JSON.stringify(d));
const validate = (/** @type {string} */ k) => run('node', [path.join(scripts, 'validate-concurrency.mjs'), path.join(tmp, `${k}.json`), '--repo', '.', '--base', 'base'], { cwd: root });
const open = validate('open');
if (open.status !== 0) fail(`the honest C001 document must validate: ${open.text.trimEnd()}`);
if (!open.text.split('\n').includes('RESULT: FAIL')) fail('the honest C001 document must FAIL');
for (const k of ['pre_existing', 'closed_text', 'closed_own_step', 'closed_comment', 'closed_repro_traced', 'accepted_code', 'accepted_noplan', 'candidates'])
  if (validate(k).status === 0) fail(`${k}: the relabelled C001 document validated`);
console.log('selfcheck: concurrency-proof ok');
