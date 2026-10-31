// @ts-check
// Trace replay (ADR 0001 section 6, input 2), nightly: every scenario case of the moved commands is executed once on the shell with the PATH-shim
// recorder switched on; each agent.sh call it made is then replayed as a case of its own (snapshot of the project before the call, the recorded argv,
// stdin and environment seams) on both engines and compared. Heavy: EQUIVALENCE_FULL=1.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { movedCommandCases } from './cases/moved-commands.mjs';
import { formatDiffs, runCase, runSide } from './rig.mjs';
import { SKIP_HEAVY } from './scope.mjs';
import { installTraceShim, loadTrace, traceCase } from './trace.mjs';

describe('trace replay of the moved commands', { skip: SKIP_HEAVY }, () => {
  for (const c of movedCommandCases()) {
    test(`replay: ${c.name}`, { timeout: 900000 }, () => {
      const traceDir = mkdtempSync(join(tmpdir(), 'eq-replay.'));
      const { bin, env } = installTraceShim(traceDir);
      // record: the case runs on the shell with the shim on PATH; the shim records every agent.sh call and passes it on unchanged
      runSide({ ...c, steps: c.steps.map((s) => (s.write || s.exec ? s : { ...s, env: { ...(s.env ?? {}), ...env } })) }, { name: 'record', engineFor: () => 'sh' });
      const calls = loadTrace(traceDir);
      assert.equal(calls.length, c.steps.filter((s) => s.args).length, 'one trace entry per agent.sh call of the case');
      for (const call of calls) {
        const d = runCase(traceCase(traceDir, call));
        assert.equal(d.length, 0, `${call.argv.slice(1).join(' ')}:\n${formatDiffs(d)}`);
      }
      rmSync(traceDir, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true });
    });
  }
});
