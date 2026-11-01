// @ts-check
// A child that ends before it reads its stdin (a stub that exits at once) must not end the parent with an uncaught EPIPE: on Linux the write to
// the closed pipe fails at once, which blanked the SessionStart hook's answer when `agent.sh next` was a failing stub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAsync } from '../../control-plane/agents/scripts/core/proc.mjs';

test('runAsync reports the status of a child that never reads a large input', async () => {
  for (let i = 0; i < 20; i++) {
    const r = await runAsync('sh', ['-c', 'exit 127'], { input: 'x'.repeat(200000), stdio: ['pipe', 'pipe', 'pipe'], group: true });
    assert.equal(r.status, 127);
  }
});
