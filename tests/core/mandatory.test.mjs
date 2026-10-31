// @ts-check
// The preamble's table of mandatory arguments (pl_need2, pl_need3) covers every `${N:?usage` of the shell dispatch for a moved command: a
// moved command called without one runs in the shell, which prints its own usage text with its own $0.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HANDLERS } from '../../control-plane/agents/scripts/core/commands/moved.mjs';
import { agentSh } from './helpers.mjs';

/** @param {string} name */
const table = (name) => (new RegExp(`${name}='([^']*)'`).exec(agentSh)?.[1] ?? '').split(' ').filter(Boolean);

test('every ${N:?usage} of the dispatch of a moved command is in the preamble table', () => {
  const dispatch = agentSh.slice(agentSh.indexOf('\ncase "$command" in\n  role)'));
  /** @type {Record<number, Set<string>>} */ const need = { 2: new Set(), 3: new Set() };
  for (const m of dispatch.matchAll(/^  ([a-z][a-z0-9|-]*)\)(.*)$/gm)) {
    for (const name of m[1].split('|')) {
      if (!Object.hasOwn(HANDLERS, name)) continue;
      for (const n of [2, 3]) if (m[2].includes(`\${${n}:?usage`)) need[n].add(name);
    }
  }
  assert.deepEqual(table('pl_need2').sort(), [...need[2]].sort());
  assert.deepEqual(table('pl_need3').sort(), [...need[3]].sort());
});
