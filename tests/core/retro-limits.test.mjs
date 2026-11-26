// @ts-check
// U8 review: `proofline retro` on very large inputs must not crash (a spread of a huge array into Math.min or Math.max throws RangeError) and must stay quick: one live ledger of 300000 rows
// (the file limit is 64 MiB) and 20000 runs in one report.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { sandbox } from './frontend-lib.mjs';

const sb = sandbox();
const T0 = 1760349600;
const row = (/** @type {number} */ i, /** @type {number} */ t, /** @type {string} */ ev) => `seq=${i} prev=- event=${ev} role=lead from=- to=- digest=- ts=2025-10-13T10:00:00Z epoch=${T0 + t} detail=x\n`;
/** @param {string} name */
function project(name) {
  const d = sb.mkrepo(name);
  mkdirSync(`${d}/.agents/scripts`, { recursive: true });
  writeFileSync(`${d}/.agents/config.yaml`, 'proofline_version: 0.0.192\n');
  writeFileSync(`${d}/.agents/scripts/agent.sh`, '#!/bin/sh\n');
  return d;
}

test('one live ledger of 300000 rows is reported', () => {
  const d = project('big');
  mkdirSync(`${d}/.agents/runs/BIG`, { recursive: true });
  const parts = [];
  for (let i = 1; i <= 300000; i++) parts.push(row(i, i % 7000, i === 1 ? 'start' : 'handoff:IMPLEMENTED'));
  writeFileSync(`${d}/.agents/runs/BIG/LEDGER.log`, parts.join(''));
  const r = sb.pl(d, ['retro', 'BIG']);
  assert.equal(r.status, 0, r.text.slice(0, 600));
  assert.match(r.out, /BIG \(open\)/);
  assert.match(r.out, /time: task 116\.7 min/);
});

test('20000 runs in one report', () => {
  const d = project('many');
  for (let i = 0; i < 20000; i++) { mkdirSync(`${d}/.agents/runs/R-${i}`, { recursive: true }); writeFileSync(`${d}/.agents/runs/R-${i}/LEDGER.log`, row(1, i, 'start') + row(2, i + 60, 'handoff:DONE')); }
  const r = sb.pl(d, ['retro']);
  assert.equal(r.status, 0, r.text.slice(0, 600));
  assert.match(r.out, /all runs \(20000 runs: 20000 with a ledger/);
  assert.match(r.out, /wall 334\.3 min/);
  assert.match(r.out, /more bytes: proofline retro --full/);
});
