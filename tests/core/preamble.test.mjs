// @ts-check
// The delegation list of the agent.sh preamble and HANDLERS (core/commands/moved.mjs) are the same set: a command is moved by being in both.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HANDLERS } from '../../control-plane/agents/scripts/core/commands/moved.mjs';
import { COMMAND_NAMES } from '../../control-plane/agents/scripts/core/commands/names.mjs';
import { agentSh } from './helpers.mjs';

test('the preamble delegation list equals the keys of HANDLERS', () => {
  const m = /\ncase "\$\{1:-\}" in\n((?:[^\n]*\\\n)*[^\n]*\))\n    pl_sh=no/.exec(agentSh);
  assert.ok(m, 'preamble case not found');
  const listed = m[1].replace(/\\\n/g, '').trim().replace(/\)$/, '').split('|').map((s) => s.trim());
  assert.equal(new Set(listed).size, listed.length, 'a name is listed twice');
  assert.deepEqual([...listed].sort(), Object.keys(HANDLERS).sort());
  for (const c of listed) assert.ok(COMMAND_NAMES.includes(c), c);
});
