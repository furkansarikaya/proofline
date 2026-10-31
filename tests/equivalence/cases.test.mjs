// @ts-check
// Every scenario case of the moved commands except the slow two, run once per engine (PROOFLINE_ENGINE=sh and the default) and compared by the rig.
// Until proofline-core.mjs exists both runs execute the 0.0.40 shell, so this proves the rig and the cases; afterwards it is the equivalence proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOVED, movedCommandCases } from './cases/moved-commands.mjs';
import { isSlow, registerCases } from './cases-lib.mjs';

const cases = movedCommandCases();
test('the scenario cases cover the ten moved commands', () => {
  const used = new Set(cases.flatMap((c) => c.steps.flatMap((s) => (s.args && s.args[0] ? [s.args[0]] : []))));
  for (const m of MOVED) assert.ok(used.has(m), `no scenario case calls ${m}`);
  assert.equal(MOVED.length, 10);
});
registerCases(cases.filter((c) => !isSlow(c)));
