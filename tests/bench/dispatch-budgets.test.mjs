// @ts-check
// The process budgets of the execution decision and the dispatcher (A226, issue #172): tests/bench/dispatch-budgets.tsv holds, per path, the most external
// processes one run may start on the fixture of tests/bench/dispatch-procs.mjs (the PATH shim counts them, no clock is read). The test fails when a path starts
// more processes than its row allows; the checker itself is tested on a planted excess.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { measureAll, table } from './dispatch-procs.mjs';

const repo = resolve(import.meta.dirname, '../..');
const PATHS = ['decide-dry', 'dispatch-implementer-codex', 'dispatch-reviewer-claude'];

/** @param {string} text @returns {{ path: string, maxProcs: number, measured: number, before: number }[]} */
export function parseBudgets(text) {
  return text.split('\n').filter((l) => l && !l.startsWith('#')).map((l, i) => {
    const f = l.split('\t');
    if (f.length !== 4 || !/^\d+$/.test(f[1]) || !/^\d+$/.test(f[2]) || !/^\d+$/.test(f[3])) throw new Error(`dispatch-budgets.tsv row ${i + 1}: expected path<TAB>max_procs<TAB>measured<TAB>before`);
    return { path: f[0], maxProcs: Number(f[1]), measured: Number(f[2]), before: Number(f[3]) };
  });
}
/** The paths over their row. @param {Record<string, { procs: number }>} got @param {ReturnType<typeof parseBudgets>} rows */
export function overBudget(got, rows) {
  /** @type {string[]} */ const out = [];
  for (const r of rows) {
    const g = got[r.path];
    if (g && g.procs > r.maxProcs) out.push(`${r.path}: ${g.procs} processes, budget ${r.maxProcs}`);
  }
  return out;
}
const rows = parseBudgets(readFileSync(join(repo, 'tests/bench/dispatch-budgets.tsv'), 'utf8'));

test('the table covers every path once, each row keeps a margin over its measurement and stays far below the shell form', () => {
  assert.deepEqual(rows.map((r) => r.path), PATHS);
  for (const r of rows) {
    assert.ok(r.maxProcs >= r.measured + 2 || r.maxProcs >= Math.ceil(r.measured * 1.25), `${r.path}: no margin`);
    assert.ok(r.maxProcs * 10 < r.before, `${r.path}: the budget is not far below the shell form`);
  }
});
test('the targets of issue #172: the dispatcher\'s own overhead is at most 10 processes; the decision as a command is the launcher, node and the two git calls that list the changed paths (4, not the 123 of the shell)', () => {
  const by = Object.fromEntries(rows.map((r) => [r.path, r]));
  assert.ok(by['decide-dry'].measured <= 4);
  assert.ok(by['dispatch-implementer-codex'].measured <= 10);
});
test('overBudget fails on an excess of processes and passes at the budget', () => {
  const t = parseBudgets('x\t5\t3\t60\ny\t4\t2\t9\n');
  assert.deepEqual(overBudget({ x: { procs: 5 }, y: { procs: 4 } }, t), []);
  assert.deepEqual(overBudget({ x: { procs: 40 } }, t), ['x: 40 processes, budget 5']);
  assert.deepEqual(overBudget({}, t), []);
});
test('every path stays inside its budget (the fixture of dispatch-procs.mjs)', { timeout: 900000 }, () => {
  const measured = measureAll({ repeat: 1 });
  /** @type {Record<string, { procs: number }>} */ const got = {};
  for (const m of measured) got[m.path] = { procs: m.procs };
  assert.deepEqual(Object.keys(got), PATHS, `paths measured: ${table(measured)}`);
  assert.deepEqual(overBudget(got, rows), [], table(measured));
});
