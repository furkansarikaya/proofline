// @ts-check
// The delegation list of the agent.sh preamble and HANDLERS (core/commands/moved.mjs) are complementary: a command is moved by having a handler (and so by leaving the preamble list).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HANDLERS } from '../../control-plane/agents/scripts/core/commands/moved.mjs';
import { COMMAND_NAMES } from '../../control-plane/agents/scripts/core/commands/names.mjs';
import { agentSh, shellListed } from './helpers.mjs';

test('the preamble list of shell commands is every command that has no handler', () => {
  const listed = shellListed(agentSh);
  assert.equal(new Set(listed).size, listed.length, 'a name is listed twice');
  assert.deepEqual([...listed].sort(), COMMAND_NAMES.filter((c) => !Object.hasOwn(HANDLERS, c)).sort());
  for (const c of listed) assert.ok(COMMAND_NAMES.includes(c), c);
});
