// @ts-check
// The process and output budgets of the execution-policy, runtime-detection and known-issue paths (A222, issue #172): tests/bench/exec-budgets.tsv holds, per
// path, the most external processes one run may start on the fixture of tests/bench/exec-procs.mjs (the PATH shim counts them, no clock is read) and the
// most stdout bytes it may print. The test fails when a path starts more processes or prints more bytes than its row allows; the checker itself is tested
// on a planted excess.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { measureAll, table } from './exec-procs.mjs';

const repo = resolve(import.meta.dirname, '../..');
const PATHS = ['decide-dry', 'exec-policy-resolve', 'runtime-detect-has', 'runtime-detect-list', 'known-issue-propose', 'known-issue-approve', 'known-issue-apply', 'known-issue-list', 'known-issue-candidates'];

/** @param {string} text @returns {{ path: string, maxProcs: number, measured: number, before: number, maxBytes: number | null }[]} */
export function parseBudgets(text) {
  return text.split('\n').filter((l) => l && !l.startsWith('#')).map((l, i) => {
    const f = l.split('\t');
    if (f.length !== 5 || !/^\d+$/.test(f[1]) || !/^\d+$/.test(f[2]) || !/^\d+$/.test(f[3]) || !/^(\d+|-)$/.test(f[4])) throw new Error(`exec-budgets.tsv row ${i + 1}: expected path<TAB>max_procs<TAB>measured<TAB>before<TAB>max_bytes`);
    return { path: f[0], maxProcs: Number(f[1]), measured: Number(f[2]), before: Number(f[3]), maxBytes: f[4] === '-' ? null : Number(f[4]) };
  });
}
/** The paths over their row. @param {Record<string, { procs: number, bytes: number }>} got @param {ReturnType<typeof parseBudgets>} rows */
export function overBudget(got, rows) {
  /** @type {string[]} */ const out = [];
  for (const r of rows) {
    const g = got[r.path];
    if (!g) continue;
    if (g.procs > r.maxProcs) out.push(`${r.path}: ${g.procs} processes, budget ${r.maxProcs}`);
    if (r.maxBytes !== null && g.bytes > r.maxBytes) out.push(`${r.path}: ${g.bytes} bytes, budget ${r.maxBytes}`);
  }
  return out;
}
const rows = parseBudgets(readFileSync(join(repo, 'tests/bench/exec-budgets.tsv'), 'utf8'));

test('the table covers every path once, and each row keeps a margin over its measurement', () => {
  assert.deepEqual(rows.map((r) => r.path), PATHS);
  for (const r of rows) {
    assert.ok(r.maxProcs >= r.measured + 2 || r.maxProcs >= Math.ceil(r.measured * 1.25) || (r.path === 'decide-dry' && r.maxProcs >= Math.ceil(r.measured * 1.1)), `${r.path}: no margin`);
    // the known-issue commands that were shell code are the point of the package: far fewer processes than their shell form
    if (['known-issue-propose', 'known-issue-apply', 'known-issue-list', 'known-issue-candidates'].includes(r.path)) assert.ok(r.maxProcs * 4 < r.before, `${r.path}: the budget is not far below the shell form`);
  }
});
test('overBudget fails on an excess of processes or bytes and passes at the budget', () => {
  const t = parseBudgets('x\t5\t3\t60\t96\ny\t4\t2\t9\t-\n');
  assert.deepEqual(overBudget({ x: { procs: 5, bytes: 96 }, y: { procs: 4, bytes: 99999 } }, t), []);
  assert.deepEqual(overBudget({ x: { procs: 40, bytes: 97 } }, t), ['x: 40 processes, budget 5', 'x: 97 bytes, budget 96']);
  assert.deepEqual(overBudget({}, t), []);
});
test('every path stays inside its budget (the fixture of exec-procs.mjs)', { timeout: 900000 }, () => {
  const measured = measureAll({ repeat: 1 });
  /** @type {Record<string, { procs: number, bytes: number }>} */ const got = {};
  for (const m of measured) got[m.path] = { procs: m.procs, bytes: m.bytes };
  assert.deepEqual(Object.keys(got), PATHS, `paths measured: ${table(measured)}`);
  assert.deepEqual(overBudget(got, rows), [], table(measured));
});
