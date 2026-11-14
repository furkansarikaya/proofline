// @ts-check
// Issue 265 package A (A273, AC-2): the GREEN evidence of `worker-evidence` records the duration of each new test. The value is
// supplied from the GREEN run's own output; the recorder checks its shape and writes it, a later package applies budgets to it.
// No test waits or reads the clock: the durations are fixed strings.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, accepted, project, refused, wclose, wev, wopen } from '../lib/harness.mjs';

const BASE = 'command: go test ./...\ntarget: impl.txt,impl_test.txt\n';
/** A project whose RED is recorded and whose implementation changed since, so the next GREEN is accepted. @returns {{ d: string, w: string }} */
function redThenFix() {
  const d = project({ topology: 'orchestrated' });
  const w = wopen(d);
  appendFileSync(path.join(d, 'impl_test.txt'), 'test: lookup returns the stored value\n');
  wev(d, 'RED', 'fail');
  appendFileSync(path.join(d, 'impl.txt'), 'impl: lookup returns the stored value\n');
  return { d, w };
}
/** @param {string} d @param {string} phase */
const record = (d, phase) => {
  const dir = path.join(d, '.agents/runs/LC/worker-evidence');
  const f = readdirSync(dir).filter((n) => n.startsWith(`${phase}-`)).sort().at(-1) ?? '';
  return readFileSync(path.join(dir, f), 'utf8');
};

test('GREEN with test_durations: the durations are written into the GREEN record', () => {
  const { d, w } = redThenFix();
  accepted(A(d, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: `${BASE}test_durations: lookup returns the stored value=0.42; empty key falls back=12\n` }), 'GREEN with durations');
  wclose(d, w);
  assert.match(record(d, 'GREEN'), /^test_durations: lookup returns the stored value=0\.42; empty key falls back=12$/m);
});

test('GREEN with a malformed test_durations is refused: a word, a negative number and a missing name are not durations', () => {
  for (const bad of ['lookup=-3', '=5', 'lookup=1; ']) {
    const { d, w } = redThenFix();
    refused(A(d, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: `${BASE}test_durations: ${bad}\n` }), `test_durations "${bad}"`, 'test_durations');
    wclose(d, w);
  }
});

test('GREEN without test_durations is still accepted in this package (the field is defined now, a later package requires it)', () => {
  const { d, w } = redThenFix();
  accepted(A(d, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: `${BASE}\n` }), 'GREEN without durations');
  wclose(d, w);
  assert.doesNotMatch(record(d, 'GREEN'), /test_durations/);
});

test('test_durations on RED is refused: only a passing run has a test duration to report', () => {
  const d = project({ topology: 'orchestrated' });
  const w = wopen(d);
  appendFileSync(path.join(d, 'impl_test.txt'), 'test: lookup returns the stored value\n');
  refused(A(d, ['worker-evidence', 'LC', 'RED', 'fail'], { role: 'implementer', input: `${BASE}expected_failure: TestImpl fails: lookup is not implemented in impl.txt yet\ntest_durations: lookup=1\n` }), 'RED with durations', 'test_durations');
  wclose(d, w);
});

test('a test_durations line over 4096 characters is refused', () => {
  const { d, w } = redThenFix();
  refused(A(d, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: `${BASE}test_durations: ${'a'.repeat(4100)}=1\n` }), 'a 4100 character line', 'longer than 4096');
  wclose(d, w);
});
