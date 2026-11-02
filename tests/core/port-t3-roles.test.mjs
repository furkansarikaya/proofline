// @ts-check
// T3 port of tests/equivalence/role-table.test.mjs: every role against every one of the 132 commands is allowed or refused by the role gate as the shell did.
// The refusals were recorded ONCE from the shell (tests/fixtures/port-t3/roles.json); nothing runs the shell at test time. `lead test` was not run (it runs every suite);
// the gate lets the lead through by construction.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { commandAllowed } from '../../control-plane/agents/scripts/proofline-core.mjs';

/** @type {{ commands: string[], denied: Record<string, string[]> }} */
const g = JSON.parse(readFileSync(new URL('../fixtures/port-t3/roles.json', import.meta.url), 'utf8'));

test('the recorded command list is the 132 commands', () => { assert.equal(g.commands.length, 132); assert.equal(new Set(g.commands).size, 132); });

for (const [role, denied] of Object.entries(g.denied)) {
  test(`role ${role}: the commands the gate refuses are the recorded ones`, () => {
    const got = g.commands.filter((c) => !(role === 'lead' && c === 'test') && !commandAllowed(role, c)).sort();
    assert.deepEqual(got, denied);
  });
}

test('the gate as the shell stated it: the lead is never denied; the gate roles may record, gate and submit; the implementer may hand off', () => {
  const allowed = (/** @type {string} */ r) => g.commands.filter((c) => !g.denied[r].includes(c));
  assert.deepEqual(g.denied.lead, []);
  for (const r of ['reviewer', 'security_reviewer', 'qa', 'verifier']) for (const c of ['record', 'gate', 'submit', 'role', 'help']) assert.ok(allowed(r).includes(c), `${r} ${c}`);
  for (const c of ['start', 'freeze', 'approve', 'terminate']) assert.ok(!allowed('reviewer').includes(c), `reviewer must not run ${c}`);
  assert.ok(allowed('implementer').includes('worker-evidence') && allowed('implementer').includes('handoff'));
  assert.ok(!allowed('explorer').includes('handoff') && allowed('explorer').includes('submit'));
});
