// @ts-check
// The process-count budgets of the Node hook (issue #168): tests/bench/hook-budgets.tsv holds, per hook event, the most external processes one run may
// start on the fixture of tests/bench/hook-procs.mjs. The count comes from the PATH shim of that script (no clock is read), so the test is deterministic.
// It fails when an event starts more processes than its budget, and the checker itself is tested on a planted excess.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { measureAll, table } from '../bench/hook-procs.mjs';

const repo = resolve(import.meta.dirname, '../..');
const nodeHook = join(repo, 'adapters/claude/hooks/proofline-hook.mjs');
const EVENTS = ['pretool-write-impl', 'pretool-read', 'pretool-bash', 'posttool', 'prompt-plain', 'prompt-approval', 'stop', 'session', 'subagent-start', 'subagent-stop'];

/** @param {string} text @returns {{ event: string, max: number, measured: number }[]} */
export function parseBudgets(text) {
  return text.split('\n').filter((l) => l && !l.startsWith('#')).map((l, i) => {
    const f = l.split('\t');
    if (f.length !== 3 || !/^\d+$/.test(f[1]) || !/^\d+$/.test(f[2])) throw new Error(`hook-budgets.tsv row ${i + 1}: expected event<TAB>max<TAB>measured`);
    return { event: f[0], max: Number(f[1]), measured: Number(f[2]) };
  });
}
/** The events whose measured process count is over the budget. @param {Record<string, number>} counts @param {{ event: string, max: number }[]} rows */
export function overBudget(counts, rows) {
  return rows.filter((r) => counts[r.event] !== undefined && counts[r.event] > r.max).map((r) => `${r.event}: ${counts[r.event]} processes, budget ${r.max}`);
}
/** @param {string} out the table of hook-procs.mjs */
export function parseCounts(out) {
  /** @type {Record<string, number>} */ const c = {};
  for (const m of out.matchAll(/^(\S+)\s+execs=(\d+)\s/gm)) c[m[1]] = Number(m[2]);
  return c;
}
const budgets = parseBudgets(readFileSync(join(repo, 'tests/bench/hook-budgets.tsv'), 'utf8'));

test('the table covers every hook event once, and each row keeps a margin over its measurement', () => {
  assert.deepEqual(budgets.map((r) => r.event), EVENTS);
  for (const r of budgets) assert.ok(r.max >= r.measured + 2 || r.max >= Math.ceil(r.measured * 1.25), `${r.event}: no margin`);
});
test('overBudget fails on an excess and passes at the budget', () => {
  const t = [{ event: 'stop', max: 3 }];
  assert.deepEqual(overBudget({ stop: 3 }, t), []);
  assert.deepEqual(overBudget({ stop: 40 }, t), ['stop: 40 processes, budget 3']);
  assert.deepEqual(overBudget({}, t), []);
});
test('the benchmark table is what the Windows job summary and parseCounts read', () => {
  const t = table([{ event: 'stop', execs: 2, ms: 40, top: 'node=1 git=1' }, { event: 'session', execs: 1, ms: 90, top: 'node=1' }]);
  assert.deepEqual(parseCounts(t), { stop: 2, session: 1 });
  assert.match(t, /^slowest: session 90 ms \(runtime limit 30000\)$/m);
});
test('the Node hook stays inside its process budget on every event', { timeout: 600000 }, () => {
  const rows = measureAll({ hook: nodeHook, repeat: 1 });
  const counts = parseCounts(table(rows));
  assert.deepEqual(Object.keys(counts), EVENTS, `events measured: ${table(rows)}`);
  assert.deepEqual(overBudget(counts, budgets), []);
});
