// @ts-check
// Stage 3 scenario cases: each runs once per engine and the rig compares stdout, stderr, exit codes, files and modes. The approval log and the
// hook timing log hold times of their own, so the comparison also masks the time fields of PENDING_APPROVAL (normalise.mjs; the maintainer's
// call whether they join the closed list), exactly as the alternating-engine lifecycle test does.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { touches } from './cases-lib.mjs';
import { stage3Cases } from './cases/stage3-commands.mjs';
import { coreAbsent } from './fixture.mjs';
import { DEFAULT_SIDE, SH_SIDE, compareSides, formatDiffs, runSide } from './rig.mjs';
import { touchedCommands } from './scope.mjs';

const cmds = touchedCommands();
for (const c of stage3Cases()) {
  test(`equivalent on both engines: ${c.name}`, { skip: touches(c, cmds) ? false : 'not touched by this change' }, () => {
    const work = mkdtempSync(join(tmpdir(), 'eq-work.'));
    try {
      assert.ok(!coreAbsent());
      const a = runSide(c, SH_SIDE, { work }); const b = runSide(c, DEFAULT_SIDE, { work });
      const d = compareSides(a, b, ['sh', 'default'], { pendingApproval: true });
      assert.equal(d.length, 0, formatDiffs(d));
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
}
