// @ts-check
// A358 (issue 338 item B9; retro items R1-8, R2-3, R3-8, R4-13): `handoff IMPLEMENTED` runs the plan-listed Verification command ITSELF once and records the GREEN result and the per-test
// durations keyed by the plan's quoted test names. The implementer's own durations are a claim; the control plane's run is the evidence (Core invariant 4). Only a listed command that FAILS
// refuses; a command that exits 0 but ran none of the plan-named tests is not GREEN. The "test runner" is a fixed script (tests/core/evidence-repair-lib.mjs); no clock, no wait.
import assert from 'node:assert/strict';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ledgerAppend } from '../../control-plane/agents/scripts/core/lock.mjs';
import { testCmdPin } from '../../control-plane/agents/scripts/core/testmeasure.mjs';
import { A, accepted, must, project, refused, wclose, wev, wopen } from '../lib/harness.mjs';
import { PLAN, RUN, SCRIPT, ledger, setMode } from './evidence-repair-lib.mjs';

/**
 * A run with RED and an implementer GREEN that names only "slow one" (the state that used to be refused for "fast one"), not yet IMPLEMENTED.
 * @param {string} mode what the fixed runner does: ok | fail | nodur
 */
function ready(mode) {
  const b = project({ topology: 'orchestrated', cls: 'CRITICAL', planExtra: PLAN });
  ledgerAppend(path.join(b, '.agents/runs/LC'), 'lead', 'start', '-', 'PLANNED', 'task=tasks/LC.md adapter=markdown measure=1');
  ledgerAppend(path.join(b, '.agents/runs/LC'), 'lead', 'test-cmd-pin', '-', '-', `testcmd=${testCmdPin([])}`);
  writeFileSync(path.join(b, '.git/er-run.mjs'), SCRIPT);
  setMode(b, mode);
  const w = wopen(b);
  appendFileSync(path.join(b, 'impl_test.txt'), 'test: lookup returns the stored value\n');
  wev(b, 'RED', 'fail');
  appendFileSync(path.join(b, 'impl.txt'), 'impl: lookup returns the stored value\n');
  must(b, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: `command: ${RUN}\ntarget: impl.txt,impl_test.txt\ntest_durations: slow one=5.5\n` });
  wclose(b, w);
  return b;
}
const greens = (/** @type {string} */ d) => readdirSync(path.join(d, '.agents/runs/LC/worker-evidence')).filter((n) => n.startsWith('GREEN-')).sort().map((n) => readFileSync(path.join(d, '.agents/runs/LC/worker-evidence', n), 'utf8'));

test('B9: a plan test missing from the implementer GREEN no longer refuses IMPLEMENTED: the control plane runs the command and records both durations under the plan names', () => {
  const d = ready('ok');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED');
  const own = greens(d).filter((g) => /^role: "lead"/m.test(g));
  assert.equal(own.length, 1, 'one GREEN record made by the control plane');
  assert.match(own[0], /^command: node \.git\/er-run\.mjs$/m);
  assert.match(own[0], /^test_durations: slow one=5\.5; fast one=0\.75$/m);
  assert.match(ledger(d), /event=green-control .*tests=2\/2/);
});

test('B9: a plan-listed command that fails (a listed test fails) refuses IMPLEMENTED and records nothing', () => {
  const d = ready('fail');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a failing listed command', 'a listed test fails');
  assert.equal(greens(d).length, 1, 'the control plane recorded no GREEN for a failing run');
});

test('B9: a plan test whose duration the output never shows is not GREEN: it is not recorded and the old refusal stands', () => {
  const d = ready('nodur');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'no duration for a plan test', 'no recorded GREEN duration');
  assert.ok(!greens(d).some((g) => g.includes('fast one')), 'a duration was invented for a test the output does not show');
});
