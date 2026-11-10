// @ts-check
// identity-test.sh sc_qa_plan_submit (A172, 176-D3) as a Node test: the real bug, a QA plan step submit produced the finding id QA-1 and `record` demanded
// qa-<n>. The other identity scenarios (sc_id_identity, sc_language_*) are the absolute Node tests legacy-identity.test.mjs and legacy-language.test.mjs
// (tests/legacy-port-map.tsv).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AS, accepted, scaffold, tmp, useLiveCore } from '../lib/harness.mjs';
useLiveCore();

test('sc_qa_plan_submit: a QA plan step with rows is recorded (no "invalid finding id QA-1 (want qa-<n>)")', () => {
  const d = scaffold({ topology: 'orchestrated' });
  const rows = path.join(tmp('r'), 'r.rows');
  writeFileSync(rows, 'info|impl.txt:1|a note about the lookup|seen in the plan\n');
  const r = AS(d, 'qa', ['submit', 'LC', '--result', 'DONE', '--confidence', 'high', '--findings', rows, '--agent', 'qa1']);
  accepted(r, 'qa plan step submit with rows was rejected');
  assert.ok(!r.text.includes('invalid finding'), `invalid finding id: ${r.text}`);
});
