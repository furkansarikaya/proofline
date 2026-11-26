// @ts-check
// C2 rest (issue 338, A362): the `contract` review focus is required only when a recognised contract file is in the task-owned diff
// (or the plan declares `contract_change: yes`); a planned-only path (plan scope) does not add it. The decision is the control plane's.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { warmDefaultTemplate } from '../lib/harness.mjs';
import { has, hasnt, rrun, snap, wr } from './risk-s1-lib.mjs';

before(() => { warmDefaultTemplate(); });

test('c2_contract_focus: a contract path only in the plan scope adds no focus; the diff adds it and a flag keeps it', () => {
  const d = rrun('CRITICAL', 'api/openapi.yaml');
  // before the diff: the signal is visible (the design role still sees it) but the focus is not required
  let po = snap(d);
  has(po, 'signal.contract_file=source=scope:api/openapi.yaml');
  hasnt(po, 'focus.REVIEW_RULES.contract');
  hasnt(po, 'focus.REVIEW_SMALL.contract');
  // the plan declares the change: required whether or not the diff shows it
  const f = rrun('CRITICAL', 'api/openapi.yaml', '\n## Risk\n\ncontract_change: yes');
  po = snap(f);
  has(po, 'focus.REVIEW_RULES.contract=missing');
  // the file appears in the diff: the focus is required (re-evaluated, not frozen at plan time)
  const h = rrun('CRITICAL', 'api/openapi.yaml');
  wr(h, 'api/openapi.yaml', 'openapi: 3.0.0\n');
  assert.match(snap(h), /focus\.REVIEW_RULES\.contract=missing/, 'a contract file in the diff requires the focus');
});

test('c2_contract_focus_none: planned scope without a diff requires no contract focus at CRITICAL either', () => {
  const d = rrun('CRITICAL', 'api/openapi.yaml');
  const po = snap(d);
  hasnt(po, 'focus.REVIEW_RULES.contract');
  has(po, 'signal.contract_file=source=scope:api/openapi.yaml');
});
