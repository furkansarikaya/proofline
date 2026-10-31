// @ts-check
// Registers scenario cases as node:test tests; the slow commands (timeouts, hook-timeouts: seconds per call) sit in their own file so that
// `node --test` runs the two files in parallel processes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coreAbsent } from './fixture.mjs';
import { formatDiffs, runCase } from './rig.mjs';
import { FULL, SKIP_HEAVY, touchedCommands } from './scope.mjs';

export const isSlow = (/** @type {import('./rig.mjs').Case} */ c) => /^(timeouts|hook-timeouts):/.test(c.name);

/** The cases that call a touched command (all of them under EQUIVALENCE_FULL=1). */
export const touches = (/** @type {import('./rig.mjs').Case} */ c, /** @type {string[]} */ cmds) => FULL || c.steps.some((s) => s.args && s.args[0] && cmds.includes(s.args[0]));

export function registerCases(/** @type {import('./rig.mjs').Case[]} */ cases, /** @type {{ heavy?: boolean }} */ o = {}) {
  const cmds = touchedCommands();
  for (const c of cases) {
    const skip = o.heavy ? SKIP_HEAVY : touches(c, cmds) ? false : `not touched by this change (touched: ${cmds.join(',') || 'none'})`;
    test(`equivalent on both engines: ${c.name}${coreAbsent() ? ' (both sides run sh: no proofline-core.mjs yet)' : ''}`, { skip }, () => {
      const d = runCase(c);
      assert.equal(d.length, 0, formatDiffs(d));
    });
  }
}
