// @ts-check
// C7 (issue 338, A362): finding ids are unique per gate across its focuses (the numbers of another focus are skipped, a collision is refused), and a report
// file that is byte-identical to the artifact of an earlier record of another gate or focus (a stale file another role left under a shared name) is refused.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, test } from 'node:test';
import { AS, rec, warmDefaultTemplate } from '../lib/harness.mjs';
import { RUN, frozen, implement, lastGate, rrun, wr } from './risk-s1-lib.mjs';

before(() => { warmDefaultTemplate(); });

test('c7_ids_and_stale: ids of another focus of the gate are never reused; the same bytes under the rules report path are refused as stale', () => {
  const d = rrun('COMPLEX', 'api/openapi.yaml'); frozen(d); implement(d, 'api/openapi.yaml', 'openapi: 3.0.0');
  const body = '# contract\n\nNo breaking change found.\n';
  const sub = AS(d, 'reviewer', ['submit', 'LC', '--focus', 'contract', '--confidence', 'high', '--artifact', 'reviews/contract-proof/REPORT.md', '--report', '-'], { input: body });
  assert.equal(sub.status, 0, `submit failed: ${sub.text}`);
  const recText = readFileSync(lastGate(d, 'REVIEW_RULES'), 'utf8');
  assert.match(recText, /^finding: REVIEW_RULES-1\|blocking\|api\/openapi\.yaml\|risk signal contract_file/m, recText);
  // another focus of the same gate cannot take the id: a record that repeats it is refused, the next free number is accepted
  const row = (/** @type {number} */ n) => `REVIEW_RULES-${n}|blocking|impl.txt:1|lookup returns the wrong value for an empty key|traced: empty key -> nil; scan: grep -n lookup impl.txt; instances: single`;
  assert.throws(() => rec(d, 'REVIEW_RULES', 'FAIL', [row(1)]), /finding id REVIEW_RULES-1 is already used by 001-REVIEW_RULES\.yaml \(another focus of REVIEW_RULES\)/);
  rec(d, 'REVIEW_RULES', 'FAIL', [row(2)]);
  // the stale file: another focus's report left under the rules report name, then handed over without writing a report of its own
  wr(d, `${RUN}/reviews/proof-review/rules/REPORT.md`, body);
  const stale = AS(d, 'reviewer', ['submit', 'LC', '--focus', 'rules', '--confidence', 'high', '--artifact', 'reviews/proof-review/rules/REPORT.md']);
  assert.notEqual(stale.status, 0, 'a stale report was accepted');
  assert.match(stale.text, /stale: .* is byte-identical to the report of the earlier REVIEW_RULES focus contract record/, stale.text);
});
