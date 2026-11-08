// @ts-check
// The fixture driver (tests/fixtures/check-fixtures.mjs): it builds a named fixture and runs its selfcheck, counts PASS and SKIP, and decides by the
// node version whether the TypeScript fixtures run. (Every fixture is built by the CI fixtures job; the builders are shell until issue #176 package B.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, nodeTsOk } from '../fixtures/check-fixtures.mjs';

test('a named fixture is built and its selfcheck passes; the proof-review and test-trust steps are not run for it', async () => {
  let out = '';
  const status = await main(['api-design'], { write: (s) => { out += s; } });
  assert.equal(status, 0, out);
  assert.equal(out, 'PASS api-design\nfixtures: 1/1 passed, 0 skipped\n');
});
test('a name without a setup.sh builds nothing and passes with zero fixtures', async () => {
  let out = '';
  assert.equal(await main(['no-such-fixture'], { write: (s) => { out += s; } }), 0);
  assert.equal(out, 'fixtures: 0/0 passed, 0 skipped\n');
});
test('TypeScript by type stripping needs node 22.18+, 23.6+ or 24+', () => {
  for (const [v, want] of /** @type {Array<[string, boolean]>} */ ([['22.17.9', false], ['22.18.0', true], ['23.5.0', false], ['23.6.0', true], ['24.0.0', true], ['20.19.0', false], ['25.1.0', true]])) assert.equal(nodeTsOk(v), want, v);
});
test('a setup that hangs is killed with its process group and fails (timeout)', async () => {
  // the driver takes the timeout as an option; a fixture that never finishes must not hold the job
  const { runGroup } = await import('../lib/proc.mjs');
  const t0 = Date.now();
  const r = await runGroup('sh', ['-c', 'sleep 30 & wait'], { timeoutMs: 500 });
  assert.equal(r.status, 124); assert.ok(r.timedOut); assert.ok(Date.now() - t0 < 10000);
  assert.match(r.stderr, /killed with its process group/);
});
