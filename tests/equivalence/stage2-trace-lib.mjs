// @ts-check
// Trace cases of the Stage 2 commands (ADR 0001 section 6, input 2): each scenario case runs once on the shell with the PATH-shim recorder on, and
// every agent.sh call it made is replayed as a case of its own (the project as it was before the call, the recorded argv, stdin and seams) on both
// engines. A pull request replays the cases of the touched commands, the nightly EQUIVALENCE_FULL run all of them.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { stage2Cases } from './cases/stage2-commands.mjs';
import { touches } from './cases-lib.mjs';
import { formatDiffs, runCase, runSide } from './rig.mjs';
import { touchedCommands } from './scope.mjs';
import { installTraceShim, loadTrace, traceCase } from './trace.mjs';

/** Register the trace replay of the Stage 2 cases on the given fixture states (one test file per bucket, run in parallel). */
export function registerTraceCases(/** @type {string[]} */ states) {
  const cmds = touchedCommands();
  describe(`trace replay of the stage 2 commands on ${states.join(', ')}`, () => {
    for (const c of stage2Cases(states)) {
      const skip = touches(c, cmds) ? false : `not touched by this change (touched: ${cmds.join(',') || 'none'})`;
      test(`replay: ${c.name}`, { skip, timeout: 900000 }, () => {
        const traceDir = mkdtempSync(join(tmpdir(), 'eq-replay2.'));
        const { bin, env } = installTraceShim(traceDir);
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
}
