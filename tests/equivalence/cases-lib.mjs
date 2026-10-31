// @ts-check
// Registers scenario cases as node:test tests; the slow commands (timeouts, hook-timeouts: seconds per call) sit in their own file so that
// `node --test` runs the two files in parallel processes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coreAbsent } from './fixture.mjs';
import { formatDiffs, runCase } from './rig.mjs';

export const isSlow = (/** @type {import('./rig.mjs').Case} */ c) => /^(timeouts|hook-timeouts):/.test(c.name);

export function registerCases(/** @type {import('./rig.mjs').Case[]} */ cases) {
  for (const c of cases) {
    test(`equivalent on both engines: ${c.name}${coreAbsent() ? ' (both sides run sh: no proofline-core.mjs yet)' : ''}`, () => {
      const d = runCase(c);
      assert.equal(d.length, 0, formatDiffs(d));
    });
  }
}
